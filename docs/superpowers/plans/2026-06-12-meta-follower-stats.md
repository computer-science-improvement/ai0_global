# Meta Follower Stats (Phase A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track each Meta account's follower count hourly and surface it on an account detail page that mirrors the Telegram channel "Subscribers over time" stats.

**Architecture:** A dedicated hourly cron (`MetaStatsCollectorService`) calls the existing `MetaGraphClient.verify` per active account, refreshes the account profile, and writes a follower snapshot to a new `meta_follower_history` table via `MetaFollowerHistoryRepository`. A new endpoint on the meta-accounts controller returns the series + current/delta. The dashboard adds a `/connections/meta/:accountId` detail route reusing `SubsHistoryChart` + `StatCard`, reachable by clicking an account card.

**Tech Stack:** NestJS + `@nestjs/schedule` (`@Cron`), PostgreSQL (`pg`), node:test via `npx tsx --test`, React + TanStack Router/Query + recharts.

**Spec:** `docs/superpowers/specs/2026-06-12-meta-follower-stats-design.md`

**Branch:** `feat/meta-follower-stats` (already created off `feat/crosspost-all-strategies`).

**Cost/safety guard (STANDING):** build + `tsc` + unit tests ONLY. Do **not** start/restart automation, call the Graph API, or call Claude. The user restarts and verifies; migration `021` applies on their next boot.

---

## Verified facts (trust these)

- `MetaGraphClient.verify(platform, targetId, token)` → `{ username, displayName, followers, pictureUrl }`. `followers` is a number for Instagram/Facebook, `null` for Threads.
- `MetaAccountsRepository` (`src/config/meta-accounts.repository.ts`): `list()`, `findById(id)`, `markVerified(id, {username, display_name, followers, picture_url})`, `markVerifyError(id, msg)`. Row has `id, platform, account_id, token_env, target_id, username, display_name, followers, picture_url, active, last_verified_at, ...`.
- `MetaAccountsRepository` is exported from the `@Global` `ChannelConfigModule` (`src/config/config.module.ts`). `MetaGraphClient` is a provider there but NOT exported yet.
- `StatsModule` (`src/stats/stats.module.ts`) is `@Global`. `DB_POOL` (from `src/database/database.module`) and `ConfigService` (global) are injectable there. `ScheduleModule.forRoot()` is in `app.module.ts`, so `@Cron` works.
- `StatsCollectorService` pattern: `@Cron(CronExpression.EVERY_HOUR) hourly()` → `runOnce()`, a `private running` re-entrancy guard, try/catch/finally.
- Dashboard `SubsHistoryChart` takes `{ points: { at: string; subs: number }[] }`. `StatCard` takes `{ label, value, delta?, deltaTone?: 'up'|'down'|'neutral' }`.
- TanStack file routes: `channels_.$id.tsx` → `createFileRoute('/channels_/$id')`; linked via `<Link to={'/channels/$id' as any} params={{ id } as any}>`. The vite `TanStackRouterVite` plugin regenerates the route tree on dev/build when a route file is added.
- `MetaAccountsManager` (`src/components/connections/MetaAccountsManager.tsx`) renders each account as a `<div className="card">` with an identity block (`<div style={{ flex: 1, minWidth: 200 }}>` containing name/@username/followers) and an action button group (Verify/Pause/Delete).

## File Structure

**Create (automation):**
- `database/migrations/021_meta_follower_history.sql`
- `apps/automation/src/stats/meta-follower-history.repository.ts` (+ `.test.ts`)
- `apps/automation/src/stats/meta-stats-collector.service.ts` (+ `.test.ts`)
- `apps/automation/src/config/api/meta-accounts.controller.history.test.ts`

**Modify (automation):**
- `apps/automation/src/stats/stats.module.ts` — provide both new classes; export the repo.
- `apps/automation/src/config/config.module.ts` — export `MetaGraphClient`.
- `apps/automation/src/config/api/meta-accounts.controller.ts` — inject the history repo + add the endpoint.

**Create (dashboard):**
- `apps/dashboard/src/routes/connections_.meta.$accountId.tsx`

**Modify (dashboard):**
- `apps/dashboard/src/api/meta-accounts.ts` — `MetaFollowerHistory` type + `useMetaFollowerHistory`.
- `apps/dashboard/src/components/connections/MetaAccountsManager.tsx` — make the account identity block a `<Link>` to the detail.

## Verify-after notes

- Automation single test: `npx tsx --test <path>` (run from `apps/automation`).
- Automation type check: `npx tsc --noEmit -p tsconfig.json`.
- Dashboard: from `apps/dashboard`, `npx tsc --noEmit && npx vite build`.

---

### Task 1: Migration 021 — meta_follower_history

**Files:**
- Create: `database/migrations/021_meta_follower_history.sql`

No DB available during implementation; verified by review + the downstream repo SQL-shape test. Applies on the user's next boot.

- [ ] **Step 1: Write the migration**

Create `database/migrations/021_meta_follower_history.sql`:

```sql
-- 021_meta_follower_history.sql
-- Hourly follower-count snapshots per Meta account (Phase A stats), mirroring
-- tracked_subs_history for Telegram channels. Instagram/Facebook only — Threads
-- has no follower count without a gated insights scope, so it simply accrues no rows.

CREATE TABLE IF NOT EXISTS meta_follower_history (
  account_id   UUID        NOT NULL REFERENCES meta_accounts(id) ON DELETE CASCADE,
  snapshot_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  followers    INTEGER     NOT NULL,
  PRIMARY KEY (account_id, snapshot_at)
);

CREATE INDEX IF NOT EXISTS idx_meta_follower_history_account_time
  ON meta_follower_history (account_id, snapshot_at DESC);
```

- [ ] **Step 2: Verify ordering**

Run: `ls database/migrations | tail -2`
Expected: `021_meta_follower_history.sql` sorts after `020_strategy_binding_destination.sql`.

- [ ] **Step 3: Commit**

```bash
git add database/migrations/021_meta_follower_history.sql
git commit -m "feat(db): migration 021 — meta_follower_history table"
```

---

### Task 2: MetaFollowerHistoryRepository

**Files:**
- Create: `apps/automation/src/stats/meta-follower-history.repository.ts`
- Create: `apps/automation/src/stats/meta-follower-history.repository.test.ts`
- Modify: `apps/automation/src/stats/stats.module.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/automation/src/stats/meta-follower-history.repository.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetaFollowerHistoryRepository } from './meta-follower-history.repository';

function fakePool(rows: any[] = []) {
  const calls: { sql: string; params: any[] }[] = [];
  const pool = { query: async (sql: string, params: any[] = []) => { calls.push({ sql, params }); return { rows }; } };
  return { pool, calls };
}

test('insert writes account_id + followers with explicit casts', async () => {
  const { pool, calls } = fakePool();
  const repo = new MetaFollowerHistoryRepository(pool as any);
  await repo.insert('acct-1', 1234);
  assert.match(calls[0].sql, /INSERT INTO meta_follower_history/);
  // Guard against the untyped-parameter class of bug (see today's markPosted fix):
  assert.match(calls[0].sql, /\$1::uuid/);
  assert.match(calls[0].sql, /\$2::int/);
  assert.deepEqual(calls[0].params, ['acct-1', 1234]);
});

test('history orders ASC and threads from/to params (null when absent)', async () => {
  const { pool, calls } = fakePool([{ at: new Date('2026-06-01'), followers: 10 }]);
  const repo = new MetaFollowerHistoryRepository(pool as any);
  const out = await repo.history('acct-1');
  assert.match(calls[0].sql, /ORDER BY snapshot_at ASC/);
  assert.match(calls[0].sql, /\$1::uuid/);
  assert.deepEqual(calls[0].params, ['acct-1', null, null]);
  assert.deepEqual(out, [{ at: new Date('2026-06-01'), followers: 10 }]);
});

test('latestWithDelta maps the computed row', async () => {
  const { pool } = fakePool([{ followers: 100, delta24h: 5, delta7d: 20 }]);
  const repo = new MetaFollowerHistoryRepository(pool as any);
  const out = await repo.latestWithDelta('acct-1');
  assert.deepEqual(out, { followers: 100, delta24h: 5, delta7d: 20 });
});

test('latestWithDelta returns nulls when there is no history', async () => {
  const { pool } = fakePool([]);
  const repo = new MetaFollowerHistoryRepository(pool as any);
  const out = await repo.latestWithDelta('acct-1');
  assert.deepEqual(out, { followers: null, delta24h: null, delta7d: null });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test src/stats/meta-follower-history.repository.test.ts`
Expected: FAIL — `Cannot find module './meta-follower-history.repository'`.

- [ ] **Step 3: Implement the repository**

Create `apps/automation/src/stats/meta-follower-history.repository.ts`:

```ts
// meta-follower-history.repository.ts — hourly follower snapshots per Meta account.
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';

export interface FollowerPoint { at: Date; followers: number; }
export interface FollowerDelta { followers: number | null; delta24h: number | null; delta7d: number | null; }

@Injectable()
export class MetaFollowerHistoryRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async insert(accountId: string, followers: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO meta_follower_history (account_id, followers)
       VALUES ($1::uuid, $2::int)`,
      [accountId, followers],
    );
  }

  async history(accountId: string, from?: Date, to?: Date): Promise<FollowerPoint[]> {
    const { rows } = await this.pool.query<FollowerPoint>(
      `SELECT snapshot_at AS at, followers
         FROM meta_follower_history
        WHERE account_id = $1::uuid
          AND ($2::timestamptz IS NULL OR snapshot_at >= $2)
          AND ($3::timestamptz IS NULL OR snapshot_at <= $3)
        ORDER BY snapshot_at ASC`,
      [accountId, from ?? null, to ?? null],
    );
    return rows.map(r => ({ at: r.at, followers: r.followers }));
  }

  async latestWithDelta(accountId: string): Promise<FollowerDelta> {
    const { rows } = await this.pool.query(
      `WITH latest AS (
         SELECT followers FROM meta_follower_history
          WHERE account_id = $1::uuid ORDER BY snapshot_at DESC LIMIT 1),
       d1 AS (
         SELECT followers FROM meta_follower_history
          WHERE account_id = $1::uuid AND snapshot_at <= now() - interval '24 hours'
          ORDER BY snapshot_at DESC LIMIT 1),
       d7 AS (
         SELECT followers FROM meta_follower_history
          WHERE account_id = $1::uuid AND snapshot_at <= now() - interval '7 days'
          ORDER BY snapshot_at DESC LIMIT 1)
       SELECT (SELECT followers FROM latest)                              AS followers,
              (SELECT followers FROM latest) - (SELECT followers FROM d1) AS delta24h,
              (SELECT followers FROM latest) - (SELECT followers FROM d7) AS delta7d`,
      [accountId],
    );
    const r = rows[0] ?? {};
    return {
      followers: r.followers ?? null,
      delta24h:  r.delta24h ?? null,
      delta7d:   r.delta7d ?? null,
    };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/stats/meta-follower-history.repository.test.ts`
Expected: PASS — `# pass 4`.

- [ ] **Step 5: Register in StatsModule**

In `apps/automation/src/stats/stats.module.ts`:
- Add import: `import { MetaFollowerHistoryRepository } from './meta-follower-history.repository';`
- Add `MetaFollowerHistoryRepository` to the `providers` array AND to the `exports` array (so the meta-accounts controller in the config module can inject it — StatsModule is `@Global`).

- [ ] **Step 6: Type check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/stats/meta-follower-history.repository.ts \
        src/stats/meta-follower-history.repository.test.ts src/stats/stats.module.ts
git commit -m "feat(stats): MetaFollowerHistoryRepository + snapshot/query SQL"
```

---

### Task 3: MetaStatsCollectorService (hourly cron)

**Files:**
- Create: `apps/automation/src/stats/meta-stats-collector.service.ts`
- Create: `apps/automation/src/stats/meta-stats-collector.service.test.ts`
- Modify: `apps/automation/src/stats/stats.module.ts` (provide the collector)
- Modify: `apps/automation/src/config/config.module.ts` (export `MetaGraphClient`)

- [ ] **Step 1: Write the failing test**

Create `apps/automation/src/stats/meta-stats-collector.service.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetaStatsCollectorService } from './meta-stats-collector.service';

function build(over: any = {}) {
  const inserted: any[] = [];
  const verifyErrors: any[] = [];
  const accounts = {
    list: async () => over.accounts ?? [
      { id: 'a1', platform: 'instagram', target_id: 'ig1', token_env: 'IG_TOKEN', active: true },
    ],
    markVerified: async () => {},
    markVerifyError: async (id: string, msg: string) => { verifyErrors.push([id, msg]); },
  };
  const graph = { verify: over.verify ?? (async () => ({ username: 'u', displayName: 'd', followers: 500, pictureUrl: null })) };
  const history = { insert: async (id: string, f: number) => { inserted.push([id, f]); } };
  const config = { get: (k: string) => (over.env ?? { IG_TOKEN: 'tok' })[k] };
  const svc = new MetaStatsCollectorService(accounts as any, graph as any, history as any, config as any);
  return { svc, inserted, verifyErrors };
}

test('inserts a snapshot when followers is a number', async () => {
  const { svc, inserted } = build();
  const r = await svc.runOnce();
  assert.deepEqual(inserted, [['a1', 500]]);
  assert.deepEqual(r, { accounts: 1, snapshots: 1 });
});

test('inserts nothing when followers is null (e.g. Threads)', async () => {
  const { svc, inserted } = build({ verify: async () => ({ username: 'u', displayName: 'd', followers: null, pictureUrl: null }) });
  const r = await svc.runOnce();
  assert.deepEqual(inserted, []);
  assert.equal(r.snapshots, 0);
});

test('skips accounts whose token env is unset', async () => {
  const { svc, inserted } = build({ env: {} });
  const r = await svc.runOnce();
  assert.deepEqual(inserted, []);
  assert.equal(r.snapshots, 0);
});

test('a failing account does not abort the loop; error is recorded', async () => {
  const accounts = [
    { id: 'a1', platform: 'instagram', target_id: 'ig1', token_env: 'IG_TOKEN', active: true },
    { id: 'a2', platform: 'facebook',  target_id: 'fb1', token_env: 'IG_TOKEN', active: true },
  ];
  let n = 0;
  const verify = async () => { n++; if (n === 1) throw new Error('boom'); return { username: 'u', displayName: 'd', followers: 42, pictureUrl: null }; };
  const { svc, inserted, verifyErrors } = build({ accounts, verify });
  const r = await svc.runOnce();
  assert.deepEqual(inserted, [['a2', 42]]);          // second account still processed
  assert.equal(verifyErrors[0][0], 'a1');            // first account error recorded
  assert.deepEqual(r, { accounts: 2, snapshots: 1 });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test src/stats/meta-stats-collector.service.test.ts`
Expected: FAIL — `Cannot find module './meta-stats-collector.service'`.

- [ ] **Step 3: Implement the collector**

Create `apps/automation/src/stats/meta-stats-collector.service.ts`:

```ts
// meta-stats-collector.service.ts — hourly follower snapshots for Meta accounts.
// Mirrors StatsCollectorService. Reuses MetaGraphClient.verify (which already
// returns follower counts for IG/FB) and refreshes the account profile as a
// free side benefit. Threads returns followers=null → no snapshot.
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MetaAccountsRepository } from '../config/meta-accounts.repository';
import { MetaGraphClient } from '../config/meta-graph.client';
import { MetaFollowerHistoryRepository } from './meta-follower-history.repository';

@Injectable()
export class MetaStatsCollectorService {
  private readonly logger = new Logger(MetaStatsCollectorService.name);
  private running = false;

  constructor(
    private readonly accounts: MetaAccountsRepository,
    private readonly graph:    MetaGraphClient,
    private readonly history:  MetaFollowerHistoryRepository,
    private readonly config:   ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async hourly(): Promise<void> { await this.runOnce(); }

  async runOnce(): Promise<{ accounts: number; snapshots: number }> {
    if (this.running) {
      this.logger.warn('Meta collector already running — skip');
      return { accounts: 0, snapshots: 0 };
    }
    this.running = true;
    let n = 0;
    let snaps = 0;
    try {
      const active = (await this.accounts.list()).filter(a => a.active);
      for (const a of active) {
        n++;
        try {
          const token = this.config.get<string>(a.token_env);
          if (!token) {
            this.logger.debug(`Meta collector: ${a.token_env} not set — skipping ${a.id}`);
            continue;
          }
          const r = await this.graph.verify(a.platform, a.target_id, token);
          await this.accounts.markVerified(a.id, {
            username: r.username, display_name: r.displayName,
            followers: r.followers, picture_url: r.pictureUrl,
          });
          if (typeof r.followers === 'number') {
            await this.history.insert(a.id, r.followers);
            snaps++;
          }
        } catch (err: any) {
          this.logger.warn(`Meta collector: account ${a.id} failed: ${err.message}`);
          try { await this.accounts.markVerifyError(a.id, err.message); } catch { /* best-effort */ }
        }
      }
      this.logger.log(`Meta collector: ${snaps} follower snapshots across ${n} accounts`);
      return { accounts: n, snapshots: snaps };
    } finally {
      this.running = false;
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/stats/meta-stats-collector.service.test.ts`
Expected: PASS — `# pass 4`.

- [ ] **Step 5: Wire DI**

In `apps/automation/src/stats/stats.module.ts`: import `MetaStatsCollectorService` and add it to `providers` (not exports — it's a self-running cron).

In `apps/automation/src/config/config.module.ts`: add `MetaGraphClient` to the `exports` array (it's already imported + a provider). This lets the collector (in the `@Global` StatsModule) inject it.

- [ ] **Step 6: Type check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/stats/meta-stats-collector.service.ts \
        src/stats/meta-stats-collector.service.test.ts \
        src/stats/stats.module.ts src/config/config.module.ts
git commit -m "feat(stats): hourly MetaStatsCollectorService (follower snapshots)"
```

---

### Task 4: Follower-history API endpoint

**Files:**
- Modify: `apps/automation/src/config/api/meta-accounts.controller.ts`
- Create: `apps/automation/src/config/api/meta-accounts.controller.history.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/automation/src/config/api/meta-accounts.controller.history.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetaAccountsController } from './meta-accounts.controller';

function make(over: any = {}) {
  const accounts = { findById: async (id: string) => (over.account === undefined ? { id, platform: 'instagram' } : over.account) };
  const graph = {};
  const env = { get: () => 'tok' };
  const history = {
    history: async () => over.points ?? [{ at: new Date('2026-06-01T00:00:00Z'), followers: 100 }],
    latestWithDelta: async () => over.summary ?? { followers: 100, delta24h: 5, delta7d: 20 },
  };
  // Constructor order: accounts, graph, env, history (history added as the 4th param)
  return new MetaAccountsController(accounts as any, graph as any, env as any, history as any);
}

test('follower-history returns current/delta/points shape', async () => {
  const c = make();
  const out = await c.followerHistory('acct-1');
  assert.equal(out.accountId, 'acct-1');
  assert.equal(out.current, 100);
  assert.equal(out.delta24h, 5);
  assert.equal(out.delta7d, 20);
  assert.deepEqual(out.points, [{ at: new Date('2026-06-01T00:00:00Z'), followers: 100 }]);
});

test('follower-history 404s for an unknown account', async () => {
  const c = make({ account: null });
  await assert.rejects(() => c.followerHistory('nope'), /not found/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test src/config/api/meta-accounts.controller.history.test.ts`
Expected: FAIL — controller has no `history` param / no `followerHistory` method.

- [ ] **Step 3: Implement the endpoint**

In `apps/automation/src/config/api/meta-accounts.controller.ts`:
- Add imports: `Query` is already imported? It is NOT — add `Query` to the `@nestjs/common` import list. Add `import { MetaFollowerHistoryRepository } from '../../stats/meta-follower-history.repository';`.
- Add `private readonly history: MetaFollowerHistoryRepository,` as the LAST constructor parameter (after `env`).
- Add this method (place it after `list()`):

```ts
  @Get(':id/follower-history')
  async followerHistory(
    @Param('id') id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const acc = await this.accounts.findById(id);
    if (!acc) throw new NotFoundException(`Meta account ${id} not found`);
    const fromD = from ? new Date(from) : undefined;
    const toD   = to   ? new Date(to)   : undefined;
    const [points, summary] = await Promise.all([
      this.history.history(id, fromD, toD),
      this.history.latestWithDelta(id),
    ]);
    return {
      accountId: id,
      current:  summary.followers,
      delta24h: summary.delta24h,
      delta7d:  summary.delta7d,
      points:   points.map(p => ({ at: p.at, followers: p.followers })),
    };
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/config/api/meta-accounts.controller.history.test.ts`
Expected: PASS — `# pass 2`.

- [ ] **Step 5: Type check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/config/api/meta-accounts.controller.ts \
        src/config/api/meta-accounts.controller.history.test.ts
git commit -m "feat(api): GET /api/meta-accounts/:id/follower-history"
```

---

### Task 5: Dashboard — account detail page + clickable cards

**Files:**
- Modify: `apps/dashboard/src/api/meta-accounts.ts`
- Create: `apps/dashboard/src/routes/connections_.meta.$accountId.tsx`
- Modify: `apps/dashboard/src/components/connections/MetaAccountsManager.tsx`

No dashboard unit runner — verify with `tsc` + `vite build` + a Cyrillic grep (UI is English-only).

- [ ] **Step 1: Add the API hook + type**

In `apps/dashboard/src/api/meta-accounts.ts`, append:

```ts
export interface MetaFollowerHistory {
  accountId: string;
  current:   number | null;
  delta24h:  number | null;
  delta7d:   number | null;
  points:    { at: string; followers: number }[];
}

export function useMetaFollowerHistory(id: string) {
  return useQuery({
    queryKey: ['meta-follower-history', id],
    queryFn:  () => api<MetaFollowerHistory>(`/api/meta-accounts/${id}/follower-history`),
    enabled:  !!id,
  });
}
```

- [ ] **Step 2: Create the detail route**

Create `apps/dashboard/src/routes/connections_.meta.$accountId.tsx`:

```tsx
import { createFileRoute, Link } from '@tanstack/react-router';
import { useMetaAccounts, useMetaFollowerHistory } from '../api/meta-accounts';
import { SubsHistoryChart } from '../components/SubsHistoryChart';
import { StatCard } from '../components/ui/StatCard';
import { Icon } from '../components/Icon';

export const Route = createFileRoute('/connections_/meta/$accountId')({ component: MetaAccountDetailPage });

function fmtDelta(n: number | null): { text: string; tone: 'up' | 'down' | 'neutral' } {
  if (n == null) return { text: '—', tone: 'neutral' };
  if (n > 0) return { text: `+${n.toLocaleString()}`, tone: 'up' };
  if (n < 0) return { text: n.toLocaleString(), tone: 'down' };
  return { text: '0', tone: 'neutral' };
}

function MetaAccountDetailPage() {
  const { accountId } = Route.useParams();
  const acc = useMetaAccounts().data?.find(a => a.id === accountId);
  const histQ = useMetaFollowerHistory(accountId);

  const d24 = fmtDelta(histQ.data?.delta24h ?? null);
  const d7  = fmtDelta(histQ.data?.delta7d ?? null);
  const points = histQ.data?.points ?? [];

  return (
    <div>
      <Link to={'/connections/meta' as any} className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>
        ← Back to Meta accounts
      </Link>

      <header style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '12px 0 24px' }}>
        {acc?.picture_url
          ? <img src={acc.picture_url} alt="" width={44} height={44} style={{ borderRadius: 10, objectFit: 'cover' }} />
          : <span style={{ display: 'inline-flex', width: 44, height: 44, borderRadius: 10, background: 'var(--color-surface-1)', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={(acc?.platform ?? 'instagram') as any} size={20} />
            </span>}
        <div>
          <h1 className="text-display-md" style={{ margin: 0 }}>{acc?.display_name ?? acc?.account_id ?? accountId}</h1>
          <p className="text-caption" style={{ margin: '4px 0 0', color: 'var(--color-ink-muted)' }}>
            {acc?.username ? `@${acc.username}` : acc?.platform ?? ''}
          </p>
        </div>
      </header>

      <div className="grid-stats" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 24 }}>
        <StatCard label="Followers" value={histQ.data?.current != null ? histQ.data.current.toLocaleString() : '—'} />
        <StatCard label="Δ 24h" value={d24.text} deltaTone={d24.tone} />
        <StatCard label="Δ 7d"  value={d7.text}  deltaTone={d7.tone} />
      </div>

      <h2 className="text-eyebrow" style={{ margin: '0 0 10px' }}>Followers over time</h2>
      {points.length > 0
        ? <SubsHistoryChart points={points.map(p => ({ at: p.at, subs: p.followers }))} />
        : <div className="card" style={{ textAlign: 'center', padding: 40 }}>
            <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)', margin: 0 }}>
              No follower data yet — collected hourly for Instagram & Facebook (Threads needs insights access).
            </p>
          </div>}
    </div>
  );
}
```

(`Icon` supports the platform names `instagram`/`facebook`/`threads` — they're already used by the strategies platform glyphs. Confirm `grid-stats` exists in `index.css`; if not, the inline `gridTemplateColumns` still applies. Keep the inline grid for safety.)

- [ ] **Step 3: Make account cards clickable**

In `apps/dashboard/src/components/connections/MetaAccountsManager.tsx`:
- Add `import { Link } from '@tanstack/react-router';` at the top.
- In the account card, wrap the identity block (`<div style={{ flex: 1, minWidth: 200 }}>…</div>` — the one containing the name/@username/followers) in a `<Link>` to the detail, keeping the action buttons OUTSIDE the link:

```tsx
<Link
  to={'/connections/meta/$accountId' as any}
  params={{ accountId: a.id } as any}
  style={{ flex: 1, minWidth: 200, textDecoration: 'none', color: 'inherit' }}
>
  {/* the existing identity markup (name / @username / followers / token line) */}
</Link>
```

Read the file first to see the exact identity `<div>` and move its children under the `Link` (replace the wrapping `<div style={{ flex: 1, minWidth: 200 }}>` with the `<Link …>`). Do NOT wrap the `<div style={{ display: 'inline-flex', gap: 6 }}>` action group.

- [ ] **Step 4: Type check + build**

Run (from `apps/dashboard`): `npx tsc --noEmit && npx vite build`
Expected: success (the TanStack vite plugin regenerates the route tree to include the new route).

- [ ] **Step 5: Cyrillic guard**

Run (from `apps/dashboard`): `grep -RnP "[\x{0400}-\x{04FF}]" src/routes/connections_.meta.\$accountId.tsx src/components/connections/MetaAccountsManager.tsx src/api/meta-accounts.ts || echo clean`
Expected: `clean`.

- [ ] **Step 6: Commit**

```bash
git add src/api/meta-accounts.ts src/routes/connections_.meta.\$accountId.tsx \
        src/components/connections/MetaAccountsManager.tsx
git commit -m "feat(dashboard): Meta account detail page with follower-over-time chart"
```

---

### Task 6: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Automation suite + tsc**

Run (from `apps/automation`): `npx tsx --test "src/**/*.test.ts"` then `npx tsc --noEmit -p tsconfig.json`
Expected: all pass, `# fail 0`; tsc clean.

- [ ] **Step 2: Dashboard build**

Run (from `apps/dashboard`): `npx tsc --noEmit && npx vite build`
Expected: success.

- [ ] **Step 3: Final commit (if fixups were needed)**

```bash
git add -A && git commit -m "test: meta follower stats — full-suite verification" || echo "nothing to commit"
```

---

## Manual smoke test (USER performs)

After merge + restart:
1. Ensure `INSTAGRAM_TOKEN` / `FACEBOOK_PAGE_TOKEN` are set and the IG/FB accounts are verified + active.
2. Wait for the hourly `MetaStatsCollectorService` tick (or restart to trigger a boot-time pass if one is wired), then check `meta_follower_history` has rows for the IG/FB accounts.
3. In the dashboard: Connections · Meta → click an account → see the "Followers over time" chart + current/Δ stats. Threads accounts show the empty state.

## Post-implementation

Use `superpowers:finishing-a-development-branch` to integrate `feat/meta-follower-stats` (likely merge into `feat/crosspost-all-strategies`, consistent with the prior features).
