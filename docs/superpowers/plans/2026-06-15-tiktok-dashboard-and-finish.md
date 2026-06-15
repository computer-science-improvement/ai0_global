# TikTok Dashboard (5d-2) + Finish TikTok — Consolidated Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline, batched). Steps use `- [ ]`.

**Goal:** Build the TikTok dashboard (accounts page + Connect button + reworked binding form) and merge the entire TikTok branch chain (5b→5c→5d-1→5d-2) into `develop`, finishing the TikTok integration.

**Architecture:** Mirror the Meta dashboard for TikTok accounts; rework `AddStrategyModal` to Destination→Type with a platform-filtered Type list (pure helper); then a single linear merge of the stacked TikTok branches into `develop`, verified end-to-end.

**Tech Stack:** React + TanStack Router/Query, NestJS backend (already built), `tsc` + `vite build` + `preview` (dashboard has no unit-test runner), `npm test` (automation).

**Branch:** `feat/tiktok-dashboard` (off `feat/tiktok-oauth` = 5a..5d-1). Spec: `docs/superpowers/specs/2026-06-15-tiktok-dashboard-design.md`.

**Verify dashboard from** `apps/dashboard`: `npx tsc -b` then `npm run build`. **Verify automation from** `apps/automation`: `npm test`.

---

## Task 1: API client — `tiktok-accounts.ts` + `useStrategyTypes` + create-input type

**Files:** Create `apps/dashboard/src/api/tiktok-accounts.ts`; Modify `apps/dashboard/src/api/strategies.ts`.

- [ ] **Step 1: Create `apps/dashboard/src/api/tiktok-accounts.ts`**

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export interface TikTokAccount {
  id: string; open_id: string; username: string | null; display_name: string | null;
  avatar_url: string | null; active: boolean; last_refreshed_at: string | null;
  refresh_error: string | null; created_at: string;
}

const KEY = ['tiktok-accounts'];

export function useTikTokAccounts() {
  return useQuery({ queryKey: KEY, queryFn: () => api<TikTokAccount[]>('/api/tiktok-accounts') });
}

export function useToggleTikTokAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      api<{ ok: boolean }>(`/api/tiktok-accounts/${id}`, { method: 'PATCH', body: JSON.stringify({ active }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useDeleteTikTokAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/tiktok-accounts/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

/** Begin the OAuth flow: ask the API for the authorize URL, then navigate to it. */
export async function startTikTokOAuth(): Promise<void> {
  const { url } = await api<{ url: string }>('/api/tiktok/oauth/start');
  window.location.href = url;
}
```

- [ ] **Step 2: Add `useStrategyTypes` + extend `CreateStrategyInput` in `apps/dashboard/src/api/strategies.ts`**

Add near the other hooks:
```ts
export interface StrategyTypeInfo { type: string; supportedPlatforms: string[]; }

export function useStrategyTypes() {
  return useQuery({
    queryKey: ['strategy-types'],
    queryFn:  () => api<StrategyTypeInfo[]>('/api/strategies/types'),
  });
}
```
(`useQuery` is already imported in this file — it's used by `useStrategies`. If not, add it to the `@tanstack/react-query` import.)

In `CreateStrategyInput`, widen `platform` and add the TikTok account id:
```ts
  platform?:   'telegram' | 'instagram' | 'facebook' | 'threads' | 'tiktok';
  meta_account_id?: string;
  tiktok_account_id?: string;
```

- [ ] **Step 3: Verify + commit**

From `apps/dashboard`: `npx tsc -b` → clean.
```bash
git add apps/dashboard/src/api/tiktok-accounts.ts apps/dashboard/src/api/strategies.ts
git commit -m "feat(dashboard): TikTok accounts API client + useStrategyTypes + tiktok create-input"
```

---

## Task 2: Pure Type filter — `lib/strategy-types.ts`

**Files:** Create `apps/dashboard/src/lib/strategy-types.ts`.

- [ ] **Step 1: Create the helper**

```ts
import type { StrategyTypeInfo } from '../api/strategies';

/** Strategy types whose supportedPlatforms include `platform`. `null` → none
 *  (no destination chosen yet → the Type list is empty/disabled). */
export function strategyTypesForPlatform(
  types: StrategyTypeInfo[] | undefined,
  platform: string | null,
): StrategyTypeInfo[] {
  if (!types || !platform) return [];
  return types.filter(t => t.supportedPlatforms.includes(platform));
}
```

- [ ] **Step 2: Verify + commit**

From `apps/dashboard`: `npx tsc -b` → clean.
```bash
git add apps/dashboard/src/lib/strategy-types.ts
git commit -m "feat(dashboard): pure strategyTypesForPlatform filter"
```

(Pure function — no dashboard test runner; correctness: includes-platform kept, excludes dropped, null/undefined → empty. Exercised live via the reworked form in Task 4.)

---

## Task 3: TikTok accounts page — `TikTokAccountsManager` + route + sidebar

**Files:** Create `apps/dashboard/src/components/connections/TikTokAccountsManager.tsx`; Create `apps/dashboard/src/routes/connections_.tiktok.tsx`; Modify `apps/dashboard/src/components/AppSidebar.tsx` (remove `soon`).

- [ ] **Step 1: Create `TikTokAccountsManager.tsx`**

Mirror `MetaAccountsManager` patterns (cards + pause/delete), minus verify (TikTok has no verify endpoint). Read `?tiktok=` for a banner.

```tsx
// TikTok accounts manager — connected creator accounts. Connect via OAuth; tokens
// live in the DB (never shown). Mirrors MetaAccountsManager (no verify step).
import { useState } from 'react';
import { Icon } from '../ui/Icon';
import { Badge } from '../ui/Badge';
import { useConfirm } from '../ui/ConfirmDialog';
import {
  useTikTokAccounts, useToggleTikTokAccount, useDeleteTikTokAccount, startTikTokOAuth,
} from '../../api/tiktok-accounts';

export function TikTokAccountsManager({ notice }: { notice?: 'connected' | 'error' }) {
  const { data, isLoading, error } = useTikTokAccounts();
  const toggle = useToggleTikTokAccount();
  const remove = useDeleteTikTokAccount();
  const confirm = useConfirm();
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const connect = async () => {
    setConnecting(true); setConnectError(null);
    try { await startTikTokOAuth(); }
    catch (e) { setConnectError((e as Error).message); setConnecting(false); }
  };

  return (
    <div>
      {notice === 'connected' && (
        <div className="callout-success" style={{ marginBottom: 16 }}>
          <Icon name="check" size={14} /><span className="text-micro">TikTok account connected.</span>
        </div>
      )}
      {notice === 'error' && (
        <div className="callout-warning" style={{ marginBottom: 16 }}>
          <Icon name="info" size={14} /><span className="text-micro">TikTok connection failed — try again.</span>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        <button className="btn-primary" onClick={connect} disabled={connecting}>
          {connecting ? 'Redirecting…' : 'Connect TikTok'}
        </button>
      </div>
      {connectError && (
        <p className="text-body-sm" style={{ color: 'var(--color-danger)', marginBottom: 12 }}>{connectError}</p>
      )}

      {isLoading && <p className="text-body-sm">Loading…</p>}
      {error && <p className="text-body-sm" style={{ color: 'var(--color-danger)' }}>{(error as Error).message}</p>}
      {data && data.length === 0 && (
        <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>
          No TikTok accounts yet — connect one to publish carousels.
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {data?.map(a => (
          <div key={a.id} className="card" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12 }}>
            {a.avatar_url
              ? <img src={a.avatar_url} alt="" width={40} height={40} style={{ borderRadius: '50%' }} />
              : <Icon name="tiktok" size={28} />}
            <div style={{ flex: 1 }}>
              <div className="text-body-sm" style={{ color: 'var(--color-ink)' }}>
                {a.username ?? a.display_name ?? a.open_id}
              </div>
              <div className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>
                {a.active ? <Badge>active</Badge> : <Badge>paused</Badge>}
                {a.refresh_error && <span style={{ color: 'var(--color-danger)', marginLeft: 8 }}>token error</span>}
              </div>
            </div>
            <button className="btn-secondary" onClick={() => toggle.mutate({ id: a.id, active: !a.active })}>
              {a.active ? 'Pause' : 'Resume'}
            </button>
            <button
              className="btn-secondary"
              onClick={async () => { if (await confirm({ title: 'Delete TikTok account?' })) remove.mutate(a.id); }}
            >
              Delete
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
```

(If `useConfirm`/`Badge`/`callout-success` differ slightly from this signature, match the
actual ones used in `MetaAccountsManager.tsx` — read it and mirror exactly.)

- [ ] **Step 2: Create the route `apps/dashboard/src/routes/connections_.tiktok.tsx`**

Mirror `connections_.meta.tsx` (root-level route, wins over the `$platform` placeholder):
```tsx
import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '../components/ui/PageHeader';
import { TikTokAccountsManager } from '../components/connections/TikTokAccountsManager';

interface Search { tiktok?: 'connected' | 'error'; }

export const Route = createFileRoute('/connections_/tiktok')({
  validateSearch: (s: Record<string, unknown>): Search =>
    (s.tiktok === 'connected' || s.tiktok === 'error') ? { tiktok: s.tiktok } : {},
  component: TikTokConnectionsPage,
});

function TikTokConnectionsPage() {
  const { tiktok } = Route.useSearch();
  return (
    <div>
      <PageHeader title="Connections · TikTok" subtitle="Connect a TikTok creator account for carousels" />
      <TikTokAccountsManager notice={tiktok} />
    </div>
  );
}
```
(Confirm the exact `PageHeader` import path against `connections_.meta.tsx` and adjust if needed. After adding the route file, the generated route tree updates on the next `vite`/`tsc -b` — if the project commits `routeTree.gen.ts`, regenerate it as part of the build.)

- [ ] **Step 3: Drop `soon` from the sidebar TikTok entry**

In `apps/dashboard/src/components/AppSidebar.tsx`, change:
```ts
    { to: '/connections/tiktok', label: 'TikTok',   icon: 'tiktok', soon: true },
```
to:
```ts
    { to: '/connections/tiktok', label: 'TikTok',   icon: 'tiktok' },
```

- [ ] **Step 4: Verify + commit**

From `apps/dashboard`: `npx tsc -b` → clean; `npm run build` → succeeds (regenerates the route tree).
```bash
git add apps/dashboard/src/components/connections/TikTokAccountsManager.tsx apps/dashboard/src/routes/connections_.tiktok.tsx apps/dashboard/src/components/AppSidebar.tsx apps/dashboard/src/routeTree.gen.ts
git commit -m "feat(dashboard): TikTok accounts page + Connect button + sidebar entry"
```

---

## Task 4: Rework `AddStrategyModal` — Destination→Type + platform filter + TikTok

**Files:** Modify `apps/dashboard/src/components/AddStrategyModal.tsx`.

- [ ] **Step 1: Apply the rework**

Edit the component:
1. Add imports: `useStrategyTypes` from `../api/strategies`, `useTikTokAccounts` from `../api/tiktok-accounts`, `strategyTypesForPlatform` from `../lib/strategy-types`.
2. State: change `destKind` to `useState<'telegram' | 'meta' | 'tiktok'>('telegram')`; add `const [tiktokId, setTiktokId] = useState('')`.
3. Data: `const typesQ = useStrategyTypes();` `const tiktokQ = open && destKind === 'tiktok' ? useTikTokAccounts() : { data: undefined, isLoading: false };` (keep the existing meta-accounts gating pattern; call hooks unconditionally — gate on the data, mirroring the existing `metaAccounts` pattern that always calls `useMetaAccounts()`).
4. Compute the resolved platform:
```ts
const platform: string | null =
  destKind === 'telegram' ? 'telegram'
  : destKind === 'tiktok'  ? 'tiktok'
  : metaPlatformOf(metaAccountsQ.data, metaId) ?? null;  // meta: known once an account is picked
const availableTypes = strategyTypesForPlatform(typesQ.data, platform);
```
5. Reset `type` when it leaves the available set:
```ts
useEffect(() => {
  if (type && !availableTypes.some(t => t.type === type)) setType('');
}, [platform]); // eslint-disable-line react-hooks/exhaustive-deps
```
(import `useEffect` from `react`.)
6. **Reorder the JSX:** move the **Destination** `Field` ABOVE the **Type** `Field`. Add the TikTok option to the destination select and a TikTok account selector; make the Type select read from `availableTypes` and disable it until `platform` is set.

Destination select:
```tsx
<Field label="Destination">
  <select value={destKind} onChange={e => setDestKind(e.target.value as 'telegram'|'meta'|'tiktok')} className="input-field" style={{ width: '100%' }}>
    <option value="telegram">Telegram channel</option>
    <option value="meta">Meta account (Instagram / Facebook / Threads)</option>
    <option value="tiktok">TikTok account</option>
  </select>
</Field>
```

TikTok account field (alongside the existing telegram/meta ones):
```tsx
{destKind === 'tiktok' && (
  <Field label="TikTok account" hint="connected accounts only">
    <select value={tiktokId} onChange={e => setTiktokId(e.target.value)} className="input-field" style={{ width: '100%' }}>
      <option value="" disabled>{tiktokQ.isLoading ? 'Loading…' : 'Pick a TikTok account'}</option>
      {tiktokQ.data?.filter(a => a.active).map(a => (
        <option key={a.id} value={a.id}>{a.username ?? a.id}</option>
      ))}
    </select>
  </Field>
)}
```

Type select (now AFTER destination; filtered + disabled-until-platform):
```tsx
<Field label="Type" hint={platform ? 'strategies available for this destination' : 'pick a destination first'}>
  <select value={type} onChange={e => setType(e.target.value)} className="input-field" style={{ width: '100%' }} disabled={!platform || availableTypes.length === 0}>
    <option value="" disabled>
      {!platform ? 'Pick a destination first' : availableTypes.length === 0 ? 'No strategies for this destination' : 'Pick a strategy type'}
    </option>
    {availableTypes.map(t => (
      <option key={t.type} value={t.type}>{STRATEGY_DESCRIPTIONS[t.type]?.title ?? t.type} ({t.type})</option>
    ))}
  </select>
  <TypeDescription type={type} />
</Field>
```

7. **Submit + valid:** include the tiktok branch and require a `type` in the available set:
```ts
...(destKind === 'telegram'
  ? { channel_id: channelId, platform: 'telegram' as const }
  : destKind === 'tiktok'
  ? { platform: 'tiktok' as const, tiktok_account_id: tiktokId }
  : { platform: metaPlatformOf(metaAccountsQ.data, metaId) ?? 'instagram', meta_account_id: metaId }),
```
```ts
const destId = destKind === 'telegram' ? channelId : destKind === 'tiktok' ? tiktokId : metaId;
const valid = !!extId && !!schedule && !!destId &&
  !!type && availableTypes.some(t => t.type === type);
```
On success also `setTiktokId('')`.

- [ ] **Step 2: Verify + commit**

From `apps/dashboard`: `npx tsc -b` → clean; `npm run build` → succeeds.
```bash
git add apps/dashboard/src/components/AddStrategyModal.tsx
git commit -m "feat(dashboard): AddStrategyModal Destination→Type with platform-filtered types + TikTok"
```

---

## Task 5: Dashboard verification (preview)

**Files:** none (verification).

- [ ] **Step 1: Build + preview**

From `apps/dashboard`: `npx tsc -b` (clean) and `npm run build` (succeeds).
Then via the preview tools: open the Add-strategy modal — confirm **Destination is above Type**, Type is **disabled until a destination/account is chosen**, and once chosen lists only platform-appropriate strategies (e.g. `tiktok` → only `recipe-carousel`). Open `/connections/tiktok` — confirm the page renders with the **Connect TikTok** button and empty-state. Check the console for errors.

- [ ] **Step 2: Note**

Live data requires the backend running (operator's part); the preview verifies render + structure. No commit (verification only).

---

## Task 6: Merge the TikTok stack into `develop`

**Files:** none (git).

The chain is linear: `develop`(has 5a) → `feat/tiktok-publisher`(5b) → `feat/tiktok-strategy`(5c) → `feat/tiktok-oauth`(5d-1) → `feat/tiktok-dashboard`(5d-2). Merging the tip brings 5b–5d-2 in one merge.

- [ ] **Step 1: Merge**

```bash
cd /Users/tupotavalentyn/CS/ai0_global
git checkout develop
git merge --no-ff feat/tiktok-dashboard -m "merge: TikTok integration 5b–5d (publisher, routing, OAuth+accounts API, dashboard)"
```
Expected: clean (linear stack; `develop` unchanged since the chain's base).

- [ ] **Step 2: Full verification on develop**

```bash
cd apps/automation && npm test                 # expect all pass (the known 316 + any added)
cd apps/automation && npm run build            # nest build OK
cd ../dashboard && npx tsc -b && npm run build  # dashboard OK
```
Expected: automation suite all-pass; both builds succeed.

- [ ] **Step 3: Done**

The whole carousel + TikTok feature (sub-projects 1–5) is on local `develop`, unpushed.
Enabling TikTok on prod is the operator's part (app review, public redirect URI, `TIKTOK_*` +
`DASHBOARD_URL` + `SUPABASE_*` env, connect an account, bind `recipe-carousel`→tiktok).

---

## Done criteria

- Dashboard: a `/connections/tiktok` accounts page (list + Connect + pause/delete + connect-result banner); `AddStrategyModal` shows Destination→Type with the Type list filtered to the chosen platform's supported strategies and a TikTok account option.
- `npx tsc -b` + `vite build` clean; preview confirms the reworked form + accounts page render.
- TikTok 5b–5d-2 merged into `develop`; automation `npm test` all-pass; automation + dashboard builds succeed.
- Nothing pushed; merging to `develop` only.
