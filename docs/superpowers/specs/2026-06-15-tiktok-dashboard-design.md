# TikTok Dashboard — Accounts Page + Binding-Form Rework (sub-project 5d-2) — Design

**Status:** approved (brainstorming) — 2026-06-15
**Branch:** `feat/tiktok-dashboard` (off `feat/tiktok-oauth`, which carries 5a–5d-1)
**Parent feature:** recipe image-carousel for IG / FB / Threads / **TikTok**. This is the
**final** TikTok piece — **5d-2**, the dashboard UI consuming the 5d-1 endpoints.

## Goal

1. A TikTok accounts page in the dashboard: list connected accounts, a **Connect TikTok**
   button (starts the OAuth flow), and toggle/delete.
2. Rework `AddStrategyModal` to the operator's requested order — **Destination first → Type**
   — with the **Type list filtered to strategies that support the chosen platform**, and a
   TikTok destination option.

## Non-goals

Backend OAuth/accounts API (5d-1, done) and routing/strategy (5c, done). The real OAuth
flow still needs TikTok app review + a registered public redirect URI (external). No new
runtime dependency.

## Approach

Mirror the existing Meta dashboard (`connections_.meta.tsx` + `MetaAccountsManager` +
`api/meta-accounts.ts`) for TikTok, and edit `AddStrategyModal` in place. Rejected:
extracting a shared "destination picker" (larger refactor, YAGNI now); a separate
"add TikTok binding" modal (duplicates the form).

The dashboard has **no test runner**; verification is `tsc` + `vite build` + a live
`preview` snapshot (the established dashboard-verification path). The one piece of real
logic — filtering Type by platform — is extracted into a **pure** function so it's
trivially correct and reviewable in isolation.

## Components

### 1. API client — `src/api/tiktok-accounts.ts`

Mirrors `api/meta-accounts.ts` (cookie-auth `api<T>()`):

```ts
export interface TikTokAccount {
  id: string; open_id: string; username: string | null; display_name: string | null;
  avatar_url: string | null; active: boolean; last_refreshed_at: string | null;
  refresh_error: string | null; created_at: string;
}
export function useTikTokAccounts();                 // GET  /api/tiktok-accounts
export function useToggleTikTokAccount();             // PATCH /api/tiktok-accounts/:id { active }
export function useDeleteTikTokAccount();             // DELETE /api/tiktok-accounts/:id
export async function startTikTokOAuth(): Promise<void>; // GET /api/tiktok/oauth/start → window.location = url
```

### 2. API client — `src/api/strategies.ts` (add `useStrategyTypes`)

```ts
export interface StrategyTypeInfo { type: string; supportedPlatforms: string[]; }
export function useStrategyTypes();   // GET /api/strategies/types → StrategyTypeInfo[]
```

### 3. Pure filter — `src/lib/strategy-types.ts`

```ts
import type { StrategyTypeInfo } from '../api/strategies';
/** Types whose supportedPlatforms include `platform` (null platform → none). */
export function strategyTypesForPlatform(types: StrategyTypeInfo[], platform: string | null): StrategyTypeInfo[];
```

### 4. `TikTokAccountsManager` + route `src/routes/connections_.tiktok.tsx`

Mirror `connections_.meta.tsx`. A root-level route at `/connections/tiktok` rendering
`TikTokAccountsManager`:
- Lists accounts: avatar, `username`/`display_name`, an active/paused chip, `last_refreshed_at`,
  and a danger chip when `refresh_error` is set.
- **Connect TikTok** button → `startTikTokOAuth()` (navigates the browser to the authorize URL).
- Per-account: toggle active (PATCH), delete (DELETE, with confirm).
- Reads the `?tiktok=connected|error` query (set by the 5d-1 callback redirect) → shows a
  success/error banner and invalidates the accounts query. The sidebar gains a
  `/connections/tiktok` entry (mirroring how Meta is linked).

### 5. `AddStrategyModal` rework — `src/components/AddStrategyModal.tsx`

- **Field order:** Strategy id → **Destination** → (channel | meta account | tiktok account) → **Type** → Schedule.
- `destKind: 'telegram' | 'meta' | 'tiktok'`. The Destination `<select>` gains a TikTok option.
- **Resolved platform:** `telegram` → `'telegram'`; `meta` → the chosen meta account's
  `platform` (ig/fb/th), or `null` until one is picked; `tiktok` → `'tiktok'`.
- **Type `<select>`** is built from `useStrategyTypes()` filtered via
  `strategyTypesForPlatform(types, resolvedPlatform)`; each option's label comes from
  `STRATEGY_DESCRIPTIONS[type]?.title` (fallback to the raw `type`). The Type field is
  **disabled with a hint** ("pick a destination first") until `resolvedPlatform` is set.
  Changing the destination/account **resets `type`** if it's no longer in the filtered set.
- **tiktok account selector:** when `destKind === 'tiktok'`, a `<select>` of active
  `useTikTokAccounts()` (label = `username ?? id`).
- **Submit:** `tiktok` → `{ platform: 'tiktok', tiktok_account_id: tiktokId }`; meta/telegram
  unchanged. `valid` requires the matching destination id + a `type` that's in the filtered set.

## Data flow

```
Connect:  button → startTikTokOAuth() → GET /oauth/start → window.location = authorizeUrl
          → TikTok consent → 5d-1 callback → 302 /connections/tiktok?tiktok=connected
          → TikTokAccountsManager reads query → banner + refetch list

Add form: pick Destination → (pick account → resolvedPlatform) → Type list = strategyTypesForPlatform(types, platform)
          → submit → POST /api/strategies (platform + account id)
```

## Error handling

- `startTikTokOAuth` failure (e.g. 500 from unconfigured client) → surface the error inline
  (don't navigate).
- `?tiktok=error` → red banner ("TikTok connection failed — try again").
- Empty accounts list → an empty-state with the Connect button.
- Type filtered to empty (no strategy supports the platform) → the Type select shows a
  disabled "no strategies for this destination" option; submit stays invalid.

## Testing / verification

The dashboard has no unit-test runner. Verification:
- `cd apps/dashboard && npx tsc -b` (typecheck) — clean.
- `npm run build` (vite) — succeeds.
- `preview`: snapshot the reworked modal (Destination above Type; Type filtered after a
  platform is chosen; TikTok option + account selector) and the `/connections/tiktok` page
  (empty-state + Connect button). Confirm Cyrillic/labels render and no console errors.
- `strategyTypesForPlatform` is pure and self-evidently correct; were a runner present it
  would get a unit test (include the cases: includes-platform → kept; excludes → dropped;
  `null` platform → empty).

## Cost / safety guard (standing)

Frontend only. `tsc` + `vite build` + `preview`. No backend run, no real OAuth, no
publishing. No new dependency. Backend (5a–5d-1) untouched.

## After 5d-2

The TikTok integration (5a–5d) is feature-complete in code. Enabling it on prod is the
user's part: TikTok app review, a registered public redirect URI, `TIKTOK_*` + `DASHBOARD_URL`
env, then connect an account and bind `recipe-carousel` → tiktok. Then the whole TikTok
branch chain merges to `develop`.
