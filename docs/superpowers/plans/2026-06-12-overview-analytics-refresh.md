# Overview Remake + Analytics Meta Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Overview a Telegram + Meta command center and add a Telegram|Meta toggle to Analytics, reusing the existing Meta hooks + chart components.

**Architecture:** One backend field (`followers_delta_24h` on the meta-accounts list, via a batch repo query to avoid N+1) powers the growth numbers; the two dashboard pages are rewritten to surface Meta data using the already-built `useMetaAccounts` / `useMetaFollowerHistory` / `useMetaAccountInsights` hooks and `SubsHistoryChart` / `MetaReachImpressionsChart` / `MetaProfileViewsChart` components.

**Tech Stack:** NestJS + `pg`, node:test via `npx tsx --test`, React + TanStack Query + recharts.

**Spec:** `docs/superpowers/specs/2026-06-12-overview-analytics-refresh-design.md`
**Branch:** `feat/dashboard-overview-analytics` (already created off `feat/meta-insights`).

**Cost/safety guard (STANDING):** Build + `tsc` + unit tests ONLY. No automation restart, no live API calls, no publishing. The user runs restarts + live smoke tests.

---

## File Structure

**Modify (automation):**
- `apps/automation/src/stats/meta-follower-history.repository.ts` — add `delta24hByAccount()`.
- `apps/automation/src/stats/meta-follower-history.repository.test.ts` — test it.
- `apps/automation/src/config/api/meta-accounts.controller.ts` — list() includes `followers_delta_24h`.
- `apps/automation/src/config/api/meta-accounts.controller.history.test.ts` — update `make()` fake + add a list test.

**Modify (dashboard):**
- `apps/dashboard/src/api/types.ts` — `MetaAccount` gains `followers_delta_24h`.
- `apps/dashboard/src/routes/index.tsx` — Overview rewrite.
- `apps/dashboard/src/routes/analytics.tsx` — Analytics rewrite (toggle).

**Verify:** automation `npx tsx --test <file>` + `npx tsc --noEmit -p tsconfig.json`; dashboard `npx tsc --noEmit` + `npx vite build`; live preview.

---

### Task 1: Backend — `followers_delta_24h` on the accounts list

**Files:**
- Modify: `apps/automation/src/stats/meta-follower-history.repository.ts`
- Modify: `apps/automation/src/stats/meta-follower-history.repository.test.ts`
- Modify: `apps/automation/src/config/api/meta-accounts.controller.ts`
- Modify: `apps/automation/src/config/api/meta-accounts.controller.history.test.ts`

- [ ] **Step 1: Write the failing repo test**

In `meta-follower-history.repository.test.ts`, add (the repo injects `@Inject(DB_POOL) pool`; use a fake pool returning rows):

```ts
test('delta24hByAccount maps account_id → delta', async () => {
  const pool = { query: async (_sql: string) => ({ rows: [
    { account_id: 'a1', delta24h: 12 },
    { account_id: 'a2', delta24h: null },
  ] }) };
  const repo = new MetaFollowerHistoryRepository(pool as any);
  const m = await repo.delta24hByAccount();
  assert.equal(m.get('a1'), 12);
  assert.equal(m.get('a2'), null);
  assert.equal(m.get('missing'), undefined);
});
```

(If the test file has no imports yet for `MetaFollowerHistoryRepository`/`test`/`assert`, mirror the existing imports in that file.)

- [ ] **Step 2: Run → FAIL**

Run: `npx tsx --test src/stats/meta-follower-history.repository.test.ts`
Expected: FAIL — `delta24hByAccount is not a function`.

- [ ] **Step 3: Implement `delta24hByAccount`**

In `meta-follower-history.repository.ts`, add this method (after `latestWithDelta`):

```ts
  /**
   * One-shot 24h follower delta for EVERY account (avoids N+1 on the accounts
   * list). delta = latest followers − the nearest snapshot at-or-before 24h ago;
   * null when there's no baseline that old yet.
   */
  async delta24hByAccount(): Promise<Map<string, number | null>> {
    const { rows } = await this.pool.query<{ account_id: string; delta24h: number | null }>(
      `WITH latest AS (
         SELECT DISTINCT ON (account_id) account_id, followers
           FROM meta_follower_history ORDER BY account_id, snapshot_at DESC),
       d1 AS (
         SELECT DISTINCT ON (account_id) account_id, followers
           FROM meta_follower_history
          WHERE snapshot_at <= now() - interval '24 hours'
          ORDER BY account_id, snapshot_at DESC)
       SELECT l.account_id,
              l.followers - d.followers AS delta24h
         FROM latest l
         LEFT JOIN d1 d ON d.account_id = l.account_id`,
    );
    const m = new Map<string, number | null>();
    for (const r of rows) m.set(r.account_id, r.delta24h ?? null);
    return m;
  }
```

- [ ] **Step 4: Run → PASS**

Run: `npx tsx --test src/stats/meta-follower-history.repository.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire it into the list endpoint**

In `meta-accounts.controller.ts`, the `list()` handler currently is:

```ts
  @Get()
  async list() {
    const rows = await this.accounts.list();
    // Never return token values — only the env-var name.
    return rows.map(r => ({
      id: r.id, platform: r.platform, account_id: r.account_id,
      token_env: r.token_env, target_id: r.target_id,
      username: r.username, display_name: r.display_name,
      followers: r.followers, picture_url: r.picture_url,
      active: r.active, last_verified_at: r.last_verified_at,
      verify_error: r.verify_error, created_at: r.created_at,
    }));
  }
```

Replace it with:

```ts
  @Get()
  async list() {
    const [rows, deltas] = await Promise.all([
      this.accounts.list(),
      this.history.delta24hByAccount(),
    ]);
    // Never return token values — only the env-var name.
    return rows.map(r => ({
      id: r.id, platform: r.platform, account_id: r.account_id,
      token_env: r.token_env, target_id: r.target_id,
      username: r.username, display_name: r.display_name,
      followers: r.followers, picture_url: r.picture_url,
      followers_delta_24h: deltas.get(r.id) ?? null,
      active: r.active, last_verified_at: r.last_verified_at,
      verify_error: r.verify_error, created_at: r.created_at,
    }));
  }
```

(`this.history` is the already-injected `MetaFollowerHistoryRepository`.)

- [ ] **Step 6: Update the controller test fake + add a list test**

In `meta-accounts.controller.history.test.ts`, the `make()` helper's `history` fake needs `delta24hByAccount`. Find the `const history = {...}` and add the method:

```ts
  const history = {
    history: async () => over.points ?? [{ at: new Date('2026-06-01T00:00:00Z'), followers: 100 }],
    latestWithDelta: async () => over.summary ?? { followers: 100, delta24h: 5, delta7d: 9 },
    delta24hByAccount: async () => over.deltas ?? new Map([['acc-1', 7]]),
  };
```

(Keep whatever existing keys the fake already has — just ADD `delta24hByAccount`. Read the real fake first and merge.)

Add a list test:

```ts
test('list includes followers_delta_24h per account', async () => {
  const c = make({
    accountsList: [{ id: 'acc-1', platform: 'instagram', account_id: 'ig', token_env: 'IG_TOKEN',
      target_id: 't', username: 'u', display_name: 'U', followers: 100, picture_url: null,
      active: true, last_verified_at: null, verify_error: null, created_at: new Date() }],
    deltas: new Map([['acc-1', 7]]),
  });
  const out = await c.list() as any[];
  assert.equal(out[0].followers_delta_24h, 7);
});
```

IMPORTANT: read `make()` first — the `accounts` fake's `list()` must return the row used above. If `make()` doesn't already support an `accountsList` override, add one: `list: async () => over.accountsList ?? [...]` on the `accounts` fake. Mirror the existing override style.

- [ ] **Step 7: Run tests + tsc**

Run: `npx tsx --test src/config/api/meta-accounts.controller.history.test.ts src/stats/meta-follower-history.repository.test.ts`
Expected: all pass.
Run: `npx tsc --noEmit -p tsconfig.json` → no errors.

- [ ] **Step 8: Commit**

```bash
git add src/stats/meta-follower-history.repository.ts src/stats/meta-follower-history.repository.test.ts \
        src/config/api/meta-accounts.controller.ts src/config/api/meta-accounts.controller.history.test.ts
git commit -m "feat(api): followers_delta_24h on the meta-accounts list (batch query)"
```

---

### Task 2: Dashboard type + Overview command center

**Files:**
- Modify: `apps/dashboard/src/api/types.ts:281-295`
- Modify: `apps/dashboard/src/routes/index.tsx` (full rewrite)

No dashboard unit runner — verify with `tsc` + `vite build` + Cyrillic guard + live preview.

- [ ] **Step 1: Add `followers_delta_24h` to the `MetaAccount` type**

In `apps/dashboard/src/api/types.ts`, the interface is:

```ts
export interface MetaAccount {
  id:               string;
  platform:         MetaPlatform;
  account_id:       string;
  token_env:        string;
  target_id:        string;
  username:         string | null;
  display_name:     string | null;
  followers:        number | null;
  picture_url:      string | null;
  active:           boolean;
  last_verified_at: string | null;
  verify_error:     string | null;
  created_at:       string;
}
```

Add the field after `followers`:

```ts
  followers:           number | null;
  followers_delta_24h: number | null;
```

- [ ] **Step 2: Rewrite `index.tsx` (Overview)**

Replace the ENTIRE contents of `apps/dashboard/src/routes/index.tsx` with:

```tsx
import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import type { CSSProperties } from 'react';
import { trackingApi } from '../api/tracking';
import { useStrategies } from '../api/strategies';
import { useMetaAccounts, useRefreshMetaStats } from '../api/meta-accounts';
import { PageHeader } from '../components/ui/PageHeader';
import { StatCard } from '../components/ui/StatCard';
import { Panel } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Icon } from '../components/Icon';

export const Route = createFileRoute('/')({ component: OverviewPage });

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'accent';
const STATUS_TONE: Record<string, Tone> = { ok: 'success', error: 'danger', skipped: 'warning', running: 'neutral' };
const STATUS_LABEL: Record<string, string> = { ok: 'ok', error: 'error', skipped: 'skipped', running: 'running' };

function rel(iso: string): string {
  try { return formatDistanceToNow(new Date(iso), { addSuffix: true }); } catch { return iso; }
}

function deltaText(n: number): string {
  if (n > 0) return `+${n.toLocaleString('en-US')}`;
  if (n < 0) return n.toLocaleString('en-US');
  return '0';
}

function OverviewPage() {
  const strategiesQ = useStrategies();
  const channelsQ = useQuery({
    queryKey: ['channels', 'mine', 'overview'],
    queryFn: () => trackingApi.listChannels({ filter: 'mine', pageSize: 200 }),
  });
  const metaQ = useMetaAccounts();
  const refresh = useRefreshMetaStats();

  const strategies = strategiesQ.data ?? [];
  const channels = channelsQ.data?.items ?? [];
  const metaAccounts = metaQ.data ?? [];

  const totalSubs = channels.reduce((sum, c) => sum + (c.subsCount ?? 0), 0);
  const metaFollowers = metaAccounts.reduce((sum, a) => sum + (a.followers ?? 0), 0);
  const metaDelta24 = metaAccounts.reduce((sum, a) => sum + (a.followers_delta_24h ?? 0), 0);
  const active = strategies.filter(s => s.enabled);
  const errors = strategies.filter(s => s.last_run?.status === 'error');
  const upcoming = active
    .filter(s => s.next_run_at)
    .sort((a, b) => (a.next_run_at! < b.next_run_at! ? -1 : 1))
    .slice(0, 6);
  const recent = strategies
    .filter(s => s.last_run)
    .sort((a, b) => (b.last_run!.started_at > a.last_run!.started_at ? 1 : -1))
    .slice(0, 6);

  const cell: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderTop: '1px solid var(--color-hairline)', fontSize: 12.5 };
  const metaRow: CSSProperties = { ...cell, textDecoration: 'none', color: 'inherit' };

  return (
    <div>
      <PageHeader title="Overview" subtitle="Telegram + Meta · audience, publishing, status" />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 12 }}>
        <StatCard label="Subscribers (Telegram)" value={channelsQ.isLoading ? '…' : totalSubs.toLocaleString('en-US')} />
        <StatCard label="Followers (Meta)" value={metaQ.isLoading ? '…' : metaFollowers.toLocaleString('en-US')} />
        <StatCard label="Meta Δ 24h" value={metaQ.isLoading ? '…' : deltaText(metaDelta24)} deltaTone={metaDelta24 > 0 ? 'up' : metaDelta24 < 0 ? 'down' : 'neutral'} />
        <StatCard label="Active strategies" value={strategiesQ.isLoading ? '…' : active.length} />
        <StatCard label="Errors" value={errors.length} deltaTone={errors.length ? 'down' : 'neutral'} delta={errors.length ? 'needs attention' : undefined} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <Panel title="Upcoming runs">
          {upcoming.length === 0
            ? <p style={{ color: 'var(--color-ink-muted)', fontSize: 12.5, margin: 0 }}>No scheduled runs.</p>
            : upcoming.map(s => (
              <div key={s.id} style={cell}>
                <span style={{ color: 'var(--color-ink)' }}>{s.ext_id}</span>
                <span style={{ color: 'var(--color-ink-dim)' }}>{s.channel_key ?? ''}</span>
                <span style={{ marginLeft: 'auto', color: 'var(--color-ink-muted)' }}>{s.next_run_at ? rel(s.next_run_at) : ''}</span>
              </div>
            ))}
        </Panel>

        <Panel title="Strategy status">
          {recent.length === 0
            ? <p style={{ color: 'var(--color-ink-muted)', fontSize: 12.5, margin: 0 }}>No runs yet.</p>
            : recent.map(s => (
              <div key={s.id} style={cell}>
                <Badge tone={STATUS_TONE[s.last_run!.status] ?? 'neutral'}>{STATUS_LABEL[s.last_run!.status] ?? s.last_run!.status}</Badge>
                <span style={{ color: 'var(--color-ink)' }}>{s.ext_id}</span>
                {s.last_run!.error && <span style={{ color: 'var(--color-danger)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }} title={s.last_run!.error}>{s.last_run!.error}</span>}
                <span style={{ marginLeft: 'auto', color: 'var(--color-ink-muted)' }}>{s.last_run!.finished_at ? rel(s.last_run!.finished_at) : ''}</span>
              </div>
            ))}
        </Panel>
      </div>

      <Panel
        title="Meta accounts"
        action={
          metaAccounts.length > 0 ? (
            <button onClick={() => refresh.mutate()} disabled={refresh.isPending} className="btn-tiny" title="Fetch latest followers + insights">
              <Icon name="refresh" size={12} /> {refresh.isPending ? 'Refreshing…' : 'Refresh'}
            </button>
          ) : undefined
        }
      >
        {metaQ.isLoading
          ? <p style={{ color: 'var(--color-ink-muted)', fontSize: 12.5, margin: 0 }}>Loading…</p>
          : metaAccounts.length === 0
            ? <p style={{ color: 'var(--color-ink-muted)', fontSize: 12.5, margin: 0 }}>No Meta accounts — connect one on the Meta page.</p>
            : metaAccounts.map(a => {
                const d = a.followers_delta_24h ?? null;
                const dTone = d == null || d === 0 ? 'var(--color-ink-muted)' : d > 0 ? 'var(--color-success)' : 'var(--color-danger)';
                return (
                  <Link key={a.id} to={'/connections/meta/$accountId' as any} params={{ accountId: a.id } as any} style={metaRow}>
                    <Icon name={a.platform as any} size={14} />
                    <span style={{ color: 'var(--color-ink)' }}>{a.username ? `@${a.username}` : a.account_id}</span>
                    <span style={{ marginLeft: 'auto', color: 'var(--color-ink-muted)' }}>{a.followers != null ? `${a.followers.toLocaleString('en-US')} followers` : '—'}</span>
                    <span style={{ color: dTone, minWidth: 56, textAlign: 'right' }}>{d == null ? '' : deltaText(d)}</span>
                  </Link>
                );
              })}
      </Panel>
    </div>
  );
}
```

- [ ] **Step 3: Type check + build** (from `apps/dashboard`)

Run: `npx tsc --noEmit && npx vite build`
Expected: no TS errors, build succeeds.

- [ ] **Step 4: Cyrillic guard**

Run: `grep -RnP "[\x{0400}-\x{04FF}]" src/routes/index.tsx src/api/types.ts || echo clean`
Expected: `clean`.

- [ ] **Step 5: Commit**

```bash
git add src/api/types.ts src/routes/index.tsx
git commit -m "feat(dashboard): cross-platform Overview (Telegram + Meta command center)"
```

---

### Task 3: Analytics — Telegram | Meta toggle

**Files:**
- Modify: `apps/dashboard/src/routes/analytics.tsx` (full rewrite)

- [ ] **Step 1: Rewrite `analytics.tsx`**

Replace the ENTIRE contents of `apps/dashboard/src/routes/analytics.tsx` with:

```tsx
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { trackingApi } from '../api/tracking';
import { useMetaAccounts, useMetaFollowerHistory, useMetaAccountInsights } from '../api/meta-accounts';
import { channelOptionLabel } from '../lib/labels';
import { PageHeader } from '../components/ui/PageHeader';
import { Panel } from '../components/ui/Card';
import { Placeholder } from '../components/ui/Placeholder';
import { SubsHistoryChart } from '../components/SubsHistoryChart';
import { ViewsBarChart } from '../components/ViewsBarChart';
import { EngagementChart } from '../components/EngagementChart';
import { MetaReachImpressionsChart } from '../components/MetaReachImpressionsChart';
import { MetaProfileViewsChart } from '../components/MetaProfileViewsChart';
import { RoiPanel } from '../components/RoiPanel';

export const Route = createFileRoute('/analytics')({ component: AnalyticsPage });

type Tab = 'telegram' | 'meta';

function ChartEmpty({ note }: { note: string }) {
  return (
    <div className="card" style={{ textAlign: 'center', padding: 40 }}>
      <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)', margin: 0 }}>{note}</p>
    </div>
  );
}

function AnalyticsPage() {
  const [tab, setTab] = useState<Tab>('telegram');

  // Telegram
  const channelsQ = useQuery({
    queryKey: ['channels', 'mine', 'analytics'],
    queryFn: () => trackingApi.listChannels({ filter: 'mine', pageSize: 200 }),
  });
  const channels = channelsQ.data?.items ?? [];
  const [sel, setSel] = useState('');
  const channelId = sel || channels[0]?.id || '';
  const subsQ = useQuery({ queryKey: ['subs', channelId], queryFn: () => trackingApi.subsHistory(channelId), enabled: tab === 'telegram' && !!channelId });
  const postsQ = useQuery({ queryKey: ['posts', channelId, 'analytics'], queryFn: () => trackingApi.listPosts(channelId, 30), enabled: tab === 'telegram' && !!channelId });
  const points = subsQ.data?.points ?? [];
  const posts = postsQ.data?.items ?? [];

  // Meta
  const metaQ = useMetaAccounts();
  const metaAccounts = (metaQ.data ?? []).filter(a => a.active);
  const [metaSel, setMetaSel] = useState('');
  const metaId = metaSel || metaAccounts[0]?.id || '';
  const metaAcc = metaAccounts.find(a => a.id === metaId);
  const histQ = useMetaFollowerHistory(tab === 'meta' ? metaId : '');
  const insQ = useMetaAccountInsights(tab === 'meta' ? metaId : '');
  const followerPoints = histQ.data?.points ?? [];
  const insPoints = insQ.data?.points ?? [];
  const hasReach = insPoints.some(p => p.reach != null || p.impressions != null);
  const hasProfileViews = insPoints.some(p => p.profileViews != null);

  return (
    <div>
      <PageHeader
        title="Analytics"
        subtitle={tab === 'telegram' ? 'Telegram · my channels' : 'Meta · my accounts'}
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ display: 'inline-flex', gap: 4 }}>
              {(['telegram', 'meta'] as Tab[]).map(t => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className="btn-tiny"
                  style={{
                    border: '1px solid ' + (tab === t ? 'rgba(62, 207, 142, 0.3)' : 'transparent'),
                    background: tab === t ? 'var(--color-success-soft)' : 'transparent',
                    color: tab === t ? 'var(--color-accent)' : 'var(--color-ink-muted)',
                    textTransform: 'capitalize',
                  }}
                >
                  {t}
                </button>
              ))}
            </div>
            {tab === 'telegram' && channels.length > 0 && (
              <select className="input-field" value={channelId} onChange={e => setSel(e.target.value)} style={{ minWidth: 200 }}>
                {channels.map(c => <option key={c.id} value={c.id}>{channelOptionLabel(c)}</option>)}
              </select>
            )}
            {tab === 'meta' && metaAccounts.length > 0 && (
              <select className="input-field" value={metaId} onChange={e => setMetaSel(e.target.value)} style={{ minWidth: 200 }}>
                {metaAccounts.map(a => <option key={a.id} value={a.id}>{a.platform} — {a.username ? `@${a.username}` : a.account_id}</option>)}
              </select>
            )}
          </div>
        }
      />

      {tab === 'telegram' ? (
        !channelId ? (
          <Placeholder icon="analytics" title="No channels" note="Add your own channel (is_mine) to see analytics." />
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            <Panel title="Subscribers"><SubsHistoryChart points={points} /></Panel>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Panel title="Views"><ViewsBarChart posts={posts} /></Panel>
              <Panel title="Engagement"><EngagementChart posts={posts} /></Panel>
            </div>
            <RoiPanel channelId={channelId} />
          </div>
        )
      ) : (
        !metaId ? (
          <Placeholder icon="analytics" title="No Meta accounts" note="Connect a Meta account on the Meta page to see analytics." />
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            <Panel title="Followers over time">
              {followerPoints.length > 0
                ? <SubsHistoryChart points={followerPoints.map(p => ({ at: p.at, subs: p.followers }))} />
                : <ChartEmpty note="No follower data yet." />}
            </Panel>
            <Panel title="Reach & impressions">
              {insQ.isPending
                ? <ChartEmpty note="Loading…" />
                : hasReach
                  ? <MetaReachImpressionsChart points={insPoints} />
                  : <ChartEmpty note={metaAcc?.platform === 'threads' ? 'Not available on Threads.' : 'No insight data yet.'} />}
            </Panel>
            <Panel title="Profile views">
              {insQ.isPending
                ? <ChartEmpty note="Loading…" />
                : hasProfileViews
                  ? <MetaProfileViewsChart points={insPoints} />
                  : <ChartEmpty note={metaAcc?.platform === 'threads' ? 'Not available on Threads.' : 'No insight data yet.'} />}
            </Panel>
          </div>
        )
      )}
    </div>
  );
}
```

- [ ] **Step 2: Type check + build** (from `apps/dashboard`)

Run: `npx tsc --noEmit && npx vite build`
Expected: no TS errors, build succeeds.

- [ ] **Step 3: Cyrillic guard**

Run: `grep -RnP "[\x{0400}-\x{04FF}]" src/routes/analytics.tsx || echo clean`
Expected: `clean`.

- [ ] **Step 4: Commit**

```bash
git add src/routes/analytics.tsx
git commit -m "feat(dashboard): Analytics Telegram|Meta toggle with Meta account charts"
```

---

### Task 4: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Automation suite + tsc** (from `apps/automation`)

Run: `npx tsx --test "src/**/*.test.ts"` → all pass.
Run: `npx tsc --noEmit -p tsconfig.json` → no errors.

- [ ] **Step 2: Dashboard** (from `apps/dashboard`)

Run: `npx tsc --noEmit && npx vite build` → success.

- [ ] **Step 3: Live preview validation** (dashboard dev server on 5173)

Use the preview tools: navigate to `/` → confirm the headline cards (Subscribers / Followers / Meta Δ24h / Active strategies / Errors) and the "Meta accounts" panel render. Navigate to `/analytics` → confirm the Telegram|Meta toggle switches between the channel charts and the Meta account charts. (Backend `followers_delta_24h` needs the restarted backend to be non-null, but the UI must render with whatever the running API returns — `undefined` delta shows as blank, not a crash.)

- [ ] **Step 4: Final commit (if any fixups)**

```bash
git add -A && git commit -m "test: overview/analytics refresh — verification fixups" || echo "nothing to commit"
```

---

## Manual smoke test (USER)

After merge + restart: Overview shows real Meta follower totals + Δ24h; the Meta accounts panel lists accounts with growth; Analytics → Meta tab charts the selected account's followers/reach/impressions/profile-views.

## Post-implementation

Use `superpowers:finishing-a-development-branch`. Per the user's standing preference: do NOT push; merge to `develop` only when they ask.
```
