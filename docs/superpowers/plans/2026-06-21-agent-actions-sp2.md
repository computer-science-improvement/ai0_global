# Agent Actions (SP2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add an approval-gated action layer to the agent: a unified `agent_actions` queue with two types — `reply` (send a DM from the agent MTProto account) and `schedule_post` (insert a sponsored/ВП post into the existing `scheduled_posts` queue). Every action is owner-approved/edited/rejected; the SP1 poller stays read-only.

**Architecture:** Extends `apps/automation/src/agent/`. `AgentActionsRepository` stores the queue. `AgentReplySender` is the ONLY component that can send a Telegram message (agent session, invoked only from the approve path — never the poller). `AgentScheduleExecutor` reuses `ScheduledPostsRepository.create`. `AgentActionsService.approve/reject` orchestrates, enforcing a daily reply cap and idempotency. The dashboard `/app/agent` gains a "Pending actions" section.

**Tech Stack:** NestJS, `pg`, GramJS (`telegram`), React + TanStack. Tests: `node:test` + `tsx` from `apps/automation` (`npm test`). **No live network/AI in tests.** Do not push.

**Shared types (add to `apps/automation/src/agent/agent.types.ts`):**
```ts
export type AgentActionType = 'reply' | 'schedule_post';
export type AgentActionStatus = 'pending' | 'approved' | 'done' | 'rejected' | 'failed';
export interface AgentActionRow {
  id:          string;
  type:        AgentActionType;
  status:      AgentActionStatus;
  thread_id:   string | null;
  payload:     Record<string, any>; // reply: {text}; schedule_post: {text, channelId, scheduledAt, scheduledPostId?}
  error:       string | null;
  created_at:  Date;
  updated_at:  Date;
  executed_at: Date | null;
}
```

**Read-only invariant (SP2 rule):** `sendMessage`/`sendFile` may appear ONLY in `agent-reply-sender.service.ts`. The poller and `AgentMtprotoClient` must remain send-free. Task 10 greps to prove it.

---

### Task 1: Migration — agent_actions + thread reply columns

**Files:** Create `database/migrations/039_agent_actions.sql`

- [ ] **Step 1: Write the migration**
```sql
CREATE TABLE IF NOT EXISTS agent_actions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type         TEXT NOT NULL CHECK (type IN ('reply','schedule_post')),
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','done','rejected','failed')),
  thread_id    UUID REFERENCES agent_dm_threads(id) ON DELETE SET NULL,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  executed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_agent_actions_status ON agent_actions (status, created_at DESC);

ALTER TABLE agent_dm_threads
  ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sent_reply TEXT;
```
- [ ] **Step 2: Commit** — `git add database/migrations/039_agent_actions.sql && git commit -m "feat(agent): agent_actions queue + thread reply columns" + trailer`

---

### Task 2: AgentActionsRepository

**Files:** Create `apps/automation/src/agent/agent-actions.repository.ts` + `...test.ts`; add the shared types to `agent.types.ts`.

- [ ] **Step 1: Write the failing test**
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentActionsRepository } from './agent-actions.repository';

function fakePool() {
  const calls: Array<{ sql: string; params: any[] }> = [];
  let rows: any[] = [];
  return { calls, setRows: (r: any[]) => { rows = r; },
    pool: { query: async (sql: string, params: any[]) => { calls.push({ sql, params }); return { rows, rowCount: rows.length }; } } as any };
}

test('create inserts type/thread/payload and returns the row', async () => {
  const { pool, calls, setRows } = fakePool();
  setRows([{ id: 'x', type: 'reply' }]);
  const repo = new AgentActionsRepository(pool);
  const row = await repo.create({ type: 'reply', threadId: 't1', payload: { text: 'hi' } });
  assert.match(calls[0].sql, /INSERT INTO agent_actions/);
  assert.equal(calls[0].params[0], 'reply');
  assert.equal(calls[0].params[1], 't1');
  assert.equal(row.id, 'x');
});

test('list filters by status when given', async () => {
  const { pool, calls } = fakePool();
  const repo = new AgentActionsRepository(pool);
  await repo.list('pending');
  assert.match(calls[0].sql, /status = \$1/);
  assert.deepEqual(calls[0].params, ['pending']);
});

test('setStatus updates status + executed_at/error patch', async () => {
  const { pool, calls } = fakePool();
  const repo = new AgentActionsRepository(pool);
  await repo.setStatus('id1', 'done', { executedAt: true });
  assert.match(calls[0].sql, /UPDATE agent_actions SET status = \$2/);
  assert.match(calls[0].sql, /executed_at = now\(\)/);
  assert.equal(calls[0].params[0], 'id1');
  assert.equal(calls[0].params[1], 'done');
});

test('countRepliesSince counts done replies in window', async () => {
  const { pool, calls, setRows } = fakePool();
  setRows([{ n: '3' }]);
  const repo = new AgentActionsRepository(pool);
  const n = await repo.countRepliesSince(24);
  assert.match(calls[0].sql, /type = 'reply'/);
  assert.match(calls[0].sql, /status = 'done'/);
  assert.equal(n, 3);
});
```
- [ ] **Step 2: Run → FAIL.** `cd apps/automation && npx tsx --test "src/agent/agent-actions.repository.test.ts"`
- [ ] **Step 3: Implement**
```ts
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import type { AgentActionRow, AgentActionStatus, AgentActionType } from './agent.types';

@Injectable()
export class AgentActionsRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async create(input: { type: AgentActionType; threadId?: string | null; payload: Record<string, any> }): Promise<AgentActionRow> {
    const { rows } = await this.pool.query<AgentActionRow>(
      `INSERT INTO agent_actions (type, thread_id, payload)
       VALUES ($1, $2, $3::jsonb) RETURNING *`,
      [input.type, input.threadId ?? null, JSON.stringify(input.payload)],
    );
    return rows[0];
  }

  async list(status?: AgentActionStatus): Promise<AgentActionRow[]> {
    if (status) {
      const { rows } = await this.pool.query<AgentActionRow>(
        `SELECT * FROM agent_actions WHERE status = $1 ORDER BY created_at DESC`, [status]);
      return rows;
    }
    const { rows } = await this.pool.query<AgentActionRow>(
      `SELECT * FROM agent_actions ORDER BY created_at DESC`);
    return rows;
  }

  async findById(id: string): Promise<AgentActionRow | null> {
    const { rows } = await this.pool.query<AgentActionRow>(`SELECT * FROM agent_actions WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  async setStatus(id: string, status: AgentActionStatus, patch: { executedAt?: boolean; error?: string } = {}): Promise<void> {
    await this.pool.query(
      `UPDATE agent_actions
         SET status = $2,
             error = $3,
             executed_at = CASE WHEN $4 THEN now() ELSE executed_at END,
             updated_at = now()
       WHERE id = $1`,
      [id, status, patch.error ?? null, patch.executedAt ?? false],
    );
  }

  /** Merge keys into the JSONB payload (e.g. record the scheduled_post id). */
  async mergePayload(id: string, extra: Record<string, any>): Promise<void> {
    await this.pool.query(
      `UPDATE agent_actions SET payload = payload || $2::jsonb, updated_at = now() WHERE id = $1`,
      [id, JSON.stringify(extra)],
    );
  }

  async countRepliesSince(hours: number): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM agent_actions
       WHERE type = 'reply' AND status = 'done' AND executed_at > now() - ($1 * interval '1 hour')`,
      [hours],
    );
    return Number(rows[0]?.n ?? 0);
  }
}
```
- [ ] **Step 4: Run → PASS (4).** Full suite green. **Step 5: Commit** `feat(agent): AgentActionsRepository (queue CRUD + reply cap count)`

---

### Task 3: AgentReplySender (the ONLY sender)

**Files:** Create `apps/automation/src/agent/agent-reply-sender.service.ts` (thin network wrapper — no unit test, like `AgentMtprotoClient`).

- [ ] **Step 1: Read** `apps/automation/src/agent/agent-mtproto.client.ts` to copy the connect/credentials/disconnect pattern + the `activeSession(secrets,'agent')` usage.
- [ ] **Step 2: Implement**
```ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { LogLevel } from 'telegram/extensions/Logger';
import { MtprotoSessionsRepository } from '../config/mtproto-sessions.repository';
import { SecretsService } from '../common/crypto/secrets.service';
import { withTimeout } from '../common/with-timeout';

/**
 * The ONLY component in the agent module that SENDS a Telegram message. Used
 * exclusively from the approve path (AgentActionsService) — never the poller,
 * never autonomously. Sends a DM reply from the agent (role='agent') account.
 */
@Injectable()
export class AgentReplySender {
  private readonly logger = new Logger(AgentReplySender.name);

  constructor(
    private readonly sessions: MtprotoSessionsRepository,
    private readonly secrets:  SecretsService,
    private readonly config:   ConfigService,
  ) {}

  async sendReply(peerId: string, peerUsername: string | null, text: string): Promise<{ ok: boolean; error?: string }> {
    if (!text?.trim()) return { ok: false, error: 'empty text' };
    const active = await this.sessions.activeSession(this.secrets, 'agent');
    if (!active) return { ok: false, error: 'no active agent session' };
    const apiId   = active.apiId  ?? Number(this.config.get('TELEGRAM_API_ID'));
    const apiHash = active.apiHash ?? this.config.get<string>('TELEGRAM_API_HASH') ?? '';
    if (!apiId || !apiHash) return { ok: false, error: 'missing api credentials' };

    const client = new TelegramClient(new StringSession(active.session), apiId, apiHash, { connectionRetries: 2 });
    client.setLogLevel(LogLevel.NONE);
    try {
      await client.connect();
      // Prefer username when present; fall back to numeric id.
      const target: any = peerUsername ? peerUsername : await client.getEntity(peerId);
      await withTimeout(client.sendMessage(target, { message: text }), 15_000, 'agent sendReply');
      return { ok: true };
    } catch (err: any) {
      const msg = err?.errorMessage ?? err?.message ?? String(err);
      this.logger.warn(`agent sendReply failed: ${msg}`);
      return { ok: false, error: msg };
    } finally {
      try { await client.disconnect(); } catch { /* ignore */ }
    }
  }
}
```
- [ ] **Step 3: Build** (`cd apps/automation && npm run build`). **Step 4: Commit** `feat(agent): AgentReplySender — guarded DM reply send (agent account)`

---

### Task 4: AgentScheduleExecutor

**Files:** Create `apps/automation/src/agent/agent-schedule.executor.ts` + `...test.ts`.

- [ ] **Step 1: Read** `apps/automation/src/scheduled-posts/scheduled-posts.types.ts` (`ComposedPost`) and `scheduled-posts.repository.ts` (`create`) to confirm the exact shape. (`Sender='bot'|'mtproto_user'`, `MediaType='none'|'photo'|'video'`, `Placement='above'|'below'`.)
- [ ] **Step 2: Write the failing test**
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentScheduleExecutor } from './agent-schedule.executor';

test('schedule builds a text ComposedPost and calls the repo', async () => {
  const created: any[] = [];
  const repo = { create: async (p: any) => { created.push(p); return { id: 'sp1' }; } } as any;
  const exec = new AgentScheduleExecutor(repo);
  const id = await exec.schedule({ channelId: 'c1', text: 'Sponsored', scheduledAt: '2030-01-01T00:00:00Z' });
  assert.equal(id, 'sp1');
  const p = created[0];
  assert.equal(p.channelId, 'c1');
  assert.equal(p.text, 'Sponsored');
  assert.equal(p.sender, 'bot');
  assert.equal(p.mediaType, 'none');
  assert.deepEqual(p.buttons, []);
  assert.equal(p.scheduledAt, '2030-01-01T00:00:00Z');
});
```
- [ ] **Step 3: Run → FAIL. Step 4: Implement**
```ts
import { Injectable } from '@nestjs/common';
import { ScheduledPostsRepository } from '../scheduled-posts/scheduled-posts.repository';
import type { ComposedPost } from '../scheduled-posts/scheduled-posts.types';

@Injectable()
export class AgentScheduleExecutor {
  constructor(private readonly posts: ScheduledPostsRepository) {}

  /** Insert a minimal text sponsored/ВП post into the existing scheduled queue. */
  async schedule(input: { channelId: string; text: string; scheduledAt: string }): Promise<string> {
    const post: ComposedPost = {
      channelId:      input.channelId,
      sender:         'bot',
      botId:          null,
      text:           input.text,
      mediaType:      'none',
      mediaUrl:       null,
      mediaPlacement: 'below',
      buttons:        [],
      scheduledAt:    input.scheduledAt,
    };
    const created = await this.posts.create(post);
    return created.id;
  }
}
```
- [ ] **Step 5: Run → PASS. Confirm `ScheduledPostsRepository` is injectable here** — it's provided by `ScheduledPostsModule`; verify whether it is exported/global. If NOT global, AgentModule must import `ScheduledPostsModule` (handle in Task 7). **Step 6: Commit** `feat(agent): AgentScheduleExecutor reuses scheduled_posts queue`

---

### Task 5: AgentActionsService (approve/reject orchestration)

**Files:** Create `apps/automation/src/agent/agent-actions.service.ts` + `...test.ts`.

- [ ] **Step 1: Write the failing test**
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentActionsService } from './agent-actions.service';

function harness(opts: { action: any; cap?: number; repliesSoFar?: number }) {
  const calls: any[] = [];
  const repo = {
    findById: async () => opts.action,
    setStatus: async (id: string, s: string, patch?: any) => { calls.push(['setStatus', id, s, patch]); },
    mergePayload: async (id: string, e: any) => { calls.push(['mergePayload', id, e]); },
    countRepliesSince: async () => opts.repliesSoFar ?? 0,
  } as any;
  const sender = { sendReply: async (...a: any[]) => { calls.push(['send', ...a]); return { ok: true }; } } as any;
  const exec = { schedule: async (p: any) => { calls.push(['schedule', p]); return 'sp1'; } } as any;
  const threads = { stampReplied: async (id: string, text: string) => { calls.push(['stamp', id, text]); } } as any;
  const config = { get: (k: string) => (k === 'AGENT_REPLY_DAILY_CAP' ? String(opts.cap ?? 20) : undefined) } as any;
  return { svc: new AgentActionsService(repo, sender, exec, threads, config), calls };
}

test('approve(reply) sends, marks done, stamps thread', async () => {
  const { svc, calls } = harness({ action: { id: 'a', type: 'reply', status: 'pending', thread_id: 't', payload: { text: 'hi' } } });
  // thread peer is looked up via threads repo in impl; here we just assert flow
  const r = await svc.approve('a');
  assert.equal(r.status, 'done');
  assert.ok(calls.some(c => c[0] === 'send'));
  assert.ok(calls.some(c => c[0] === 'setStatus' && c[2] === 'done'));
});

test('approve(reply) over the daily cap is rejected, sender NOT called', async () => {
  const { svc, calls } = harness({ action: { id: 'a', type: 'reply', status: 'pending', thread_id: 't', payload: { text: 'hi' } }, cap: 2, repliesSoFar: 2 });
  const r = await svc.approve('a');
  assert.equal(r.status, 'failed');
  assert.match(r.error ?? '', /cap/i);
  assert.ok(!calls.some(c => c[0] === 'send'));
});

test('approve(schedule_post) schedules + stores scheduled id', async () => {
  const { svc, calls } = harness({ action: { id: 'a', type: 'schedule_post', status: 'pending', thread_id: null, payload: { text: 'Ad', channelId: 'c1', scheduledAt: '2030-01-01T00:00:00Z' } } });
  const r = await svc.approve('a');
  assert.equal(r.status, 'done');
  assert.ok(calls.some(c => c[0] === 'schedule'));
  assert.ok(calls.some(c => c[0] === 'mergePayload'));
});

test('approve on a non-pending action is a no-op', async () => {
  const { svc, calls } = harness({ action: { id: 'a', type: 'reply', status: 'done', thread_id: 't', payload: { text: 'hi' } } });
  const r = await svc.approve('a');
  assert.equal(r.status, 'done');
  assert.ok(!calls.some(c => c[0] === 'send'));
});

test('reject marks rejected', async () => {
  const { svc, calls } = harness({ action: { id: 'a', type: 'reply', status: 'pending', thread_id: 't', payload: { text: 'hi' } } });
  const r = await svc.reject('a');
  assert.equal(r.status, 'rejected');
  assert.ok(calls.some(c => c[0] === 'setStatus' && c[2] === 'rejected'));
});
```
- [ ] **Step 2: Run → FAIL. Step 3: Implement.** Note: the service needs the thread's `peer_id`/`peer_username` to send a reply — add a small `threadPeer(threadId)` method to `AgentInboxRepository` (returns `{peer_id, peer_username}`), and a `stampReplied(threadId, text)` method (sets `replied_at=now(), sent_reply=$2, status='reviewed'`). Pass `AgentInboxRepository` into the service as the `threads` dependency. The test stubs `threads.stampReplied`; also stub `threads.threadPeer` in the test if your impl calls it (add it to the harness repo stub returning `{peer_id:'42', peer_username:null}`).
```ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentActionsRepository } from './agent-actions.repository';
import { AgentReplySender } from './agent-reply-sender.service';
import { AgentScheduleExecutor } from './agent-schedule.executor';
import { AgentInboxRepository } from './agent-inbox.repository';
import type { AgentActionRow } from './agent.types';

@Injectable()
export class AgentActionsService {
  private readonly logger = new Logger(AgentActionsService.name);

  constructor(
    private readonly repo:    AgentActionsRepository,
    private readonly sender:  AgentReplySender,
    private readonly exec:    AgentScheduleExecutor,
    private readonly threads: AgentInboxRepository,
    private readonly config:  ConfigService,
  ) {}

  async approve(id: string): Promise<AgentActionRow> {
    const a = await this.repo.findById(id);
    if (!a) throw new Error('action not found');
    if (a.status !== 'pending') return a; // idempotent: only pending executes

    if (a.type === 'reply') {
      const cap = Number(this.config.get('AGENT_REPLY_DAILY_CAP')) || 20;
      const sent = await this.repo.countRepliesSince(24);
      if (sent >= cap) {
        await this.repo.setStatus(id, 'failed', { error: `daily reply cap reached (${cap})` });
        return { ...a, status: 'failed', error: `daily reply cap reached (${cap})` };
      }
      const peer = a.thread_id ? await this.threads.threadPeer(a.thread_id) : null;
      if (!peer) {
        await this.repo.setStatus(id, 'failed', { error: 'no thread peer' });
        return { ...a, status: 'failed', error: 'no thread peer' };
      }
      const text = String(a.payload.text ?? '');
      const res = await this.sender.sendReply(peer.peer_id, peer.peer_username, text);
      if (!res.ok) {
        await this.repo.setStatus(id, 'failed', { error: res.error });
        return { ...a, status: 'failed', error: res.error ?? 'send failed' };
      }
      await this.repo.setStatus(id, 'done', { executedAt: true });
      if (a.thread_id) await this.threads.stampReplied(a.thread_id, text);
      return { ...a, status: 'done' };
    }

    // schedule_post
    const { text, channelId, scheduledAt } = a.payload as any;
    if (!text || !channelId || !scheduledAt) {
      await this.repo.setStatus(id, 'failed', { error: 'missing text/channelId/scheduledAt' });
      return { ...a, status: 'failed', error: 'missing fields' };
    }
    const spId = await this.exec.schedule({ channelId, text, scheduledAt });
    await this.repo.mergePayload(id, { scheduledPostId: spId });
    await this.repo.setStatus(id, 'done', { executedAt: true });
    return { ...a, status: 'done' };
  }

  async reject(id: string): Promise<AgentActionRow> {
    const a = await this.repo.findById(id);
    if (!a) throw new Error('action not found');
    if (a.status === 'pending') await this.repo.setStatus(id, 'rejected');
    return { ...a, status: a.status === 'pending' ? 'rejected' : a.status };
  }
}
```
- [ ] **Step 4: Add `threadPeer` + `stampReplied` to `AgentInboxRepository`** (with a tiny test each in the existing repo test file):
```ts
async threadPeer(id: string): Promise<{ peer_id: string; peer_username: string | null } | null> {
  const { rows } = await this.pool.query<{ peer_id: string; peer_username: string | null }>(
    `SELECT peer_id, peer_username FROM agent_dm_threads WHERE id = $1`, [id]);
  return rows[0] ?? null;
}
async stampReplied(id: string, text: string): Promise<void> {
  await this.pool.query(
    `UPDATE agent_dm_threads SET replied_at = now(), sent_reply = $2, status = 'reviewed', updated_at = now() WHERE id = $1`,
    [id, text]);
}
```
- [ ] **Step 5: Run service + repo tests → PASS. Full suite green. Step 6: Commit** `feat(agent): AgentActionsService approve/reject (cap, idempotent, thread stamp)`

---

### Task 6: API routes on AgentController

**Files:** Modify `apps/automation/src/agent/agent.controller.ts`; add `dto/create-action.dto.ts`; extend `agent.controller.test.ts`.

- [ ] **Step 1: Write the failing test** (extend the existing controller test — stub `AgentActionsRepository` + `AgentActionsService`):
```ts
test('GET actions lists by status', async () => {
  const calls: any[] = [];
  const actionsRepo = { list: async (s: any) => { calls.push(['list', s]); return [{ id: 'a' }]; } } as any;
  const actionsSvc = {} as any;
  const ctrl = makeCtrlWithActions(actionsRepo, actionsSvc);
  const r = await ctrl.actions('pending');
  assert.deepEqual(calls[0], ['list', 'pending']);
  assert.equal(r.length, 1);
});
test('POST approve calls service.approve', async () => {
  const calls: any[] = [];
  const actionsSvc = { approve: async (id: string) => { calls.push(['approve', id]); return { id, status: 'done' }; } } as any;
  const ctrl = makeCtrlWithActions({} as any, actionsSvc);
  const r = await ctrl.approveAction('a');
  assert.equal(r.status, 'done');
});
```
(Define a `makeCtrlWithActions` helper mirroring the existing controller test's construction, passing the two new deps.)
- [ ] **Step 2: Run → FAIL. Step 3: Implement.** Add `AgentActionsRepository` + `AgentActionsService` to the controller constructor. Add:
```ts
@Get('actions')
actions(@Query('status') status?: AgentActionStatus) { return this.actionsRepo.list(status); }

@Post('actions')
createAction(@Body() dto: CreateActionDto) {
  return this.actionsRepo.create({ type: dto.type, threadId: dto.threadId ?? null, payload: dto.payload });
}

@Post('actions/:id/approve')
approveAction(@Param('id') id: string) { return this.actions.approve(id); }

@Post('actions/:id/reject')
rejectAction(@Param('id') id: string) { return this.actions.reject(id); }
```
`dto/create-action.dto.ts`:
```ts
import { IsIn, IsObject, IsOptional, IsString } from 'class-validator';
export class CreateActionDto {
  @IsIn(['reply', 'schedule_post']) type!: 'reply' | 'schedule_post';
  @IsOptional() @IsString() threadId?: string;
  @IsObject() payload!: Record<string, any>;
}
```
- [ ] **Step 4: Run → PASS. Full suite green. Step 5: Commit** `feat(agent): REST routes for agent actions (list/create/approve/reject)`

---

### Task 7: Module wiring + env

**Files:** Modify `agent.module.ts`, `.env.example`.

- [ ] **Step 1:** Add `AgentActionsRepository`, `AgentReplySender`, `AgentScheduleExecutor`, `AgentActionsService` to `AgentModule.providers`. **Verify `ScheduledPostsRepository` resolves:** `grep -n "ScheduledPostsRepository" apps/automation/src/scheduled-posts/scheduled-posts.module.ts` — if it is NOT exported from a `@Global` module, add `imports: [ScheduledPostsModule]` to `AgentModule` AND ensure `ScheduledPostsModule` exports `ScheduledPostsRepository`. Read the module to decide; do not guess.
- [ ] **Step 2:** `.env.example` — under the Agent section add:
```bash
# Max DM replies the agent may send per rolling 24h (approval-gated). Default 20.
AGENT_REPLY_DAILY_CAP=20
```
- [ ] **Step 3:** `cd apps/automation && npm run build && npm test` — green. **Step 4: Commit** `feat(agent): wire SP2 providers + AGENT_REPLY_DAILY_CAP`

---

### Task 8: Dashboard API client (actions)

**Files:** Modify `apps/dashboard/src/api/agent.ts` + `api/types.ts`.

- [ ] **Step 1:** Add types `AgentAction` (`id,type,status,thread_id,payload,error,executed_at`) and `AgentActionType`/`AgentActionStatus`.
- [ ] **Step 2:** Add hooks `useAgentActions(status?)`, `useCreateAgentAction()`, `useApproveAgentAction()`, `useRejectAgentAction()` mirroring the SP1 hooks' fetch-helper style (read the file). Approve/reject/create POST to the routes; invalidate `['agent','actions']` (and `['agent','inbox']` on reply).
- [ ] **Step 3:** `pnpm --filter dashboard build` clean. **Step 4: Commit** `feat(agent): dashboard API client for actions`

---

### Task 9: Dashboard "Pending actions" UI + inbox "Queue reply"

**Files:** Modify `apps/dashboard/src/routes/app.agent.tsx`.

- [ ] **Step 1:** Add a "Pending actions" `SectionCard` above/below the inbox: `useAgentActions('pending')` → card-rows: a type Badge (`reply`=accent, `schedule_post`=neutral), the target (peer for reply / channel for schedule), an editable `<textarea>` for `payload.text` (and channel + datetime inputs for `schedule_post`), then `RowActions` with **Approve** (calls `useApproveAgentAction` with the current edited payload — for MVP, edit updates a local state and Approve is allowed only if unchanged-or-recreate; simplest: Approve sends as-stored, and an inline "Edit" re-creates the action with new text then approves). Keep it simple: render the stored text read-only-ish with an "Approve"/"Reject"; if you support inline edit, PATCH is out of scope, so on edit call createAgentAction with the new text and reject the old. Document whichever you choose in a code comment.
- [ ] **Step 2:** Inbox rows: add a "Queue reply" `TableAction` that calls `useCreateAgentAction({ type:'reply', threadId: t.id, payload:{ text: t.draft_reply ?? '' } })`. (Keep the existing reviewed/archive actions.)
- [ ] **Step 3:** `pnpm --filter dashboard build` clean. **Step 4: Commit** `feat(agent): pending-actions UI + queue-reply from inbox`

---

### Task 10: Full verification

- [ ] **Step 1:** `cd apps/automation && npm run build && npm test` — green incl. all new SP2 tests.
- [ ] **Step 2:** Dashboard `pnpm --filter dashboard build` clean.
- [ ] **Step 3: Read-only guard** — `grep -rln "sendMessage\|sendFile" apps/automation/src/agent/` must return ONLY `agent-reply-sender.service.ts`. If anything else appears, fix it.
- [ ] **Step 4:** Confirm the poller has NO path to `AgentReplySender` (it's not injected into `AgentInboxPoller`).
- [ ] **Step 5:** Feature complete; merge only on the owner's explicit go-ahead.

## Notes for the implementer
- Approve is the ONLY execution path; never call `AgentReplySender` from the poller or anywhere else.
- `schedule_post` is text-only in SP2 (media/buttons are future work).
- Keep the daily cap enforced server-side in `AgentActionsService`, not just the UI.
