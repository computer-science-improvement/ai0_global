# Agent DM Inbox (SP1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dedicated MTProto "agent" account polls incoming DMs; Claude triages each thread (category/summary/extracted fields/draft reply/priority score); results are surfaced read-only in a new dashboard "Agent" area. The agent never sends anything in SP1.

**Architecture:** New `apps/automation/src/agent/` NestJS module. A cron poller uses an `mtproto_sessions` row with `role='agent'` (decrypted via `SecretsService`) to fetch new incoming DMs, runs each new thread through a triage service (one cheap `ClaudeAgent` Haiku call), and upserts one row per peer into `agent_dm_threads`. A guarded REST controller exposes the inbox; a TanStack-Router page renders it. Everything is gated behind `AGENT_ENABLED` (default off) and a present agent session.

**Tech Stack:** NestJS, `pg`, `@nestjs/schedule` cron, GramJS (`telegram`), `@anthropic-ai/sdk` via the existing `ClaudeAgent`, React 19 + TanStack Router/Query + the dashboard design system. Tests: `node:test` + `tsx` (backend), run from `apps/automation` via `npm test`. **No live network/AI in any test.**

**Conventions to follow:**
- Repositories inject `DB_POOL`; unit-test with a fake `{ query }` pool.
- Migrations are plain DDL in `database/migrations/NNN_*.sql` (the runner records the version — do NOT self-insert into `schema_migrations`).
- Controllers are guarded with `TrackingAuthGuard`.
- Dashboard tables/rows use the shared primitives (`PageHeader`, `SectionCard`, `Badge`, `card row-lift`, `SegmentedTabs`) and icon-only `TableAction`/`RowActions` per `apps/dashboard/CLAUDE.md`.
- Secrets are decrypted in memory only; never logged or returned by an API.

**Shared types (used across tasks — keep names identical):**
```ts
// apps/automation/src/agent/agent.types.ts
export type AgentCategory = 'ad' | 'vp' | 'question' | 'spam' | 'other';

export interface TriageResult {
  category:   AgentCategory;
  summary:    string;
  fields:     { channel?: string; budget?: string; dates?: string };
  draftReply: string;
  score:      number; // 0..100
}

export interface RawDm {
  peerId:       string;
  peerUsername: string | null;
  peerName:     string | null;
  messageId:    number;
  text:         string;
  date:         Date;
  out:          boolean; // true = sent by us (skip), false = incoming
}

export interface AgentThreadRow {
  id:               string;
  peer_id:          string;
  peer_username:    string | null;
  peer_name:        string | null;
  last_message_id:  string;   // bigint comes back as string from pg
  last_message_at:  Date;
  last_text:        string | null;
  category:         AgentCategory;
  summary:          string | null;
  fields:           Record<string, unknown>;
  draft_reply:      string | null;
  score:            number;
  status:           'new' | 'reviewed' | 'archived';
  created_at:       Date;
  updated_at:       Date;
}
```

---

### Task 1: Migration — `role` on mtproto_sessions + role-scoped active-session lookup

**Files:**
- Create: `database/migrations/037_mtproto_session_role.sql`
- Modify: `apps/automation/src/config/mtproto-sessions.repository.ts`
- Test: `apps/automation/src/config/mtproto-sessions.repository.test.ts` (existing)

- [ ] **Step 1: Write the migration**

`database/migrations/037_mtproto_session_role.sql`:
```sql
-- A session belongs to a role so the tracker/stats clients and the agent each
-- pick their OWN account and never steal the other's session. Existing rows
-- become 'tracker' (unchanged behavior).
ALTER TABLE mtproto_sessions
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'tracker'
  CHECK (role IN ('tracker', 'agent'));
```

- [ ] **Step 2: Write the failing test** (append to the existing test file)

```ts
test('activeSession filters by role (default tracker)', async () => {
  const calls: any[] = [];
  const pool = { query: async (sql: string, params: any[]) => { calls.push({ sql, params }); return { rows: [] }; } } as any;
  const secrets = { maybeDecrypt: (v: string) => v } as any;
  const repo = new MtprotoSessionsRepository(pool);
  await repo.activeSession(secrets);
  assert.match(calls[0].sql, /role = \$1/);
  assert.deepEqual(calls[0].params, ['tracker']);
  await repo.activeSession(secrets, 'agent');
  assert.deepEqual(calls[1].params, ['agent']);
});
```
(Confirm the existing test file already imports `MtprotoSessionsRepository`; if it constructs the repo differently, mirror that.)

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/automation && npx tsx --test "src/config/mtproto-sessions.repository.test.ts"`
Expected: FAIL — current query has no `role = $1`.

- [ ] **Step 4: Implement** — change `activeSession` (and keep `activeSessionString` delegating):

```ts
async activeSession(
  secrets: SecretsService,
  role: 'tracker' | 'agent' = 'tracker',
): Promise<ActiveMtprotoSession | null> {
  const { rows } = await this.pool.query<MtprotoSessionRow>(
    `SELECT * FROM mtproto_sessions WHERE active AND role = $1 ORDER BY created_at LIMIT 1`,
    [role],
  );
  const row = rows[0];
  if (!row) return null;
  const apiId = row.api_id ? parseInt(row.api_id, 10) : NaN;
  return {
    session: secrets.maybeDecrypt(row.session_enc),
    apiId:   Number.isFinite(apiId) ? apiId : null,
    apiHash: row.api_hash_enc ? secrets.maybeDecrypt(row.api_hash_enc) : null,
  };
}

async activeSessionString(secrets: SecretsService, role: 'tracker' | 'agent' = 'tracker'): Promise<string | null> {
  return (await this.activeSession(secrets, role))?.session ?? null;
}
```
Also add `role` to `MtprotoSessionRow` (`role: 'tracker' | 'agent'`).

- [ ] **Step 5: Run the whole suite to confirm no regression**

Run: `cd apps/automation && npm run build && npm test`
Expected: build clean; all tests pass (existing tracker callers default to `'tracker'`).

- [ ] **Step 6: Commit**

```bash
git add database/migrations/037_mtproto_session_role.sql apps/automation/src/config/mtproto-sessions.repository.ts apps/automation/src/config/mtproto-sessions.repository.test.ts
git commit -m "feat(agent): mtproto_sessions.role + role-scoped active-session lookup"
```

---

### Task 2: Migration — agent_dm_threads + agent_poll_cursor

**Files:**
- Create: `database/migrations/038_agent_dm_threads.sql`

- [ ] **Step 1: Write the migration**

`database/migrations/038_agent_dm_threads.sql`:
```sql
CREATE TABLE IF NOT EXISTS agent_dm_threads (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  peer_id          TEXT NOT NULL,
  peer_username    TEXT,
  peer_name        TEXT,
  last_message_id  BIGINT NOT NULL,
  last_message_at  TIMESTAMPTZ NOT NULL,
  last_text        TEXT,
  category         TEXT NOT NULL DEFAULT 'other'
                     CHECK (category IN ('ad','vp','question','spam','other')),
  summary          TEXT,
  fields           JSONB NOT NULL DEFAULT '{}'::jsonb,
  draft_reply      TEXT,
  score            INT NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'new'
                     CHECK (status IN ('new','reviewed','archived')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (peer_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_dm_status   ON agent_dm_threads (status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_dm_category ON agent_dm_threads (category);

CREATE TABLE IF NOT EXISTS agent_poll_cursor (
  session_id       TEXT PRIMARY KEY,   -- keyed by the literal 'agent' (single agent session)
  last_message_id  BIGINT NOT NULL DEFAULT 0,
  last_polled_at   TIMESTAMPTZ
);
```

- [ ] **Step 2: Sanity-check the SQL parses** (no DB needed — psql dry parse is optional; the runner applies it on boot). Verify the file is valid by eye against migration 036's style.

- [ ] **Step 3: Commit**

```bash
git add database/migrations/038_agent_dm_threads.sql
git commit -m "feat(agent): agent_dm_threads + agent_poll_cursor tables"
```

---

### Task 3: Triage helpers (pure) — prompt builder + parser

**Files:**
- Create: `apps/automation/src/agent/agent.types.ts` (the Shared types block above)
- Create: `apps/automation/src/agent/agent-triage.helpers.ts`
- Test: `apps/automation/src/agent/agent-triage.helpers.test.ts`

- [ ] **Step 1: Write the failing test**

`agent-triage.helpers.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTriagePrompt, parseTriageResult } from './agent-triage.helpers';

test('buildTriagePrompt embeds the message text and asks for JSON', () => {
  const { system, user } = buildTriagePrompt('Привіт, хочу рекламу у вашому каналі за 500 грн');
  assert.match(system, /JSON/);
  assert.match(system, /ad.*vp.*question.*spam.*other/s);
  assert.match(user, /500 грн/);
});

test('parseTriageResult parses valid JSON', () => {
  const r = parseTriageResult('{"category":"ad","summary":"s","fields":{"budget":"500"},"draftReply":"d","score":80}');
  assert.equal(r.category, 'ad');
  assert.equal(r.fields.budget, '500');
  assert.equal(r.score, 80);
});

test('parseTriageResult strips code fences', () => {
  const r = parseTriageResult('```json\n{"category":"vp","summary":"","fields":{},"draftReply":"","score":10}\n```');
  assert.equal(r.category, 'vp');
});

test('parseTriageResult falls back to other on garbage', () => {
  const r = parseTriageResult('not json at all');
  assert.equal(r.category, 'other');
  assert.equal(r.score, 0);
});

test('parseTriageResult clamps score and unknown category', () => {
  const r = parseTriageResult('{"category":"weird","summary":"","fields":{},"draftReply":"","score":999}');
  assert.equal(r.category, 'other');
  assert.equal(r.score, 100);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/automation && npx tsx --test "src/agent/agent-triage.helpers.test.ts"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`agent-triage.helpers.ts`:
```ts
import type { AgentCategory, TriageResult } from './agent.types';

const CATEGORIES: AgentCategory[] = ['ad', 'vp', 'question', 'spam', 'other'];

export function buildTriagePrompt(messageText: string): { system: string; user: string } {
  const system = [
    'You triage an incoming Telegram DM to the owner of a Ukrainian media network.',
    'Classify it and reply ONLY with a single JSON object, no prose, no code fence.',
    'Schema: {"category": "ad|vp|question|spam|other", "summary": string (Ukrainian, <= 200 chars),',
    '"fields": {"channel"?: string, "budget"?: string, "dates"?: string},',
    '"draftReply": string (Ukrainian, a short polite reply the owner could send),',
    '"score": integer 0-100 (business priority; ad/vp with budget = high, spam = 0)}.',
    'category meanings: ad = wants to buy ad placement; vp = mutual promotion (взаємний піар);',
    'question = a genuine question; spam = unsolicited junk; other = anything else.',
  ].join('\n');
  const user = `Message:\n"""\n${messageText}\n"""`;
  return { system, user };
}

export function parseTriageResult(raw: string): TriageResult {
  const fallback: TriageResult = { category: 'other', summary: '', fields: {}, draftReply: '', score: 0 };
  if (!raw) return fallback;
  const stripped = raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  let obj: any;
  try { obj = JSON.parse(stripped); } catch { return fallback; }
  if (!obj || typeof obj !== 'object') return fallback;

  const category: AgentCategory = CATEGORIES.includes(obj.category) ? obj.category : 'other';
  const rawScore = Number(obj.score);
  const score = Number.isFinite(rawScore) ? Math.max(0, Math.min(100, Math.round(rawScore))) : 0;
  const f = obj.fields && typeof obj.fields === 'object' ? obj.fields : {};
  return {
    category,
    summary:    typeof obj.summary === 'string' ? obj.summary.slice(0, 400) : '',
    fields:     {
      channel: typeof f.channel === 'string' ? f.channel : undefined,
      budget:  typeof f.budget === 'string' ? f.budget : undefined,
      dates:   typeof f.dates === 'string' ? f.dates : undefined,
    },
    draftReply: typeof obj.draftReply === 'string' ? obj.draftReply : '',
    score,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/automation && npx tsx --test "src/agent/agent-triage.helpers.test.ts"`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/agent/agent.types.ts apps/automation/src/agent/agent-triage.helpers.ts apps/automation/src/agent/agent-triage.helpers.test.ts
git commit -m "feat(agent): pure triage prompt builder + result parser"
```

---

### Task 4: AgentTriageService (wraps ClaudeAgent)

**Files:**
- Create: `apps/automation/src/agent/agent-triage.service.ts`
- Test: `apps/automation/src/agent/agent-triage.service.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentTriageService } from './agent-triage.service';

test('returns parsed triage from the model output', async () => {
  const claude = { available: true, chat: async () => '{"category":"ad","summary":"s","fields":{},"draftReply":"d","score":70}' } as any;
  const svc = new AgentTriageService(claude, { get: () => undefined } as any);
  const r = await svc.triage('хочу рекламу');
  assert.equal(r.category, 'ad');
  assert.equal(r.score, 70);
});

test('falls back to other when claude is unavailable', async () => {
  const claude = { available: false, chat: async () => { throw new Error('should not be called'); } } as any;
  const svc = new AgentTriageService(claude, { get: () => undefined } as any);
  const r = await svc.triage('x');
  assert.equal(r.category, 'other');
});

test('falls back to other when chat returns null', async () => {
  const claude = { available: true, chat: async () => null } as any;
  const svc = new AgentTriageService(claude, { get: () => undefined } as any);
  const r = await svc.triage('x');
  assert.equal(r.category, 'other');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/automation && npx tsx --test "src/agent/agent-triage.service.test.ts"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClaudeAgent } from '../common/ai/agents/claude.agent';
import { buildTriagePrompt, parseTriageResult } from './agent-triage.helpers';
import type { TriageResult } from './agent.types';

@Injectable()
export class AgentTriageService {
  constructor(
    private readonly claude: ClaudeAgent,
    private readonly config: ConfigService,
  ) {}

  async triage(messageText: string): Promise<TriageResult> {
    if (!this.claude.available) return parseTriageResult('');
    const { system, user } = buildTriagePrompt(messageText);
    const out = await this.claude.chat(
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      {
        model: this.config.get<string>('AGENT_TRIAGE_MODEL') ?? undefined,
        maxTokens: Number(this.config.get<string>('AGENT_TRIAGE_MAX_TOKENS')) || 800,
      },
    );
    return parseTriageResult(out ?? '');
  }
}
```
(Confirm `ClaudeAgent` lives at `../common/ai/agents/claude.agent` and exposes `available` + `chat(messages, options)`.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/automation && npx tsx --test "src/agent/agent-triage.service.test.ts"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/agent/agent-triage.service.ts apps/automation/src/agent/agent-triage.service.test.ts
git commit -m "feat(agent): AgentTriageService over ClaudeAgent (bounded, fail-safe)"
```

---

### Task 5: AgentInboxRepository

**Files:**
- Create: `apps/automation/src/agent/agent-inbox.repository.ts`
- Test: `apps/automation/src/agent/agent-inbox.repository.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentInboxRepository } from './agent-inbox.repository';

function fakePool() {
  const calls: Array<{ sql: string; params: any[] }> = [];
  let rows: any[] = [];
  return {
    calls,
    setRows: (r: any[]) => { rows = r; },
    pool: { query: async (sql: string, params: any[]) => { calls.push({ sql, params }); return { rows, rowCount: rows.length }; } } as any,
  };
}

const dm = { peerId: '42', peerUsername: 'bob', peerName: 'Bob', messageId: 100, text: 'hi', date: new Date('2026-01-01T00:00:00Z'), out: false };
const triage = { category: 'ad' as const, summary: 's', fields: { budget: '500' }, draftReply: 'd', score: 70 };

test('upsertThread upserts by peer_id with triage payload', async () => {
  const { pool, calls } = fakePool();
  const repo = new AgentInboxRepository(pool);
  await repo.upsertThread(dm, triage);
  assert.match(calls[0].sql, /INSERT INTO agent_dm_threads/);
  assert.match(calls[0].sql, /ON CONFLICT \(peer_id\) DO UPDATE/);
  assert.equal(calls[0].params[0], '42');           // peer_id
  assert.ok(calls[0].params.includes('ad'));        // category
});

test('list filters by status and category when provided', async () => {
  const { pool, calls } = fakePool();
  const repo = new AgentInboxRepository(pool);
  await repo.list({ status: 'new', category: 'ad' });
  assert.match(calls[0].sql, /status = \$/);
  assert.match(calls[0].sql, /category = \$/);
});

test('setStatus updates status', async () => {
  const { pool, calls } = fakePool();
  const repo = new AgentInboxRepository(pool);
  await repo.setStatus('id1', 'archived');
  assert.match(calls[0].sql, /UPDATE agent_dm_threads SET status/);
  assert.deepEqual(calls[0].params, ['id1', 'archived']);
});

test('lastMessageIdFor returns 0 when no row', async () => {
  const { pool } = fakePool();
  const repo = new AgentInboxRepository(pool);
  assert.equal(await repo.lastMessageIdFor('42'), 0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/automation && npx tsx --test "src/agent/agent-inbox.repository.test.ts"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import type { AgentCategory, AgentThreadRow, RawDm, TriageResult } from './agent.types';

@Injectable()
export class AgentInboxRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async upsertThread(dm: RawDm, t: TriageResult): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_dm_threads
         (peer_id, peer_username, peer_name, last_message_id, last_message_at, last_text,
          category, summary, fields, draft_reply, score, status, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,'new',now())
       ON CONFLICT (peer_id) DO UPDATE SET
         peer_username   = EXCLUDED.peer_username,
         peer_name       = EXCLUDED.peer_name,
         last_message_id = EXCLUDED.last_message_id,
         last_message_at = EXCLUDED.last_message_at,
         last_text       = EXCLUDED.last_text,
         category        = EXCLUDED.category,
         summary         = EXCLUDED.summary,
         fields          = EXCLUDED.fields,
         draft_reply     = EXCLUDED.draft_reply,
         score           = EXCLUDED.score,
         status          = 'new',
         updated_at      = now()`,
      [dm.peerId, dm.peerUsername, dm.peerName, dm.messageId, dm.date, dm.text,
       t.category, t.summary, JSON.stringify(t.fields), t.draftReply, t.score],
    );
  }

  async list(filter: { status?: string; category?: AgentCategory } = {}): Promise<AgentThreadRow[]> {
    const where: string[] = [];
    const params: any[] = [];
    if (filter.status)   { params.push(filter.status);   where.push(`status = $${params.length}`); }
    if (filter.category) { params.push(filter.category); where.push(`category = $${params.length}`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { rows } = await this.pool.query<AgentThreadRow>(
      `SELECT * FROM agent_dm_threads ${clause} ORDER BY (status='new') DESC, score DESC, last_message_at DESC`,
      params,
    );
    return rows;
  }

  async setStatus(id: string, status: 'new' | 'reviewed' | 'archived'): Promise<void> {
    await this.pool.query(`UPDATE agent_dm_threads SET status = $2, updated_at = now() WHERE id = $1`, [id, status]);
  }

  /** Newest message id we've already triaged for this peer (0 if unseen). */
  async lastMessageIdFor(peerId: string): Promise<number> {
    const { rows } = await this.pool.query<{ last_message_id: string }>(
      `SELECT last_message_id FROM agent_dm_threads WHERE peer_id = $1`, [peerId],
    );
    return rows[0] ? Number(rows[0].last_message_id) : 0;
  }

  async touchCursor(sessionId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_poll_cursor (session_id, last_polled_at) VALUES ($1, now())
       ON CONFLICT (session_id) DO UPDATE SET last_polled_at = now()`,
      [sessionId],
    );
  }

  async lastPolledAt(sessionId: string): Promise<Date | null> {
    const { rows } = await this.pool.query<{ last_polled_at: Date | null }>(
      `SELECT last_polled_at FROM agent_poll_cursor WHERE session_id = $1`, [sessionId],
    );
    return rows[0]?.last_polled_at ?? null;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/automation && npx tsx --test "src/agent/agent-inbox.repository.test.ts"`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/agent/agent-inbox.repository.ts apps/automation/src/agent/agent-inbox.repository.test.ts
git commit -m "feat(agent): AgentInboxRepository (upsert-by-peer, list, status, cursor)"
```

---

### Task 6: AgentMtprotoClient + pure dialog selector

**Files:**
- Create: `apps/automation/src/agent/agent-dialogs.helpers.ts` (pure, testable)
- Create: `apps/automation/src/agent/agent-mtproto.client.ts` (thin network wrapper; not unit-tested — mirrors the untested parts of `tracking-mtproto.client.ts`)
- Test: `apps/automation/src/agent/agent-dialogs.helpers.test.ts`

- [ ] **Step 1: Write the failing test** (pure selector)

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectNewIncoming } from './agent-dialogs.helpers';

const lastIds = new Map<string, number>([['42', 100]]);
const dms = [
  { peerId: '42', peerUsername: null, peerName: 'A', messageId: 100, text: 'old', date: new Date(), out: false }, // already seen
  { peerId: '42', peerUsername: null, peerName: 'A', messageId: 101, text: 'new', date: new Date(), out: false }, // newer → keep
  { peerId: '7',  peerUsername: null, peerName: 'B', messageId: 5,   text: 'first', date: new Date(), out: false }, // unseen → keep
  { peerId: '9',  peerUsername: null, peerName: 'C', messageId: 9,   text: 'mine', date: new Date(), out: true },  // outgoing → drop
];

test('keeps only incoming messages newer than the per-peer last id', () => {
  const out = selectNewIncoming(dms as any, lastIds);
  const ids = out.map(d => d.messageId).sort((a, b) => a - b);
  assert.deepEqual(ids, [5, 101]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/automation && npx tsx --test "src/agent/agent-dialogs.helpers.test.ts"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure helper**

`agent-dialogs.helpers.ts`:
```ts
import type { RawDm } from './agent.types';

/** Keep incoming DMs strictly newer than the per-peer last-seen message id. */
export function selectNewIncoming(dms: RawDm[], lastIdByPeer: Map<string, number>): RawDm[] {
  return dms.filter(d => !d.out && d.messageId > (lastIdByPeer.get(d.peerId) ?? 0));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/automation && npx tsx --test "src/agent/agent-dialogs.helpers.test.ts"`
Expected: PASS.

- [ ] **Step 5: Implement the thin network client** (no test; keep all logic out of it)

`agent-mtproto.client.ts`:
```ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { LogLevel } from 'telegram/extensions/Logger';
import { MtprotoSessionsRepository } from '../config/mtproto-sessions.repository';
import { SecretsService } from '../common/crypto/secrets.service';
import { withTimeout } from '../common/with-timeout';
import type { RawDm } from './agent.types';

const FLOOD_WAIT_RE = /A wait of (\d+) seconds is required/;

@Injectable()
export class AgentMtprotoClient {
  private readonly logger = new Logger(AgentMtprotoClient.name);

  constructor(
    private readonly sessions: MtprotoSessionsRepository,
    private readonly secrets:  SecretsService,
    private readonly config:   ConfigService,
  ) {}

  /** True when an active role='agent' session exists. */
  async hasSession(): Promise<boolean> {
    return (await this.sessions.activeSession(this.secrets, 'agent')) != null;
  }

  /**
   * Fetch the latest message of each recent 1:1 DM dialog. Read-only: this class
   * exposes NO send methods by design. Returns [] (and logs) when no agent
   * session, on FLOOD_WAIT, or on any error — the poller treats [] as "nothing".
   */
  async fetchRecentDialogs(limit = 50): Promise<RawDm[]> {
    const active = await this.sessions.activeSession(this.secrets, 'agent');
    if (!active) return [];
    const apiId   = active.apiId  ?? Number(this.config.get('TELEGRAM_API_ID'));
    const apiHash = active.apiHash ?? this.config.get<string>('TELEGRAM_API_HASH') ?? '';
    if (!apiId || !apiHash) { this.logger.warn('agent: missing api credentials'); return []; }

    const client = new TelegramClient(new StringSession(active.session), apiId, apiHash, { connectionRetries: 2 });
    client.setLogLevel(LogLevel.NONE);
    try {
      await client.connect();
      const dialogs = await withTimeout(client.getDialogs({ limit }), 15_000, 'agent getDialogs');
      const out: RawDm[] = [];
      for (const d of dialogs) {
        if (!d.isUser) continue;                 // 1:1 DMs only (no channels/groups)
        const m: any = d.message;
        if (!m || !m.id) continue;
        const ent: any = d.entity;
        out.push({
          peerId:       String(ent?.id ?? d.id),
          peerUsername: ent?.username ?? null,
          peerName:     [ent?.firstName, ent?.lastName].filter(Boolean).join(' ') || null,
          messageId:    Number(m.id),
          text:         typeof m.message === 'string' ? m.message : '',
          date:         m.date ? new Date(m.date * 1000) : new Date(),
          out:          !!m.out,
        });
      }
      return out;
    } catch (err: any) {
      const msg = err?.errorMessage ?? err?.message ?? String(err);
      if (FLOOD_WAIT_RE.test(msg)) this.logger.warn(`agent: FLOOD_WAIT — backing off`);
      else this.logger.warn(`agent fetchRecentDialogs failed: ${msg}`);
      return [];
    } finally {
      try { await client.disconnect(); } catch { /* ignore */ }
    }
  }
}
```
(`Api` is imported to match the codebase import even if unused here; remove if the linter objects.)

- [ ] **Step 6: Build to typecheck the client**

Run: `cd apps/automation && npm run build`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/automation/src/agent/agent-dialogs.helpers.ts apps/automation/src/agent/agent-dialogs.helpers.test.ts apps/automation/src/agent/agent-mtproto.client.ts
git commit -m "feat(agent): read-only MTProto DM client + pure new-incoming selector"
```

---

### Task 7: AgentInboxPoller (cron, gated)

**Files:**
- Create: `apps/automation/src/agent/agent-inbox.poller.ts`
- Test: `apps/automation/src/agent/agent-inbox.poller.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentInboxPoller } from './agent-inbox.poller';

function harness(opts: { enabled?: boolean; hasSession?: boolean; dialogs?: any[]; lastIds?: Record<string, number> }) {
  const triaged: string[] = [];
  const upserts: any[] = [];
  const client = {
    hasSession: async () => opts.hasSession ?? true,
    fetchRecentDialogs: async () => opts.dialogs ?? [],
  } as any;
  const triage = { triage: async (text: string) => { triaged.push(text); return { category: 'ad', summary: '', fields: {}, draftReply: '', score: 1 }; } } as any;
  const repo = {
    lastMessageIdFor: async (peer: string) => (opts.lastIds ?? {})[peer] ?? 0,
    upsertThread: async (dm: any) => { upserts.push(dm); },
    touchCursor: async () => {},
  } as any;
  const config = { get: (k: string) => (k === 'AGENT_ENABLED' ? (opts.enabled ? 'true' : 'false') : undefined) } as any;
  return { poller: new AgentInboxPoller(client, triage, repo, config), triaged, upserts };
}

const dm = (peerId: string, messageId: number, out = false) =>
  ({ peerId, peerUsername: null, peerName: null, messageId, text: `m${messageId}`, date: new Date(), out });

test('no-op when AGENT_ENABLED is false', async () => {
  const h = harness({ enabled: false, dialogs: [dm('1', 5)] });
  const r = await h.poller.pollOnce();
  assert.equal(r.triaged, 0);
  assert.equal(h.upserts.length, 0);
});

test('no-op when no agent session', async () => {
  const h = harness({ enabled: true, hasSession: false, dialogs: [dm('1', 5)] });
  const r = await h.poller.pollOnce();
  assert.equal(r.triaged, 0);
});

test('triages + upserts only new incoming dialogs', async () => {
  const h = harness({ enabled: true, dialogs: [dm('1', 5), dm('2', 3, true), dm('3', 9)], lastIds: { '3': 9 } });
  const r = await h.poller.pollOnce();
  // peer 1 new (5>0) → keep; peer 2 outgoing → drop; peer 3 not newer (9>9 false) → drop
  assert.equal(r.triaged, 1);
  assert.equal(h.upserts.length, 1);
  assert.equal(h.upserts[0].peerId, '1');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/automation && npx tsx --test "src/agent/agent-inbox.poller.test.ts"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { AgentMtprotoClient } from './agent-mtproto.client';
import { AgentTriageService } from './agent-triage.service';
import { AgentInboxRepository } from './agent-inbox.repository';
import { selectNewIncoming } from './agent-dialogs.helpers';

@Injectable()
export class AgentInboxPoller {
  private readonly logger = new Logger(AgentInboxPoller.name);

  constructor(
    private readonly client: AgentMtprotoClient,
    private readonly triage: AgentTriageService,
    private readonly repo:   AgentInboxRepository,
    private readonly config: ConfigService,
  ) {}

  // Cadence is fixed at registration time; AGENT_ENABLED gates execution.
  @Cron(process.env.AGENT_POLL_CRON || '*/5 * * * *')
  async tick(): Promise<void> {
    try { await this.pollOnce(); }
    catch (err: any) { this.logger.warn(`agent poll failed: ${err.message}`); }
  }

  /** Poll once. Returns { triaged } count of new threads processed. */
  async pollOnce(): Promise<{ triaged: number }> {
    if (this.config.get<string>('AGENT_ENABLED') !== 'true') return { triaged: 0 };
    if (!(await this.client.hasSession())) {
      this.logger.log('agent enabled but no active agent session — skipping');
      return { triaged: 0 };
    }

    const dialogs = await this.client.fetchRecentDialogs();
    const lastIds = new Map<string, number>();
    for (const d of dialogs) lastIds.set(d.peerId, await this.repo.lastMessageIdFor(d.peerId));

    const fresh = selectNewIncoming(dialogs, lastIds);
    for (const dm of fresh) {
      const t = await this.triage.triage(dm.text);
      await this.repo.upsertThread(dm, t);
    }
    await this.repo.touchCursor('agent');
    if (fresh.length) this.logger.log(`agent: triaged ${fresh.length} new DM thread(s)`);
    return { triaged: fresh.length };
  }
}
```
(`touchCursor('agent')` keys `agent_poll_cursor` by the literal `'agent'` — that column is `TEXT` per migration 038.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/automation && npx tsx --test "src/agent/agent-inbox.poller.test.ts"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/agent/agent-inbox.poller.ts apps/automation/src/agent/agent-inbox.poller.test.ts database/migrations/038_agent_dm_threads.sql
git commit -m "feat(agent): gated cron poller (triage new incoming DMs only)"
```

---

### Task 8: Agent REST API (controller + DTO)

**Files:**
- Create: `apps/automation/src/agent/dto/patch-thread.dto.ts`
- Create: `apps/automation/src/agent/agent.controller.ts`
- Test: `apps/automation/src/agent/agent.controller.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentController } from './agent.controller';

function make() {
  const calls: any[] = [];
  const repo = {
    list: async (f: any) => { calls.push(['list', f]); return [{ id: 'a', peer_id: '1' }]; },
    setStatus: async (id: string, s: string) => { calls.push(['setStatus', id, s]); },
    lastPolledAt: async () => new Date('2026-01-01T00:00:00Z'),
  } as any;
  const client = { hasSession: async () => true } as any;
  const config = { get: (k: string) => (k === 'AGENT_ENABLED' ? 'true' : '*/5 * * * *') } as any;
  return { ctrl: new AgentController(repo, client, config), calls };
}

test('GET inbox passes status+category filter through', async () => {
  const { ctrl, calls } = make();
  const rows = await ctrl.inbox('new', 'ad');
  assert.equal(rows.length, 1);
  assert.deepEqual(calls[0], ['list', { status: 'new', category: 'ad' }]);
});

test('PATCH validates status and calls setStatus', async () => {
  const { ctrl, calls } = make();
  await ctrl.patch('a', { status: 'archived' });
  assert.deepEqual(calls[0], ['setStatus', 'a', 'archived']);
});

test('GET status reports enabled + hasSession', async () => {
  const { ctrl } = make();
  const s = await ctrl.status();
  assert.equal(s.enabled, true);
  assert.equal(s.hasAgentSession, true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/automation && npx tsx --test "src/agent/agent.controller.test.ts"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement DTO + controller**

`dto/patch-thread.dto.ts`:
```ts
import { IsIn } from 'class-validator';
export class PatchThreadDto {
  @IsIn(['new', 'reviewed', 'archived'])
  status!: 'new' | 'reviewed' | 'archived';
}
```

`agent.controller.ts`:
```ts
import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TrackingAuthGuard } from '../tracking/api/tracking-auth.guard';
import { AgentInboxRepository } from './agent-inbox.repository';
import { AgentMtprotoClient } from './agent-mtproto.client';
import { PatchThreadDto } from './dto/patch-thread.dto';
import type { AgentCategory } from './agent.types';

@Controller('api/agent')
@UseGuards(TrackingAuthGuard)
export class AgentController {
  constructor(
    private readonly repo:   AgentInboxRepository,
    private readonly client: AgentMtprotoClient,
    private readonly config: ConfigService,
  ) {}

  @Get('inbox')
  inbox(@Query('status') status?: string, @Query('category') category?: AgentCategory) {
    return this.repo.list({ status, category });
  }

  @Patch('inbox/:id')
  async patch(@Param('id') id: string, @Body() dto: PatchThreadDto) {
    await this.repo.setStatus(id, dto.status);
    return { ok: true };
  }

  @Get('status')
  async status() {
    return {
      enabled:        this.config.get<string>('AGENT_ENABLED') === 'true',
      hasAgentSession: await this.client.hasSession(),
      lastPolledAt:   await this.repo.lastPolledAt('agent'),
      cadence:        process.env.AGENT_POLL_CRON || '*/5 * * * *',
    };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/automation && npx tsx --test "src/agent/agent.controller.test.ts"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/agent/dto/patch-thread.dto.ts apps/automation/src/agent/agent.controller.ts apps/automation/src/agent/agent.controller.test.ts
git commit -m "feat(agent): guarded REST API for inbox list/patch/status"
```

---

### Task 9: AgentModule wiring + env docs

**Files:**
- Create: `apps/automation/src/agent/agent.module.ts`
- Modify: `apps/automation/src/app.module.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write the module**

`agent.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { AgentTriageService } from './agent-triage.service';
import { AgentInboxRepository } from './agent-inbox.repository';
import { AgentMtprotoClient } from './agent-mtproto.client';
import { AgentInboxPoller } from './agent-inbox.poller';
import { AgentController } from './agent.controller';

// DB_POOL, SecretsService, ClaudeAgent, MtprotoSessionsRepository all come from
// @Global modules (DatabaseModule, CryptoModule, CommonModule, ChannelConfigModule).
@Module({
  controllers: [AgentController],
  providers:   [AgentTriageService, AgentInboxRepository, AgentMtprotoClient, AgentInboxPoller],
  exports:     [AgentInboxRepository],
})
export class AgentModule {}
```
(Before implementing: confirm `ClaudeAgent` and `MtprotoSessionsRepository` are exported from their `@Global` modules — `CommonModule`/`ChannelConfigModule`. If `ClaudeAgent` is not exported globally, import the module that provides it into `AgentModule` instead.)

- [ ] **Step 2: Wire into app.module.ts**

Add import near the other module imports and add `AgentModule` to the `imports: [...]` array (after `AlertingModule`):
```ts
import { AgentModule } from './agent/agent.module';
// ...
    AlertingModule,
    AgentModule,
```

- [ ] **Step 3: Document env in `.env.example`** (new section before "Pipeline options"):
```bash
# ─── Agent (DM triage; off by default) ───────────────────────────────────────
# Reads incoming DMs on the mtproto_sessions row with role='agent', classifies
# them with Claude, and surfaces drafts in the dashboard. Read-only — never sends.
AGENT_ENABLED=false
AGENT_POLL_CRON=*/5 * * * *
AGENT_TRIAGE_MODEL=
AGENT_TRIAGE_MAX_TOKENS=800
```

- [ ] **Step 4: Build + full suite**

Run: `cd apps/automation && npm run build && npm test`
Expected: build clean; all tests pass (incl. the new agent suites).

- [ ] **Step 5: Commit**

```bash
git add apps/automation/src/agent/agent.module.ts apps/automation/src/app.module.ts .env.example
git commit -m "feat(agent): wire AgentModule + env docs (off by default)"
```

---

### Task 10: Dashboard API client

**Files:**
- Create: `apps/dashboard/src/api/agent.ts`
- Modify: `apps/dashboard/src/api/types.ts` (add `AgentThread`, `AgentStatus`)

- [ ] **Step 1: Add types** to `api/types.ts`:
```ts
export type AgentCategory = 'ad' | 'vp' | 'question' | 'spam' | 'other';
export interface AgentThread {
  id: string; peer_id: string; peer_username: string | null; peer_name: string | null;
  last_message_at: string; last_text: string | null;
  category: AgentCategory; summary: string | null;
  fields: { channel?: string; budget?: string; dates?: string };
  draft_reply: string | null; score: number;
  status: 'new' | 'reviewed' | 'archived';
}
export interface AgentStatus {
  enabled: boolean; hasAgentSession: boolean; lastPolledAt: string | null; cadence: string;
}
```

- [ ] **Step 2: Implement the API hooks** (`api/agent.ts`) — mirror an existing api module (e.g. `api/activity.ts`) for the fetch helper + react-query usage:
```ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client'; // use whatever the repo's shared fetch wrapper is
import type { AgentThread, AgentStatus, AgentCategory } from './types';

export function useAgentInbox(filter: { status?: string; category?: AgentCategory } = {}) {
  const qs = new URLSearchParams();
  if (filter.status)   qs.set('status', filter.status);
  if (filter.category) qs.set('category', filter.category);
  return useQuery({
    queryKey: ['agent', 'inbox', filter],
    queryFn: () => api.get<AgentThread[]>(`/api/agent/inbox?${qs.toString()}`),
  });
}
export function useAgentStatus() {
  return useQuery({ queryKey: ['agent', 'status'], queryFn: () => api.get<AgentStatus>('/api/agent/status') });
}
export function usePatchAgentThread() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; status: 'reviewed' | 'archived' | 'new' }) =>
      api.patch(`/api/agent/inbox/${v.id}`, { status: v.status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agent', 'inbox'] }),
  });
}
```
(Adapt `api.get/patch` to the repo's actual client helper — open `api/activity.ts` to copy the exact import + call style.)

- [ ] **Step 3: Build** to typecheck:

Run: `cd /Users/tupotavalentyn/CS/ai0_global && pnpm --filter dashboard build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/api/agent.ts apps/dashboard/src/api/types.ts
git commit -m "feat(agent): dashboard API client (inbox/status/patch)"
```

---

### Task 11: Dashboard `/app/agent` page + sidebar nav

**Files:**
- Create: `apps/dashboard/src/routes/app.agent.tsx`
- Modify: `apps/dashboard/src/components/AppSidebar.tsx` (add an "Agent" nav item)

- [ ] **Step 1: Implement the route**

`app.agent.tsx` — follow `app.scheduled.tsx` / `app.channels.tsx` card-row patterns. Required behavior:
- `useAgentStatus()` → a `SectionCard` "Agent" showing enabled + session presence; when `!hasAgentSession`, show an `EmptyState` linking to Connections → Sessions ("add a session and set its role to agent").
- `SegmentedTabs` to filter by category (`all/ad/vp/question/spam/other`).
- `useAgentInbox({ category })` → card-rows: peer (name/@username), a `Badge` for category (`ad`=accent, `vp`=success, `question`=neutral, `spam`=warning, `other`=neutral), the score, the summary, and a collapsible read-only draft reply; `RowActions` with icon-only mark-reviewed (`action="enable"` icon or a `check` icon) and archive (`action="delete"`-styled but labelled "Archive"). NO send control.

```tsx
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { PageHeader } from '../components/ui/PageHeader';
import { SectionCard, EmptyState, Badge as _Badge } from '../components/ui/primitives';
import { Badge } from '../components/ui/Badge';
import { SegmentedTabs } from '../components/SegmentedTabs';
import { TableAction, RowActions } from '../components/ui/table';
import { useAgentInbox, useAgentStatus, usePatchAgentThread } from '../api/agent';
import type { AgentCategory } from '../api/types';

export const Route = createFileRoute('/app/agent')({ component: AgentPage });

const CAT_TONE: Record<AgentCategory, 'accent' | 'success' | 'neutral' | 'warning'> = {
  ad: 'accent', vp: 'success', question: 'neutral', spam: 'warning', other: 'neutral',
};
const TABS = [
  { key: 'all', label: 'All' }, { key: 'ad', label: 'Ad' }, { key: 'vp', label: 'ВП' },
  { key: 'question', label: 'Questions' }, { key: 'spam', label: 'Spam' }, { key: 'other', label: 'Other' },
] as const;

function AgentPage() {
  const [cat, setCat] = useState<string>('all');
  const status = useAgentStatus();
  const inbox = useAgentInbox(cat === 'all' ? {} : { category: cat as AgentCategory });
  const patch = usePatchAgentThread();

  return (
    <div>
      <PageHeader title="Agent" subtitle="Incoming DMs triaged by the agent. Review drafts here — nothing is sent automatically." />

      <SectionCard title="Agent status" icon="bots" delay={20} style={{ marginBottom: 16 }}>
        {!status.data?.hasAgentSession ? (
          <EmptyState icon="bots" title="No agent session" note="Add an MTProto session and set its role to 'agent' in Connections → Sessions." />
        ) : (
          <div className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>
            Polling {status.data?.enabled ? 'on' : 'off'} · cadence {status.data?.cadence} ·
            last polled {status.data?.lastPolledAt ? new Date(status.data.lastPolledAt).toLocaleString() : 'never'}
          </div>
        )}
      </SectionCard>

      <div style={{ marginBottom: 16 }}>
        <SegmentedTabs value={cat} onChange={setCat} options={TABS as any} />
      </div>

      {inbox.data && inbox.data.length === 0 && (
        <EmptyState icon="bots" title="Inbox empty" note="Triaged DM threads will show up here." />
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {inbox.data?.map((t) => (
          <div key={t.id} className="card row-lift" style={{ display: 'flex', alignItems: 'flex-start', gap: 16, padding: '13px 18px' }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span className="text-body" style={{ color: 'var(--color-ink)', fontWeight: 500 }}>
                  {t.peer_name ?? (t.peer_username ? '@' + t.peer_username : t.peer_id)}
                </span>
                <Badge tone={CAT_TONE[t.category]}>{t.category}</Badge>
                <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>score {t.score}</span>
              </div>
              {t.summary && <div className="text-body-sm" style={{ color: 'var(--color-ink-muted)', marginTop: 4 }}>{t.summary}</div>}
              {t.draft_reply && (
                <details style={{ marginTop: 6 }}>
                  <summary className="text-micro" style={{ color: 'var(--color-accent)', cursor: 'pointer' }}>Draft reply</summary>
                  <div className="text-body-sm" style={{ color: 'var(--color-ink)', marginTop: 4, whiteSpace: 'pre-wrap' }}>{t.draft_reply}</div>
                </details>
              )}
            </div>
            <RowActions>
              <TableAction icon="check" label="Reviewed" onClick={() => patch.mutate({ id: t.id, status: 'reviewed' })} />
              <span className="row-actions-sep" aria-hidden />
              <TableAction icon="x" danger label="Archive" onClick={() => patch.mutate({ id: t.id, status: 'archived' })} />
            </RowActions>
          </div>
        ))}
      </div>
    </div>
  );
}
```
(Remove the unused `_Badge` import; it's listed only to remind you both Badge modules exist — use `ui/Badge`.)

- [ ] **Step 2: Add the sidebar nav item** in `AppSidebar.tsx` — copy the existing nav-item pattern, label "Agent", icon `bots`, route `/app/agent`. Place it near "Scheduled"/"Logs".

- [ ] **Step 3: Build** to typecheck + generate the route tree:

Run: `cd /Users/tupotavalentyn/CS/ai0_global && pnpm --filter dashboard build`
Expected: clean (TanStack route auto-registers from the file).

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/routes/app.agent.tsx apps/dashboard/src/components/AppSidebar.tsx
git commit -m "feat(agent): /app/agent inbox page + sidebar nav"
```

---

### Task 12: Full verification

- [ ] **Step 1: Backend**

Run: `cd apps/automation && npm run build && npm test`
Expected: build clean; full suite green including all `src/agent/*.test.ts`.

- [ ] **Step 2: Dashboard**

Run: `cd /Users/tupotavalentyn/CS/ai0_global && pnpm --filter dashboard build`
Expected: clean.

- [ ] **Step 3: Read-only proof**

Run: `grep -rn "sendMessage\|sendFile" apps/automation/src/agent/ || echo "no send methods in agent — read-only confirmed"`
Expected: prints the read-only confirmation.

- [ ] **Step 4: Off-by-default proof** — confirm `AGENT_ENABLED=false` in `.env.example` and that `pollOnce` returns `{ triaged: 0 }` when disabled (covered by Task 7 test).

- [ ] **Step 5: Commit any final docs tweak** (if needed). Otherwise the feature is complete; merge only on the owner's explicit go-ahead.

---

## Notes for the implementer
- **Do not** add any send/reply capability — that is SP2 and intentionally out of scope.
- Keep the agent account isolated (`role='agent'`); never reuse the tracker/publishing session.
- Everything stays off until the owner sets `AGENT_ENABLED=true` AND creates an agent session.
- The owner reviews every thread; triage output is advisory.
