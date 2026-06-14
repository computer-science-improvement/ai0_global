# Meta Account Insights (Phase B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture daily account-level Meta insights (reach, impressions, profile views) per account over time and chart them on the existing Meta account detail page.

**Architecture:** Mirror the Phase A follower-stats pipeline — a daily-insights table + repository, a `MetaGraphClient.fetchInsights` that normalizes per-platform metrics (fetched **one call per metric** so a deprecated metric degrades to null instead of failing the whole request), an extension to the existing hourly `MetaStatsCollectorService`, an insights endpoint on the meta-accounts controller, and new chart panels on the detail page.

**Tech Stack:** NestJS + `pg`, Meta Graph API, node:test via `npx tsx --test`, React + TanStack Query + recharts.

**Spec:** `docs/superpowers/specs/2026-06-12-meta-account-insights-design.md`
**Branch:** `feat/meta-insights` (already created off `develop`).

**Cost/safety guard (STANDING):** Build + `tsc` + unit tests ONLY. No automation restart, no live Graph calls from the build, no publishing. The user runs restarts + live smoke tests (the manual `POST /stats/meta/refresh` collects insights too).

---

## File Structure

**Create:**
- `database/migrations/022_meta_account_insights.sql` — daily insights table.
- `apps/automation/src/stats/meta-account-insights.repository.ts` — `upsertDay` + `history`.
- `apps/automation/src/stats/meta-account-insights.repository.test.ts`
- `apps/automation/src/config/meta-insights.ts` — the platform→metric MAPPING + the `MetaInsightDay` type + a pure `mergeInsightValues` helper (testable without HTTP).
- `apps/automation/src/config/meta-insights.test.ts`
- `apps/dashboard/src/components/MetaReachImpressionsChart.tsx`
- `apps/dashboard/src/components/MetaProfileViewsChart.tsx`

**Modify:**
- `apps/automation/src/config/meta-graph.client.ts` — add `fetchInsights(...)`.
- `apps/automation/src/config/meta-graph.client.test.ts` (create if absent) — `fetchInsights` extraction tests.
- `apps/automation/src/stats/meta-stats-collector.service.ts` — fetch + upsert insights in the existing loop.
- `apps/automation/src/stats/meta-stats-collector.service.test.ts` — extend.
- `apps/automation/src/stats/stats.module.ts` — provide + export `MetaAccountInsightsRepository`.
- `apps/automation/src/config/api/meta-accounts.controller.ts` — inject repo + `GET :id/insights`.
- `apps/dashboard/src/api/meta-accounts.ts` — `MetaInsightDay`/`MetaAccountInsights` types + `useMetaAccountInsights`.
- `apps/dashboard/src/routes/connections_.meta.$accountId.tsx` — render the two panels.

**Verify commands** (automation from `apps/automation`, dashboard from `apps/dashboard`):
- `npx tsx --test <file>` → `# fail 0`.
- `npx tsc --noEmit -p tsconfig.json` (automation) / `npx tsc --noEmit` (dashboard).
- `npx vite build` (dashboard).

---

### Task 1: Migration 022 — meta_account_insights

**Files:** Create `database/migrations/022_meta_account_insights.sql`

No DB during implementation (cost guard); verified structurally + by downstream unit tests. Applies on the user's next restart.

- [ ] **Step 1: Write the migration**

```sql
-- 022_meta_account_insights.sql
-- Daily account-level Meta insights (Phase B): reach / impressions / profile views.
-- One row per account per day, upserted idempotently (the current day firms up as
-- it accrues). Metrics are nullable — a platform that doesn't expose one stores NULL
-- (e.g. Threads has no reach/profile_views).
CREATE TABLE IF NOT EXISTS meta_account_insights (
  id            BIGSERIAL PRIMARY KEY,
  account_id    UUID NOT NULL REFERENCES meta_accounts(id) ON DELETE CASCADE,
  day           DATE NOT NULL,
  reach         INT,
  impressions   INT,
  profile_views INT,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, day)
);
CREATE INDEX IF NOT EXISTS idx_meta_insights_account_day
  ON meta_account_insights (account_id, day DESC);
```

- [ ] **Step 2: Verify ordering** — `ls database/migrations | tail -3` → `022_meta_account_insights.sql` sorts last after `021_meta_follower_history.sql`.

- [ ] **Step 3: Commit**

```bash
git add database/migrations/022_meta_account_insights.sql
git commit -m "feat(db): migration 022 — meta_account_insights daily table"
```

---

### Task 2: Insights mapping + merge helper (pure, testable)

**Files:**
- Create `apps/automation/src/config/meta-insights.ts`
- Create `apps/automation/src/config/meta-insights.test.ts`

This isolates the platform→metric mapping and the per-day merge as pure functions, so `fetchInsights` (Task 3) only does HTTP + delegates parsing here.

- [ ] **Step 1: Write the failing test**

Create `apps/automation/src/config/meta-insights.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INSIGHT_METRICS, mergeInsightValues, type MetaInsightDay } from './meta-insights';

test('mapping exposes the normalized metric → platform-metric per platform', () => {
  assert.deepEqual(INSIGHT_METRICS.instagram, { reach: 'reach', impressions: 'impressions', profileViews: 'profile_views' });
  assert.deepEqual(INSIGHT_METRICS.facebook, { reach: 'page_impressions_unique', impressions: 'page_impressions', profileViews: 'page_views_total' });
  assert.deepEqual(INSIGHT_METRICS.threads, { impressions: 'views' });
});

test('mergeInsightValues folds per-metric day series into one row per day', () => {
  const byMetric = {
    reach: [{ day: '2026-06-10', value: 100 }, { day: '2026-06-11', value: 120 }],
    impressions: [{ day: '2026-06-11', value: 300 }],
    profileViews: [{ day: '2026-06-10', value: 5 }],
  };
  const out = mergeInsightValues(byMetric);
  const expected: MetaInsightDay[] = [
    { day: '2026-06-10', reach: 100, impressions: null, profileViews: 5 },
    { day: '2026-06-11', reach: 120, impressions: 300, profileViews: null },
  ];
  assert.deepEqual(out, expected);
});

test('mergeInsightValues sorts by day ascending and tolerates missing metrics', () => {
  const out = mergeInsightValues({ impressions: [{ day: '2026-06-12', value: 9 }, { day: '2026-06-09', value: 4 }] });
  assert.deepEqual(out.map(d => d.day), ['2026-06-09', '2026-06-12']);
  assert.equal(out[0].reach, null);
  assert.equal(out[0].profileViews, null);
});
```

- [ ] **Step 2: Run → FAIL** (`Cannot find module './meta-insights'`)

Run: `npx tsx --test src/config/meta-insights.test.ts`

- [ ] **Step 3: Implement**

Create `apps/automation/src/config/meta-insights.ts`:

```ts
// meta-insights.ts — normalized account-insight metrics + parsing helpers.
// Normalized keys: reach | impressions | profileViews. Each platform maps them to
// its own Graph metric names. Threads only exposes an impressions-equivalent.
import type { MetaPlatform } from './meta-accounts.repository';

export type InsightKey = 'reach' | 'impressions' | 'profileViews';

export interface MetaInsightDay {
  day:          string;          // 'YYYY-MM-DD'
  reach:        number | null;
  impressions:  number | null;
  profileViews: number | null;
}

/** normalized key → the platform's Graph metric name. Missing key = unsupported. */
export const INSIGHT_METRICS: Record<MetaPlatform, Partial<Record<InsightKey, string>>> = {
  instagram: { reach: 'reach', impressions: 'impressions', profileViews: 'profile_views' },
  facebook:  { reach: 'page_impressions_unique', impressions: 'page_impressions', profileViews: 'page_views_total' },
  threads:   { impressions: 'views' },
};

export interface DayValue { day: string; value: number }

/** Fold per-normalized-metric day series into one normalized row per day. */
export function mergeInsightValues(byMetric: Partial<Record<InsightKey, DayValue[]>>): MetaInsightDay[] {
  const days = new Map<string, MetaInsightDay>();
  const ensure = (day: string): MetaInsightDay => {
    let row = days.get(day);
    if (!row) { row = { day, reach: null, impressions: null, profileViews: null }; days.set(day, row); }
    return row;
  };
  for (const key of ['reach', 'impressions', 'profileViews'] as InsightKey[]) {
    for (const dv of byMetric[key] ?? []) ensure(dv.day)[key] = dv.value;
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** Parse a Graph insights metric response body into per-day values.
 *  Shape: { data: [ { name, period, values: [ { value, end_time }, ... ] } ] }. */
export function parseMetricValues(body: any): DayValue[] {
  const series = body?.data?.[0]?.values;
  if (!Array.isArray(series)) return [];
  const out: DayValue[] = [];
  for (const v of series) {
    const day = typeof v?.end_time === 'string' ? v.end_time.slice(0, 10) : null;
    const value = typeof v?.value === 'number' ? v.value : null;
    if (day && value != null) out.push({ day, value });
  }
  return out;
}
```

(Add a `parseMetricValues` test too:)

```ts
test('parseMetricValues extracts {day,value} from a Graph metric body', () => {
  const body = { data: [{ name: 'reach', period: 'day', values: [
    { value: 100, end_time: '2026-06-10T07:00:00+0000' },
    { value: 120, end_time: '2026-06-11T07:00:00+0000' },
  ] }] };
  assert.deepEqual(parseMetricValues(body), [{ day: '2026-06-10', value: 100 }, { day: '2026-06-11', value: 120 }]);
});
test('parseMetricValues returns [] for an empty/odd body', () => {
  assert.deepEqual(parseMetricValues({}), []);
  assert.deepEqual(parseMetricValues({ data: [{ values: 'nope' }] }), []);
});
```
(Import `parseMetricValues` in the test's import line.)

- [ ] **Step 4: Run → PASS** (`npx tsx --test src/config/meta-insights.test.ts`)
- [ ] **Step 5: Type check** — `npx tsc --noEmit -p tsconfig.json`
- [ ] **Step 6: Commit**

```bash
git add src/config/meta-insights.ts src/config/meta-insights.test.ts
git commit -m "feat(meta): normalized insight metric mapping + parse/merge helpers"
```

---

### Task 3: MetaGraphClient.fetchInsights

**Files:**
- Modify `apps/automation/src/config/meta-graph.client.ts`
- Create `apps/automation/src/config/meta-graph.client.test.ts`

Fetches **one Graph call per supported metric** (so a deprecated metric — e.g. IG `impressions` — degrades to null instead of 400-ing the whole request), parses via Task 2 helpers, merges to `MetaInsightDay[]`.

- [ ] **Step 1: Write the failing test**

Create `apps/automation/src/config/meta-graph.client.test.ts`:

```ts
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { MetaGraphClient } from './meta-graph.client';

function client() {
  const config = { get: (k: string) => ({ META_GRAPH_VERSION: 'v21.0', THREADS_GRAPH_VERSION: 'v1.0', FETCH_TIMEOUT: '15000' } as any)[k] };
  return new MetaGraphClient(config as any);
}

function valuesBody(name: string, pairs: [string, number][]) {
  return { data: [{ name, period: 'day', values: pairs.map(([end_time, value]) => ({ value, end_time })) }] };
}

test('instagram: per-metric calls merge into normalized days; a failing metric → null', async () => {
  mock.method(axios, 'get', async (url: string, opts: any) => {
    const metric = opts.params.metric;
    if (metric === 'reach')        return { data: valuesBody('reach', [['2026-06-10T07:00:00+0000', 100]]) };
    if (metric === 'profile_views')return { data: valuesBody('profile_views', [['2026-06-10T07:00:00+0000', 5]]) };
    if (metric === 'impressions')  throw new Error('metric impressions is deprecated'); // isolated → null
    throw new Error('unexpected metric ' + metric);
  });
  const out = await client().fetchInsights('instagram', 'IG1', 'tok', 7);
  assert.deepEqual(out, [{ day: '2026-06-10', reach: 100, impressions: null, profileViews: 5 }]);
});

test('threads: views maps to impressions; reach/profileViews stay null', async () => {
  mock.method(axios, 'get', async (url: string, opts: any) => {
    assert.match(url, /graph\.threads\.net/);              // threads host
    assert.match(url, /\/threads_insights$/);              // threads endpoint
    assert.equal(opts.params.metric, 'views');
    return { data: valuesBody('views', [['2026-06-10T07:00:00+0000', 42]]) };
  });
  const out = await client().fetchInsights('threads', 'TH1', 'tok', 7);
  assert.deepEqual(out, [{ day: '2026-06-10', reach: null, impressions: 42, profileViews: null }]);
});
```

- [ ] **Step 2: Run → FAIL** (`fetchInsights is not a function`)

Run: `npx tsx --test src/config/meta-graph.client.test.ts`

- [ ] **Step 3: Implement**

In `meta-graph.client.ts`, add imports at top (below the existing `MetaPlatform` import):

```ts
import { INSIGHT_METRICS, mergeInsightValues, parseMetricValues, type InsightKey, type MetaInsightDay, type DayValue } from './meta-insights';
```

Add the method to the class (after `verify`):

```ts
  /**
   * Daily account insights for the last `sinceDays`, normalized to
   * reach/impressions/profileViews. One Graph call per supported metric so a
   * single deprecated/unsupported metric degrades to null instead of 400-ing the
   * whole request. A whole-metric failure logs nothing here — it's swallowed to
   * null; a caller (collector) isolates account-level failures. Errors are token
   * redacted if they ever surface.
   */
  async fetchInsights(platform: MetaPlatform, targetId: string, token: string, sinceDays = 30): Promise<MetaInsightDay[]> {
    if (!token || !targetId) return [];
    const isThreads = platform === 'threads';
    const base = isThreads ? 'https://graph.threads.net' : 'https://graph.facebook.com';
    const ver  = isThreads ? this.threadsVersion : this.version;
    const edge = isThreads ? 'threads_insights' : 'insights';
    const until = Math.floor(Date.now() / 1000);
    const since = until - sinceDays * 86_400;

    const metrics = INSIGHT_METRICS[platform];
    const byMetric: Partial<Record<InsightKey, DayValue[]>> = {};
    for (const key of Object.keys(metrics) as InsightKey[]) {
      const metric = metrics[key]!;
      try {
        const res = await axios.get(`${base}/${ver}/${encodeURIComponent(targetId)}/${edge}`, {
          params: { metric, period: 'day', since, until, access_token: token },
          timeout: this.timeout,
        });
        byMetric[key] = parseMetricValues(res.data);
      } catch {
        // metric unavailable on this platform/version → leave it null for all days
      }
    }
    return mergeInsightValues(byMetric);
  }
```

- [ ] **Step 4: Run → PASS** (`npx tsx --test src/config/meta-graph.client.test.ts`)
- [ ] **Step 5: Type check** — `npx tsc --noEmit -p tsconfig.json`
- [ ] **Step 6: Commit**

```bash
git add src/config/meta-graph.client.ts src/config/meta-graph.client.test.ts
git commit -m "feat(meta): MetaGraphClient.fetchInsights (per-metric, graceful null)"
```

---

### Task 4: MetaAccountInsightsRepository

**Files:**
- Create `apps/automation/src/stats/meta-account-insights.repository.ts`
- Create `apps/automation/src/stats/meta-account-insights.repository.test.ts`
- Modify `apps/automation/src/stats/stats.module.ts`

- [ ] **Step 1: Write the failing test** (uses a fake pool capturing SQL + params)

Create `apps/automation/src/stats/meta-account-insights.repository.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetaAccountInsightsRepository } from './meta-account-insights.repository';

function repo(queryImpl: (sql: string, params: any[]) => any) {
  const pool = { query: async (sql: string, params: any[]) => queryImpl(sql, params) };
  return new MetaAccountInsightsRepository(pool as any);
}

test('upsertDay inserts with ON CONFLICT update and binds metrics in order', async () => {
  let captured: { sql: string; params: any[] } | null = null;
  const r = repo((sql, params) => { captured = { sql, params }; return { rows: [] }; });
  await r.upsertDay('acc-1', '2026-06-10', { reach: 100, impressions: 300, profileViews: 5 });
  assert.match(captured!.sql, /INSERT INTO meta_account_insights/);
  assert.match(captured!.sql, /ON CONFLICT \(account_id, day\) DO UPDATE/);
  assert.deepEqual(captured!.params, ['acc-1', '2026-06-10', 100, 300, 5]);
});

test('history returns normalized rows ordered by day', async () => {
  const r = repo((sql, params) => {
    assert.match(sql, /FROM meta_account_insights/);
    assert.equal(params[0], 'acc-1');
    return { rows: [
      { day: '2026-06-10', reach: 100, impressions: null, profile_views: 5 },
      { day: '2026-06-11', reach: 120, impressions: 300, profile_views: null },
    ] };
  });
  const out = await r.history('acc-1');
  assert.deepEqual(out, [
    { day: '2026-06-10', reach: 100, impressions: null, profileViews: 5 },
    { day: '2026-06-11', reach: 120, impressions: 300, profileViews: null },
  ]);
});
```

- [ ] **Step 2: Run → FAIL** (`npx tsx --test src/stats/meta-account-insights.repository.test.ts`)

- [ ] **Step 3: Implement**

Create `apps/automation/src/stats/meta-account-insights.repository.ts`:

```ts
// meta-account-insights.repository.ts — daily account insights (reach/impressions/
// profile views) per Meta account. Mirrors MetaFollowerHistoryRepository.
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import type { MetaInsightDay } from '../config/meta-insights';

@Injectable()
export class MetaAccountInsightsRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async upsertDay(
    accountId: string,
    day: string,
    m: { reach: number | null; impressions: number | null; profileViews: number | null },
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO meta_account_insights (account_id, day, reach, impressions, profile_views)
       VALUES ($1::uuid, $2::date, $3, $4, $5)
       ON CONFLICT (account_id, day) DO UPDATE
         SET reach = EXCLUDED.reach,
             impressions = EXCLUDED.impressions,
             profile_views = EXCLUDED.profile_views,
             captured_at = now()`,
      [accountId, day, m.reach, m.impressions, m.profileViews],
    );
  }

  async history(accountId: string, from?: Date, to?: Date): Promise<MetaInsightDay[]> {
    const { rows } = await this.pool.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, reach, impressions, profile_views
         FROM meta_account_insights
        WHERE account_id = $1::uuid
          AND ($2::date IS NULL OR day >= $2)
          AND ($3::date IS NULL OR day <= $3)
        ORDER BY day ASC`,
      [accountId, from ?? null, to ?? null],
    );
    return rows.map((r: any) => ({
      day: r.day, reach: r.reach, impressions: r.impressions, profileViews: r.profile_views,
    }));
  }
}
```

- [ ] **Step 4: Run → PASS**

- [ ] **Step 5: Wire into `StatsModule`**

In `apps/automation/src/stats/stats.module.ts`:
- Add import: `import { MetaAccountInsightsRepository } from './meta-account-insights.repository';`
- Add `MetaAccountInsightsRepository,` to the `providers` array.
- Add `MetaAccountInsightsRepository` to the `exports` array (so the meta-accounts controller in `ChannelConfigModule` can inject it — `StatsModule` is `@Global`, but only exported providers resolve cross-module).

- [ ] **Step 6: Type check** — `npx tsc --noEmit -p tsconfig.json`
- [ ] **Step 7: Commit**

```bash
git add src/stats/meta-account-insights.repository.ts \
        src/stats/meta-account-insights.repository.test.ts src/stats/stats.module.ts
git commit -m "feat(stats): MetaAccountInsightsRepository (upsertDay + history) + module wiring"
```

---

### Task 5: Collector — snapshot insights in the existing loop

**Files:**
- Modify `apps/automation/src/stats/meta-stats-collector.service.ts`
- Modify `apps/automation/src/stats/meta-stats-collector.service.test.ts`

- [ ] **Step 1: Write the failing test** (add to the existing test file)

Append a test asserting insights are fetched + upserted per active account, and that an insights failure is isolated (followers still snapshot). The collector constructor will gain a 5th param `insights`. First read the existing test to see how it constructs the collector + fakes, then add:

```ts
test('collects insights per active account and isolates insights failures', async () => {
  const calls = { upserts: [] as any[], followerInserts: [] as any[] };
  const accounts = {
    list: async () => [{ id: 'a1', platform: 'instagram', target_id: 'IG1', token_env: 'IG_TOKEN', active: true }],
    markVerified: async () => {}, markVerifyError: async () => {},
  };
  const graph = {
    verify: async () => ({ username: 'u', displayName: 'U', followers: 10, pictureUrl: null }),
    fetchInsights: async () => [{ day: '2026-06-10', reach: 100, impressions: null, profileViews: 5 }],
  };
  const history = { insert: async (id: string, f: number) => { calls.followerInserts.push([id, f]); } };
  const insights = { upsertDay: async (id: string, day: string, m: any) => { calls.upserts.push([id, day, m]); } };
  const config = { get: () => 'token-value' };
  const c = new MetaStatsCollectorService(accounts as any, graph as any, history as any, insights as any, config as any);
  const res = await c.runOnce();
  assert.deepEqual(calls.followerInserts, [['a1', 10]]);
  assert.deepEqual(calls.upserts, [['a1', '2026-06-10', { reach: 100, impressions: null, profileViews: 5 }]]);
  assert.equal(res.insightDays, 1);
});
```

NOTE: the existing tests construct `new MetaStatsCollectorService(accounts, graph, history, config)`. Adding the `insights` param (4th, before `config`) breaks them — update every existing `new MetaStatsCollectorService(...)` in the file to insert an `insights` fake (`{ upsertDay: async () => {} }`) as the 4th argument.

- [ ] **Step 2: Run → FAIL** (`npx tsx --test src/stats/meta-stats-collector.service.test.ts`)

- [ ] **Step 3: Implement**

In `meta-stats-collector.service.ts`:
- Add import: `import { MetaAccountInsightsRepository } from './meta-account-insights.repository';`
- Add `private readonly insights: MetaAccountInsightsRepository,` to the constructor **before** `config` (so the order is `accounts, graph, history, insights, config`).
- Change `runOnce()`'s return type to `Promise<{ accounts: number; snapshots: number; insightDays: number }>` and add `let insightDays = 0;`.
- Inside the per-account `try` block, after the existing follower snapshot (`if (typeof r.followers === 'number') { … }`), add insights collection in its **own** try/catch so an insights error doesn't fail the account:

```ts
          try {
            const days = await this.graph.fetchInsights(a.platform, a.target_id, token);
            for (const d of days) {
              await this.insights.upsertDay(a.id, d.day, { reach: d.reach, impressions: d.impressions, profileViews: d.profileViews });
              insightDays++;
            }
          } catch (err: any) {
            this.logger.warn(`Meta collector: insights for ${a.id} failed: ${err.message}`);
          }
```

- Update the summary log + return to include `insightDays`:

```ts
      this.logger.log(`Meta collector: ${snaps} follower snapshots, ${insightDays} insight-days across ${n} accounts`);
      return { accounts: n, snapshots: snaps, insightDays };
```

- [ ] **Step 4: Run → PASS**

- [ ] **Step 5: Type check** — `npx tsc --noEmit -p tsconfig.json`
- [ ] **Step 6: Commit**

```bash
git add src/stats/meta-stats-collector.service.ts src/stats/meta-stats-collector.service.test.ts
git commit -m "feat(stats): collect daily Meta insights alongside follower snapshots"
```

---

### Task 6: API endpoint — GET /api/meta-accounts/:id/insights

**Files:** Modify `apps/automation/src/config/api/meta-accounts.controller.ts`

The controller currently injects `(accounts, graph, env, history)` and has `@Get(':id/follower-history')`. Add the insights repo + endpoint, mirroring that handler.

- [ ] **Step 1: Add the import + constructor param**

Add import: `import { MetaAccountInsightsRepository } from '../../stats/meta-account-insights.repository';`
Add `private readonly insights: MetaAccountInsightsRepository,` as the LAST constructor parameter (after `history`).

- [ ] **Step 2: Add the endpoint** (after the `followerHistory` handler)

```ts
  @Get(':id/insights')
  async accountInsights(
    @Param('id') id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const acc = await this.accounts.findById(id);
    if (!acc) throw new NotFoundException(`Meta account ${id} not found`);
    const fromD = from ? new Date(from) : undefined;
    const toD   = to   ? new Date(to)   : undefined;
    const points = await this.insights.history(id, fromD, toD);
    return { accountId: id, points };
  }
```

- [ ] **Step 3: Type check** — `npx tsc --noEmit -p tsconfig.json` (no errors; `MetaAccountInsightsRepository` resolves via the exported `StatsModule`).

- [ ] **Step 4: Commit**

```bash
git add src/config/api/meta-accounts.controller.ts
git commit -m "feat(api): GET /api/meta-accounts/:id/insights"
```

---

### Task 7: Dashboard — insight panels on the detail page

**Files:**
- Modify `apps/dashboard/src/api/meta-accounts.ts`
- Create `apps/dashboard/src/components/MetaReachImpressionsChart.tsx`
- Create `apps/dashboard/src/components/MetaProfileViewsChart.tsx`
- Modify `apps/dashboard/src/routes/connections_.meta.$accountId.tsx`

No dashboard test runner — verify with `tsc` + `vite build` + Cyrillic guard.

- [ ] **Step 1: API types + hook**

In `apps/dashboard/src/api/meta-accounts.ts`, append:

```ts
export interface MetaInsightDay {
  day:          string;
  reach:        number | null;
  impressions:  number | null;
  profileViews: number | null;
}
export interface MetaAccountInsights { accountId: string; points: MetaInsightDay[]; }

export function useMetaAccountInsights(id: string) {
  return useQuery({
    queryKey: ['meta-account-insights', id],
    queryFn:  () => api<MetaAccountInsights>(`/api/meta-accounts/${id}/insights`),
    enabled:  !!id,
  });
}
```

- [ ] **Step 2: Reach + Impressions chart**

Create `apps/dashboard/src/components/MetaReachImpressionsChart.tsx` (mirror `SubsHistoryChart`'s recharts + CSS-var styling; two series, `connectNulls` so null days don't break the line):

```tsx
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';
import { format } from 'date-fns';
import type { MetaInsightDay } from '../api/meta-accounts';

export function MetaReachImpressionsChart({ points }: { points: MetaInsightDay[] }) {
  const data = points.map(p => ({ at: new Date(p.day).getTime(), reach: p.reach, impressions: p.impressions }));
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer>
        <LineChart data={data}>
          <CartesianGrid stroke="var(--color-hairline)" strokeDasharray="3 3" />
          <XAxis dataKey="at" tickFormatter={(v) => format(v, 'MMM d')} stroke="var(--color-ink-muted)" tick={{ fill: 'var(--color-ink-muted)' }} />
          <YAxis stroke="var(--color-ink-muted)" tick={{ fill: 'var(--color-ink-muted)' }} />
          <Tooltip
            contentStyle={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-hairline)', borderRadius: 10, color: 'var(--color-ink)' }}
            labelStyle={{ color: 'var(--color-ink-muted)' }}
            labelFormatter={(v) => format(v as number, 'PP')}
          />
          <Legend />
          <Line type="monotone" dataKey="reach" name="Reach" stroke="var(--color-accent)" strokeWidth={2} dot={false} connectNulls />
          <Line type="monotone" dataKey="impressions" name="Impressions" stroke="var(--color-grad-orange)" strokeWidth={2} dot={false} connectNulls />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 3: Profile views chart**

Create `apps/dashboard/src/components/MetaProfileViewsChart.tsx` (mirror `ViewsBarChart`):

```tsx
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { format } from 'date-fns';
import type { MetaInsightDay } from '../api/meta-accounts';

export function MetaProfileViewsChart({ points }: { points: MetaInsightDay[] }) {
  const data = points.map(p => ({ at: new Date(p.day).getTime(), profileViews: p.profileViews ?? 0 }));
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer>
        <BarChart data={data}>
          <CartesianGrid stroke="var(--color-hairline)" strokeDasharray="3 3" />
          <XAxis dataKey="at" tickFormatter={(v) => format(v, 'MMM d')} stroke="var(--color-ink-muted)" tick={{ fill: 'var(--color-ink-muted)' }} />
          <YAxis stroke="var(--color-ink-muted)" tick={{ fill: 'var(--color-ink-muted)' }} />
          <Tooltip
            contentStyle={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-hairline)', borderRadius: 10, color: 'var(--color-ink)' }}
            labelStyle={{ color: 'var(--color-ink-muted)' }}
            labelFormatter={(v) => format(v as number, 'PP')}
          />
          <Bar dataKey="profileViews" name="Profile views" fill="var(--color-accent)" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 4: Render panels on the detail page**

In `apps/dashboard/src/routes/connections_.meta.$accountId.tsx`:
- Add imports:
  ```tsx
  import { useMetaAccounts, useMetaFollowerHistory, useMetaAccountInsights } from '../api/meta-accounts';
  import { MetaReachImpressionsChart } from '../components/MetaReachImpressionsChart';
  import { MetaProfileViewsChart } from '../components/MetaProfileViewsChart';
  ```
  (replace the existing `useMetaAccounts, useMetaFollowerHistory` import line).
- After `const histQ = useMetaFollowerHistory(accountId);` add:
  ```tsx
  const insQ = useMetaAccountInsights(accountId);
  const insPoints = insQ.data?.points ?? [];
  const hasReach = insPoints.some(p => p.reach != null || p.impressions != null);
  const hasProfileViews = insPoints.some(p => p.profileViews != null);
  ```
- At the end of the component's JSX, before the closing `</div>`, add the panels:
  ```tsx
      <h2 className="text-eyebrow" style={{ margin: '28px 0 10px' }}>Reach &amp; impressions</h2>
      {hasReach
        ? <MetaReachImpressionsChart points={insPoints} />
        : <InsightEmpty platform={acc?.platform} />}

      <h2 className="text-eyebrow" style={{ margin: '28px 0 10px' }}>Profile views</h2>
      {hasProfileViews
        ? <MetaProfileViewsChart points={insPoints} />
        : <InsightEmpty platform={acc?.platform} />}
  ```
- Add the small empty-state helper at the bottom of the file (next to `fmtDelta`):
  ```tsx
  function InsightEmpty({ platform }: { platform?: string }) {
    return (
      <div className="card" style={{ textAlign: 'center', padding: 40 }}>
        <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)', margin: 0 }}>
          {platform === 'threads'
            ? 'Not available on Threads.'
            : 'No insight data yet — collected daily once the account has been active.'}
        </p>
      </div>
    );
  }
  ```

- [ ] **Step 5: Type check + build** (from `apps/dashboard`)

Run: `npx tsc --noEmit && npx vite build`
Expected: no TS errors, build succeeds.

- [ ] **Step 6: Cyrillic guard**

Run: `grep -RnP "[\x{0400}-\x{04FF}]" src/components/MetaReachImpressionsChart.tsx src/components/MetaProfileViewsChart.tsx src/routes/connections_.meta.\$accountId.tsx src/api/meta-accounts.ts || echo clean`
Expected: `clean`.

- [ ] **Step 7: Commit**

```bash
git add src/api/meta-accounts.ts src/components/MetaReachImpressionsChart.tsx \
        src/components/MetaProfileViewsChart.tsx 'src/routes/connections_.meta.$accountId.tsx'
git commit -m "feat(dashboard): reach/impressions + profile-views panels on Meta detail page"
```

---

### Task 8: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Automation suite + tsc** (from `apps/automation`)

Run: `npx tsx --test "src/**/*.test.ts"` → all pass, `# fail 0`.
Run: `npx tsc --noEmit -p tsconfig.json` → no errors.

- [ ] **Step 2: Dashboard** (from `apps/dashboard`)

Run: `npx tsc --noEmit && npx vite build` → success.

- [ ] **Step 3: Final commit (if any fixups)**

```bash
git add -A && git commit -m "test: Meta insights — full-suite verification" || echo "nothing to commit"
```

---

## Manual smoke test (USER performs — not the implementer)

After merge + restart:
1. Restart automation → migration `022` applies, the hourly collector now also pulls insights.
2. `curl -X POST http://localhost:<port>/stats/meta/refresh -H "X-API-Key: $STATS_API_KEY"` → returns `{ accounts, snapshots, insightDays }` with `insightDays > 0` for active IG/FB accounts.
3. Open a Meta account on `/connections/meta` → click it → "Reach & impressions" + "Profile views" panels populate (Threads shows "Not available on Threads" for reach/profile views).

---

## Post-implementation

Use `superpowers:finishing-a-development-branch`. (Per the user's standing preference this session: do NOT push; merge to `develop` only when they ask.)
