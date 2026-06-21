# Chat Intel (SP4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Read-only intelligence over the agent account's already-joined group chats: a per-chat allow-list, a cheap pre-filter, AI classification of candidate messages into an `agent_opportunities` feed (ad offers / ВП requests / pricing), surfaced on `/app/agent`. No joining, no sending; off by default.

**Architecture:** Extends `apps/automation/src/agent/`. Adds two READ methods to the SP1 read-only `AgentMtprotoClient` (`listGroups`, `fetchChatMessages`), pure helpers (`isOpportunityCandidate`, `buildOpportunityPrompt`, `parseOpportunity`), two repos, an `AgentChatClassifier`, a gated `AgentChatPoller`, controller routes, and a dashboard "Chat intel" section.

**Tech Stack:** NestJS, `pg`, GramJS (`telegram`), React + TanStack. Tests: `node:test` + `tsx` from `apps/automation` (`npm test`). **No live network/AI in tests.** Do not push.

**Invariants:** `sendMessage`/`sendFile` stay ONLY in `agent-reply-sender.service.ts`. NO join method anywhere (`joinChannel`/`ImportChatInvite` must never appear in `src/agent/`). Off by default (`AGENT_CHAT_ENABLED`). Pre-filter MUST run before any Claude call.

**Shared types (add to `apps/automation/src/agent/agent.types.ts`):**
```ts
export type OpportunityKind = 'ad_offer' | 'vp_request' | 'pricing' | 'other';
export type SuggestedAction = 'advertise' | 'do_vp' | 'skip';
export interface Opportunity { kind: OpportunityKind; summary: string; score: number; suggestedAction: SuggestedAction }
export interface ChatMessage { messageId: number; text: string; date: Date }
export interface JoinedGroup { chatId: string; title: string }
export interface MonitoredChatRow { chat_id: string; title: string | null; enabled: boolean; last_message_id: string; last_polled_at: Date | null; created_at: Date; updated_at: Date }
export interface OpportunityRow {
  id: string; chat_id: string; chat_title: string | null; message_id: string; message_text: string | null;
  kind: OpportunityKind; summary: string | null; score: number; suggested_action: SuggestedAction;
  status: 'new' | 'reviewed' | 'archived'; created_at: Date;
}
```

---

### Task 1: Migration — agent_monitored_chats + agent_opportunities

**Files:** Create `database/migrations/041_agent_chat_intel.sql`

- [ ] **Step 1: Write the migration**
```sql
CREATE TABLE IF NOT EXISTS agent_monitored_chats (
  chat_id          TEXT PRIMARY KEY,
  title            TEXT,
  enabled          BOOLEAN NOT NULL DEFAULT false,
  last_message_id  BIGINT NOT NULL DEFAULT 0,
  last_polled_at   TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_opportunities (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id          TEXT NOT NULL,
  chat_title       TEXT,
  message_id       BIGINT NOT NULL,
  message_text     TEXT,
  kind             TEXT NOT NULL DEFAULT 'other'
                     CHECK (kind IN ('ad_offer','vp_request','pricing','other')),
  summary          TEXT,
  score            INT NOT NULL DEFAULT 0,
  suggested_action TEXT NOT NULL DEFAULT 'skip'
                     CHECK (suggested_action IN ('advertise','do_vp','skip')),
  status           TEXT NOT NULL DEFAULT 'new'
                     CHECK (status IN ('new','reviewed','archived')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_opps_status ON agent_opportunities (status, score DESC, created_at DESC);
```
- [ ] **Step 2: Commit** `feat(agent): chat-intel tables (monitored_chats + opportunities)` (+ trailer)

---

### Task 2: Pure helpers (pre-filter + classify prompt/parse)

**Files:** add types to `agent.types.ts`; create `apps/automation/src/agent/chat-intel.helpers.ts` + `...test.ts`

- [ ] **Step 1: Write the failing test**
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOpportunityCandidate, buildOpportunityPrompt, parseOpportunity } from './chat-intel.helpers';

test('isOpportunityCandidate true for ad/vp/price texts', () => {
  assert.equal(isOpportunityCandidate('Шукаю рекламу у вашому каналі'), true);
  assert.equal(isOpportunityCandidate('Пропоную ВП (взаємний піар)'), true);
  assert.equal(isOpportunityCandidate('Прайс: 500 грн за пост'), true);
  assert.equal(isOpportunityCandidate('розміщення від 1000₴'), true);
});
test('isOpportunityCandidate false for ordinary chatter', () => {
  assert.equal(isOpportunityCandidate('Привіт, як справи?'), false);
  assert.equal(isOpportunityCandidate('Дякую за допомогу!'), false);
});
test('buildOpportunityPrompt asks for JSON + lists kinds', () => {
  const { system, user } = buildOpportunityPrompt('Шукаю рекламу 500 грн');
  assert.match(system, /JSON/);
  assert.match(system, /ad_offer.*vp_request.*pricing.*other/s);
  assert.match(user, /500 грн/);
});
test('parseOpportunity valid / garbage / clamp / unknown', () => {
  const ok = parseOpportunity('{"kind":"ad_offer","summary":"s","score":80,"suggestedAction":"advertise"}');
  assert.equal(ok.kind, 'ad_offer'); assert.equal(ok.suggestedAction, 'advertise');
  const bad = parseOpportunity('not json');
  assert.equal(bad.kind, 'other'); assert.equal(bad.score, 0); assert.equal(bad.suggestedAction, 'skip');
  const clamp = parseOpportunity('{"kind":"weird","score":999,"suggestedAction":"nope"}');
  assert.equal(clamp.kind, 'other'); assert.equal(clamp.score, 100); assert.equal(clamp.suggestedAction, 'skip');
});
```
- [ ] **Step 2: Run → FAIL.** `cd apps/automation && npx tsx --test "src/agent/chat-intel.helpers.test.ts"`
- [ ] **Step 3: Implement**
```ts
import type { Opportunity, OpportunityKind, SuggestedAction } from './agent.types';

const KINDS: OpportunityKind[] = ['ad_offer', 'vp_request', 'pricing', 'other'];
const ACTIONS: SuggestedAction[] = ['advertise', 'do_vp', 'skip'];
// Cheap heuristic so most chatter never reaches the model.
const KEYWORDS = ['реклам', 'вп', 'взаємн', 'взаимн', 'прайс', 'розміщенн', 'размещен', 'бартер', 'співпрац', 'сотруднич', 'ad', 'promo'];
const PRICE_RE = /\d+\s?(грн|uah|₴|\$|usd)/i;

export function isOpportunityCandidate(text: string): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  if (PRICE_RE.test(t)) return true;
  return KEYWORDS.some(k => t.includes(k));
}

export function buildOpportunityPrompt(text: string): { system: string; user: string } {
  const system = [
    'You analyze a message from a Telegram group the owner of a media network is in.',
    'Decide if it is a monetization/collaboration opportunity and reply ONLY with one JSON object, no prose, no code fence.',
    'Schema: {"kind":"ad_offer|vp_request|pricing|other","summary":string(Ukrainian,<=200),',
    '"score":integer 0-100 (business value),"suggestedAction":"advertise|do_vp|skip"}.',
    'kind: ad_offer = someone offers/wants to buy ad placement; vp_request = mutual promotion (ВП);',
    'pricing = a price list / rate post; other = anything else.',
  ].join('\n');
  return { system, user: `Message:\n"""\n${text}\n"""` };
}

export function parseOpportunity(raw: string): Opportunity {
  const fb: Opportunity = { kind: 'other', summary: '', score: 0, suggestedAction: 'skip' };
  if (!raw) return fb;
  const stripped = raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  let o: any;
  try { o = JSON.parse(stripped); } catch { return fb; }
  if (!o || typeof o !== 'object') return fb;
  const kind: OpportunityKind = KINDS.includes(o.kind) ? o.kind : 'other';
  const suggestedAction: SuggestedAction = ACTIONS.includes(o.suggestedAction) ? o.suggestedAction : 'skip';
  const rawScore = Number(o.score);
  const score = Number.isFinite(rawScore) ? Math.max(0, Math.min(100, Math.round(rawScore))) : 0;
  return { kind, summary: typeof o.summary === 'string' ? o.summary.slice(0, 400) : '', score, suggestedAction };
}
```
- [ ] **Step 4: Run → PASS (4). Step 5: Commit** `feat(agent): chat-intel pure helpers (pre-filter + classify prompt/parse)`

---

### Task 3: Extend AgentMtprotoClient (read-only: listGroups + fetchChatMessages)

**Files:** Modify `apps/automation/src/agent/agent-mtproto.client.ts` (build-only; no unit test — network wrapper)

- [ ] **Step 1: Read** the existing `agent-mtproto.client.ts` and `apps/automation/src/tracking/mtproto/tracking-mtproto.client.ts` (for the `Api.messages.GetHistory` pattern).
- [ ] **Step 2: Add two READ methods** (NO send; NO join). Inside the class:
```ts
import { Api } from 'telegram'; // ensure imported

/** Joined GROUP/megagroup dialogs (for the monitoring allow-list). No DMs. No join. */
async listGroups(limit = 100): Promise<import('./agent.types').JoinedGroup[]> {
  const active = await this.sessions.activeSession(this.secrets, 'agent');
  if (!active) return [];
  const { client, ok } = await this.connect(active);
  if (!ok || !client) return [];
  try {
    const dialogs = await withTimeout(client.getDialogs({ limit }), 15_000, 'agent listGroups');
    const out: import('./agent.types').JoinedGroup[] = [];
    for (const d of dialogs as any[]) {
      if (!(d.isGroup || d.isChannel) || d.isUser) continue;
      const ent: any = d.entity;
      out.push({ chatId: String(ent?.id ?? d.id), title: d.title ?? ent?.title ?? String(d.id) });
    }
    return out;
  } catch (err: any) { this.logFloodOr(err, 'listGroups'); return []; }
  finally { try { await client.disconnect(); } catch { /* ignore */ } }
}

/** New messages in a chat since minId (read-only). */
async fetchChatMessages(chatId: string, minId: number, limit = 50): Promise<import('./agent.types').ChatMessage[]> {
  const active = await this.sessions.activeSession(this.secrets, 'agent');
  if (!active) return [];
  const { client, ok } = await this.connect(active);
  if (!ok || !client) return [];
  try {
    const entity = await client.getEntity(chatId);
    const res: any = await withTimeout(
      client.invoke(new Api.messages.GetHistory({ peer: entity as any, limit, minId, offsetId: 0 })),
      15_000, 'agent fetchChatMessages',
    );
    const msgs: any[] = res?.messages ?? [];
    return msgs
      .filter(m => m && m.id && typeof m.message === 'string')
      .map(m => ({ messageId: Number(m.id), text: String(m.message), date: m.date ? new Date(m.date * 1000) : new Date() }));
  } catch (err: any) { this.logFloodOr(err, 'fetchChatMessages'); return []; }
  finally { try { await client.disconnect(); } catch { /* ignore */ } }
}
```
NOTE: this assumes a small private `connect(active)` helper and `logFloodOr(err,label)` exist. If `agent-mtproto.client.ts` does NOT already factor those out (SP1 inlined connect in `fetchRecentDialogs`), either (a) refactor the shared connect/flood handling into private helpers and reuse in all three methods, or (b) inline the same connect/try/catch/disconnect pattern used by `fetchRecentDialogs`. Keep it READ-ONLY and consistent. Confirm by reading the file first.
- [ ] **Step 3: Build** (`cd apps/automation && npm run build`) clean. Verify no send/join added: `grep -rni "sendMessage\|sendFile\|joinChannel\|ImportChatInvite" apps/automation/src/agent/agent-mtproto.client.ts` → nothing.
- [ ] **Step 4: Commit** `feat(agent): read-only listGroups + fetchChatMessages on AgentMtprotoClient`

---

### Task 4: Repositories (monitored chats + opportunities)

**Files:** Create `agent-monitored-chats.repository.ts` + `...test.ts`, `agent-opportunities.repository.ts` + `...test.ts`

- [ ] **Step 1: Write the failing tests**
```ts
// agent-monitored-chats.repository.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentMonitoredChatsRepository } from './agent-monitored-chats.repository';
function fakePool() { const calls: any[] = []; let rows: any[] = [];
  return { calls, setRows: (r: any[]) => { rows = r; }, pool: { query: async (sql: string, params: any[]) => { calls.push({ sql, params }); return { rows, rowCount: rows.length }; } } as any }; }

test('upsert inserts chat_id/title on conflict updates title', async () => {
  const { pool, calls } = fakePool(); const repo = new AgentMonitoredChatsRepository(pool);
  await repo.upsert('c1', 'Chat One');
  assert.match(calls[0].sql, /INSERT INTO agent_monitored_chats/);
  assert.match(calls[0].sql, /ON CONFLICT \(chat_id\) DO UPDATE/);
  assert.deepEqual(calls[0].params, ['c1', 'Chat One']);
});
test('setEnabled updates enabled', async () => {
  const { pool, calls } = fakePool(); const repo = new AgentMonitoredChatsRepository(pool);
  await repo.setEnabled('c1', true);
  assert.match(calls[0].sql, /SET enabled = \$2/); assert.deepEqual(calls[0].params, ['c1', true]);
});
test('enabled() selects only enabled chats', async () => {
  const { pool, calls } = fakePool(); const repo = new AgentMonitoredChatsRepository(pool);
  await repo.enabled();
  assert.match(calls[0].sql, /WHERE enabled/);
});
test('setLastMessageId advances cursor', async () => {
  const { pool, calls } = fakePool(); const repo = new AgentMonitoredChatsRepository(pool);
  await repo.setLastMessageId('c1', 42);
  assert.match(calls[0].sql, /SET last_message_id = \$2/); assert.match(calls[0].sql, /last_polled_at = now\(\)/);
  assert.deepEqual(calls[0].params, ['c1', 42]);
});
```
```ts
// agent-opportunities.repository.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentOpportunitiesRepository } from './agent-opportunities.repository';
function fakePool() { const calls: any[] = []; let rows: any[] = [];
  return { calls, setRows: (r: any[]) => { rows = r; }, pool: { query: async (sql: string, params: any[]) => { calls.push({ sql, params }); return { rows, rowCount: rows.length }; } } as any }; }

test('upsert dedups by (chat_id,message_id)', async () => {
  const { pool, calls } = fakePool(); const repo = new AgentOpportunitiesRepository(pool);
  await repo.upsert({ chatId: 'c1', chatTitle: 'C', messageId: 5, text: 'ad' }, { kind: 'ad_offer', summary: 's', score: 80, suggestedAction: 'advertise' });
  assert.match(calls[0].sql, /INSERT INTO agent_opportunities/);
  assert.match(calls[0].sql, /ON CONFLICT \(chat_id, message_id\) DO NOTHING/);
  assert.equal(calls[0].params[0], 'c1'); assert.ok(calls[0].params.includes('ad_offer'));
});
test('list filters by status + kind', async () => {
  const { pool, calls } = fakePool(); const repo = new AgentOpportunitiesRepository(pool);
  await repo.list({ status: 'new', kind: 'ad_offer' });
  assert.match(calls[0].sql, /status = \$/); assert.match(calls[0].sql, /kind = \$/);
});
test('setStatus updates status', async () => {
  const { pool, calls } = fakePool(); const repo = new AgentOpportunitiesRepository(pool);
  await repo.setStatus('o1', 'archived');
  assert.match(calls[0].sql, /UPDATE agent_opportunities SET status/); assert.deepEqual(calls[0].params, ['o1', 'archived']);
});
```
- [ ] **Step 2: Run → FAIL. Step 3: Implement**
```ts
// agent-monitored-chats.repository.ts
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import type { MonitoredChatRow } from './agent.types';

@Injectable()
export class AgentMonitoredChatsRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}
  async upsert(chatId: string, title: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_monitored_chats (chat_id, title) VALUES ($1,$2)
       ON CONFLICT (chat_id) DO UPDATE SET title = EXCLUDED.title, updated_at = now()`, [chatId, title]);
  }
  async list(): Promise<MonitoredChatRow[]> {
    const { rows } = await this.pool.query<MonitoredChatRow>(`SELECT * FROM agent_monitored_chats ORDER BY title`);
    return rows;
  }
  async enabled(): Promise<MonitoredChatRow[]> {
    const { rows } = await this.pool.query<MonitoredChatRow>(`SELECT * FROM agent_monitored_chats WHERE enabled ORDER BY title`);
    return rows;
  }
  async setEnabled(chatId: string, enabled: boolean): Promise<void> {
    await this.pool.query(`UPDATE agent_monitored_chats SET enabled = $2, updated_at = now() WHERE chat_id = $1`, [chatId, enabled]);
  }
  async lastMessageId(chatId: string): Promise<number> {
    const { rows } = await this.pool.query<{ last_message_id: string }>(`SELECT last_message_id FROM agent_monitored_chats WHERE chat_id = $1`, [chatId]);
    return rows[0] ? Number(rows[0].last_message_id) : 0;
  }
  async setLastMessageId(chatId: string, id: number): Promise<void> {
    await this.pool.query(`UPDATE agent_monitored_chats SET last_message_id = $2, last_polled_at = now(), updated_at = now() WHERE chat_id = $1`, [chatId, id]);
  }
  async countEnabled(): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(`SELECT count(*)::int AS n FROM agent_monitored_chats WHERE enabled`);
    return Number(rows[0]?.n ?? 0);
  }
}
```
```ts
// agent-opportunities.repository.ts
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import type { Opportunity, OpportunityKind, OpportunityRow } from './agent.types';

@Injectable()
export class AgentOpportunitiesRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}
  async upsert(msg: { chatId: string; chatTitle: string | null; messageId: number; text: string }, o: Opportunity): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_opportunities (chat_id, chat_title, message_id, message_text, kind, summary, score, suggested_action)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (chat_id, message_id) DO NOTHING`,
      [msg.chatId, msg.chatTitle, msg.messageId, msg.text, o.kind, o.summary, o.score, o.suggestedAction]);
  }
  async list(filter: { status?: string; kind?: OpportunityKind } = {}): Promise<OpportunityRow[]> {
    const where: string[] = []; const params: any[] = [];
    if (filter.status) { params.push(filter.status); where.push(`status = $${params.length}`); }
    if (filter.kind)   { params.push(filter.kind);   where.push(`kind = $${params.length}`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await this.pool.query<OpportunityRow>(
      `SELECT * FROM agent_opportunities ${clause} ORDER BY (status='new') DESC, score DESC, created_at DESC`, params);
    return rows;
  }
  async setStatus(id: string, status: 'new' | 'reviewed' | 'archived'): Promise<void> {
    await this.pool.query(`UPDATE agent_opportunities SET status = $2 WHERE id = $1`, [id, status]);
  }
}
```
- [ ] **Step 4: Run → PASS (4+3). Full suite green. Step 5: Commit** `feat(agent): chat-intel repositories (monitored chats + opportunities)`

---

### Task 5: AgentChatClassifier

**Files:** Create `apps/automation/src/agent/agent-chat-classifier.service.ts` + `...test.ts`

- [ ] **Step 1: Write the failing test**
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentChatClassifier } from './agent-chat-classifier.service';

test('classifies via the model output', async () => {
  const claude = { available: true, chat: async () => '{"kind":"vp_request","summary":"s","score":60,"suggestedAction":"do_vp"}' } as any;
  const svc = new AgentChatClassifier(claude, { get: () => undefined } as any);
  const r = await svc.classify('Пропоную ВП');
  assert.equal(r.kind, 'vp_request'); assert.equal(r.suggestedAction, 'do_vp');
});
test('falls back to other when claude unavailable or null', async () => {
  const off = new AgentChatClassifier({ available: false, chat: async () => { throw new Error('no'); } } as any, { get: () => undefined } as any);
  assert.equal((await off.classify('x')).kind, 'other');
  const nul = new AgentChatClassifier({ available: true, chat: async () => null } as any, { get: () => undefined } as any);
  assert.equal((await nul.classify('x')).kind, 'other');
});
```
- [ ] **Step 2: Run → FAIL. Step 3: Implement**
```ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClaudeAgent } from '../common/ai/agents/claude.agent';
import { buildOpportunityPrompt, parseOpportunity } from './chat-intel.helpers';
import type { Opportunity } from './agent.types';

@Injectable()
export class AgentChatClassifier {
  constructor(private readonly claude: ClaudeAgent, private readonly config: ConfigService) {}
  async classify(text: string): Promise<Opportunity> {
    if (!this.claude.available) return parseOpportunity('');
    const { system, user } = buildOpportunityPrompt(text);
    const out = await this.claude.chat(
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      { model: this.config.get<string>('AGENT_TRIAGE_MODEL') ?? undefined, maxTokens: Number(this.config.get<string>('AGENT_TRIAGE_MAX_TOKENS')) || 800 });
    return parseOpportunity(out ?? '');
  }
}
```
- [ ] **Step 4: Run → PASS (2). Step 5: Commit** `feat(agent): AgentChatClassifier over ClaudeAgent`

---

### Task 6: AgentChatPoller (gated, pre-filter before AI)

**Files:** Create `apps/automation/src/agent/agent-chat.poller.ts` + `...test.ts`

- [ ] **Step 1: Write the failing test**
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentChatPoller } from './agent-chat.poller';

function harness(opts: { enabled?: boolean; chats?: any[]; messages?: Record<string, any[]>; max?: number }) {
  const classified: string[] = []; const upserts: any[] = [];
  const client = { fetchChatMessages: async (chatId: string) => (opts.messages ?? {})[chatId] ?? [] } as any;
  const classifier = { classify: async (t: string) => { classified.push(t); return { kind: 'ad_offer', summary: '', score: 1, suggestedAction: 'advertise' }; } } as any;
  const chats = {
    enabled: async () => opts.chats ?? [],
    lastMessageId: async () => 0,
    setLastMessageId: async () => {},
  } as any;
  const opps = { upsert: async (m: any) => { upserts.push(m); } } as any;
  const config = { get: (k: string) => (k === 'AGENT_CHAT_ENABLED' ? (opts.enabled ? 'true' : 'false') : k === 'AGENT_CHAT_MAX' ? String(opts.max ?? 20) : undefined) } as any;
  return { poller: new AgentChatPoller(client, classifier, chats, opps, config), classified, upserts };
}
const msg = (id: number, text: string) => ({ messageId: id, text, date: new Date() });

test('no-op when disabled', async () => {
  const h = harness({ enabled: false, chats: [{ chat_id: 'c1', title: 'C' }], messages: { c1: [msg(1, 'реклама 500 грн')] } });
  const r = await h.poller.pollOnce();
  assert.equal(r.classified, 0); assert.equal(h.upserts.length, 0);
});
test('pre-filter drops non-candidates (classifier NOT called)', async () => {
  const h = harness({ enabled: true, chats: [{ chat_id: 'c1', title: 'C' }], messages: { c1: [msg(1, 'привіт як справи')] } });
  const r = await h.poller.pollOnce();
  assert.equal(h.classified.length, 0); assert.equal(r.classified, 0);
});
test('candidates are classified + upserted', async () => {
  const h = harness({ enabled: true, chats: [{ chat_id: 'c1', title: 'C' }], messages: { c1: [msg(1, 'привіт'), msg(2, 'шукаю рекламу 500 грн')] } });
  const r = await h.poller.pollOnce();
  assert.equal(h.classified.length, 1); assert.equal(r.classified, 1);
  assert.equal(h.upserts[0].messageId, 2);
});
test('respects AGENT_CHAT_MAX', async () => {
  const chats = Array.from({ length: 5 }, (_, i) => ({ chat_id: 'c' + i, title: 'C' }));
  const messages: any = {}; chats.forEach(c => { messages[c.chat_id] = [msg(1, 'реклама 500 грн')]; });
  const h = harness({ enabled: true, chats, messages, max: 2 });
  await h.poller.pollOnce();
  assert.equal(h.upserts.length, 2); // only first 2 chats polled
});
```
- [ ] **Step 2: Run → FAIL. Step 3: Implement**
```ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { AgentMtprotoClient } from './agent-mtproto.client';
import { AgentChatClassifier } from './agent-chat-classifier.service';
import { AgentMonitoredChatsRepository } from './agent-monitored-chats.repository';
import { AgentOpportunitiesRepository } from './agent-opportunities.repository';
import { isOpportunityCandidate } from './chat-intel.helpers';

@Injectable()
export class AgentChatPoller {
  private readonly logger = new Logger(AgentChatPoller.name);
  constructor(
    private readonly client: AgentMtprotoClient,
    private readonly classifier: AgentChatClassifier,
    private readonly chats: AgentMonitoredChatsRepository,
    private readonly opps: AgentOpportunitiesRepository,
    private readonly config: ConfigService,
  ) {}

  @Cron(process.env.AGENT_CHAT_POLL_CRON || '*/15 * * * *')
  async tick(): Promise<void> {
    try { await this.pollOnce(); } catch (err: any) { this.logger.warn(`chat poll failed: ${err.message}`); }
  }

  async pollOnce(): Promise<{ classified: number }> {
    if (this.config.get<string>('AGENT_CHAT_ENABLED') !== 'true') return { classified: 0 };
    const max = Number(this.config.get('AGENT_CHAT_MAX')) || 20;
    const enabled = (await this.chats.enabled()).slice(0, max);
    let classified = 0;
    for (const c of enabled) {
      const since = await this.chats.lastMessageId(c.chat_id);
      const msgs = await this.client.fetchChatMessages(c.chat_id, since);
      let maxId = since;
      for (const m of msgs) {
        if (m.messageId > maxId) maxId = m.messageId;
        if (!isOpportunityCandidate(m.text)) continue;       // pre-filter BEFORE any AI
        const o = await this.classifier.classify(m.text);
        classified++;
        await this.opps.upsert({ chatId: c.chat_id, chatTitle: c.title ?? null, messageId: m.messageId, text: m.text }, o);
      }
      if (maxId > since) await this.chats.setLastMessageId(c.chat_id, maxId);
    }
    if (classified) this.logger.log(`chat-intel: classified ${classified} candidate message(s)`);
    return { classified };
  }
}
```
- [ ] **Step 4: Run → PASS (4). Step 5: Commit** `feat(agent): gated chat-intel poller (pre-filter → classify → opportunities)`

---

### Task 7: API routes on AgentController

**Files:** Modify `apps/automation/src/agent/agent.controller.ts`; add `dto/monitor-chat.dto.ts`; extend `agent.controller.test.ts`

- [ ] **Step 1: Write the failing test** (extend; stub `AgentMtprotoClient.listGroups`, `AgentMonitoredChatsRepository`, `AgentOpportunitiesRepository`):
```ts
test('GET chats merges joined groups with monitored flags', async () => {
  const calls: any[] = [];
  const client = { listGroups: async () => [{ chatId: 'c1', title: 'One' }, { chatId: 'c2', title: 'Two' }] } as any;
  const chatsRepo = { list: async () => [{ chat_id: 'c1', enabled: true }] } as any;
  const ctrl = makeCtrlWithChatIntel(client, chatsRepo, {} as any);
  const r = await ctrl.chats();
  assert.equal(r.length, 2);
  assert.equal(r.find((x: any) => x.chatId === 'c1').enabled, true);
  assert.equal(r.find((x: any) => x.chatId === 'c2').enabled, false);
});
test('POST monitor upserts + sets enabled', async () => {
  const calls: any[] = [];
  const client = { listGroups: async () => [{ chatId: 'c1', title: 'One' }] } as any;
  const chatsRepo = { upsert: async (id: string, t: string) => calls.push(['upsert', id, t]), setEnabled: async (id: string, e: boolean) => calls.push(['enable', id, e]) } as any;
  const ctrl = makeCtrlWithChatIntel(client, chatsRepo, {} as any);
  await ctrl.monitor('c1', { enabled: true });
  assert.ok(calls.some(c => c[0] === 'enable' && c[2] === true));
});
test('GET opportunities lists by status/kind', async () => {
  const oppsRepo = { list: async (f: any) => [{ id: 'o1' }] } as any;
  const ctrl = makeCtrlWithChatIntel({} as any, {} as any, oppsRepo);
  const r = await ctrl.opportunities('new', 'ad_offer');
  assert.equal(r.length, 1);
});
```
(Define `makeCtrlWithChatIntel` mirroring the existing controller-test helpers, passing the three new deps.)
- [ ] **Step 2: Run → FAIL. Step 3: Implement.** Add `AgentMtprotoClient`, `AgentMonitoredChatsRepository`, `AgentOpportunitiesRepository` to the controller constructor. `dto/monitor-chat.dto.ts`:
```ts
import { IsBoolean } from 'class-validator';
export class MonitorChatDto { @IsBoolean() enabled!: boolean; }
```
Routes:
```ts
@Get('chats')
async chats() {
  const [groups, monitored] = await Promise.all([this.client.listGroups(), this.chatsRepo.list()]);
  const enabledMap = new Map(monitored.map(m => [m.chat_id, m.enabled]));
  return groups.map(g => ({ chatId: g.chatId, title: g.title, enabled: enabledMap.get(g.chatId) ?? false }));
}
@Post('chats/:chatId/monitor')
async monitor(@Param('chatId') chatId: string, @Body() dto: MonitorChatDto) {
  const groups = await this.client.listGroups();
  const g = groups.find(x => x.chatId === chatId);
  await this.chatsRepo.upsert(chatId, g?.title ?? chatId);
  await this.chatsRepo.setEnabled(chatId, dto.enabled);
  return { ok: true };
}
@Get('opportunities')
opportunities(@Query('status') status?: string, @Query('kind') kind?: any) { return this.oppsRepo.list({ status, kind }); }
@Patch('opportunities/:id')
async patchOpp(@Param('id') id: string, @Body() dto: PatchThreadDto) { await this.oppsRepo.setStatus(id, dto.status); return { ok: true }; }
```
(Reuse the existing `PatchThreadDto` from SP1 for `{status}` — same shape new/reviewed/archived.)
- [ ] **Step 4: Run → PASS. Full suite green. Step 5: Commit** `feat(agent): REST routes for chat monitoring + opportunities`

---

### Task 8: Module wiring + env

**Files:** Modify `agent.module.ts`, `.env.example`

- [ ] **Step 1:** Add `AgentChatClassifier`, `AgentMonitoredChatsRepository`, `AgentOpportunitiesRepository`, `AgentChatPoller` to `AgentModule.providers`. (`AgentMtprotoClient` already a provider.)
- [ ] **Step 2:** `.env.example` — under the Agent section add:
```bash
# Chat-intel: monitor already-joined group chats for ad/ВП opportunities (read-only).
AGENT_CHAT_ENABLED=false
AGENT_CHAT_POLL_CRON=*/15 * * * *
AGENT_CHAT_MAX=20
```
- [ ] **Step 3:** `cd apps/automation && npm run build && npm test` green. **Step 4: Commit** `feat(agent): wire chat-intel providers + env`

---

### Task 9: Dashboard API client

**Files:** Modify `apps/dashboard/src/api/agent.ts` + `api/types.ts`

- [ ] **Step 1:** Types `OpportunityKind`, `SuggestedAction`, `AgentOpportunity`, `MonitoredChat` (`chatId,title,enabled`).
- [ ] **Step 2:** Hooks (match the `api<T>` style): `useAgentChats()`, `useSetChatMonitor()` (POST `chats/:id/monitor`), `useAgentOpportunities(status?,kind?)`, `usePatchOpportunity()`. Invalidate `['agent','chats']` / `['agent','opportunities']`.
- [ ] **Step 3:** `pnpm --filter dashboard build` clean. **Step 4: Commit** `feat(agent): dashboard API for chat intel`

---

### Task 10: Dashboard "Chat intel" UI

**Files:** Modify `apps/dashboard/src/routes/app.agent.tsx`

- [ ] **Step 1:** Add a "Chat intel" `SectionCard`:
  - Monitored-chats manager: `useAgentChats()` → list joined groups with a toggle (`useSetChatMonitor`) per chat; if empty, a note "no joined groups / add the agent account to chats in Telegram first".
  - Opportunities feed: `useAgentOpportunities('new')` → card-rows: kind Badge (`ad_offer`=accent, `vp_request`=success, `pricing`=neutral, `other`=neutral), score, summary, chat title, `suggestedAction` text; RowActions: reviewed + archive (`usePatchOpportunity`). No act/send buttons (acting is via the inbox/ads).
- [ ] **Step 2:** `pnpm --filter dashboard build` clean. **Step 3: Commit** `feat(agent): chat-intel UI (monitored chats + opportunities feed)`

---

### Task 11: Full verification

- [ ] **Step 1:** `cd apps/automation && npm run build && npm test` green incl. SP4 tests.
- [ ] **Step 2:** Dashboard `pnpm --filter dashboard build` clean.
- [ ] **Step 3: Read-only + no-join guards:**
  - `grep -rln "sendMessage\|sendFile" apps/automation/src/agent/` → ONLY `agent-reply-sender.service.ts`.
  - `grep -rni "joinchannel\|importchatinvite\|joinChat" apps/automation/src/agent/` → nothing.
- [ ] **Step 4: Cost-bound proof** — the poller test proves non-candidates never reach the classifier.
- [ ] **Step 5:** Feature complete; merge only on the owner's explicit go-ahead.

## Notes for the implementer
- NEVER add a join or send method to the agent module.
- The pre-filter MUST run before the classifier (cost guard) — keep that ordering.
- Only already-joined chats; `listGroups` enumerates membership, it does not join.
- Off by default (`AGENT_CHAT_ENABLED`); capped by `AGENT_CHAT_MAX`.
