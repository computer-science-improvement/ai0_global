# TikTok OAuth Round-Trip + Accounts API (sub-project 5d-1) — Design

**Status:** approved (brainstorming) — 2026-06-15
**Branch:** `feat/tiktok-oauth` (off `feat/tiktok-strategy`, which carries 5a + 5b + 5c)
**Parent feature:** recipe image-carousel for IG / FB / Threads / **TikTok**. This is
**5d-1** — the backend for connecting/managing TikTok accounts. 5d-2 (the dashboard UI:
accounts page, Connect button, binding-form rework) consumes these endpoints.

## Goal

Let an operator connect a TikTok creator account through the standard OAuth
authorization-code flow from the browser, and list/manage connected accounts via the API —
without ever exposing tokens. The code exchange reuses `TikTokTokenService.exchangeCode`
(5a).

## Non-goals

The dashboard pages/components (5d-2). Token refresh/exchange internals (5a). Publishing
(5b) and binding routing (5c). Real OAuth still needs TikTok app review + a publicly
reachable redirect URI registered in the TikTok portal (external).

## Approach

Standard authorization-code flow with a **signed, stateless `state`** (HMAC, no storage)
for CSRF, plus an accounts CRUD API mirroring `MetaAccountsController` (token-free
projection). Rejected: device-code/manual-paste only (not the requested web flow);
DB-stored `state` (extra table — YAGNI when a signed token works).

The OAuth **callback is public** (the browser arrives via TikTok redirect, carrying no
dashboard session) — its trust comes from verifying the signed `state` we issued at start.
Everything else is behind `TrackingAuthGuard`.

## Components

### 1. Pure helper — `src/config/tiktok-oauth-state.util.ts`

HMAC-SHA256 signed state, no storage. `nowMs` passed in (deterministic, testable).

```ts
/** Sign `nonce.exp` (exp = nowMs + ttlMs) → base64url(`exp.nonce.sig`). */
export function signState(secret: string, nowMs: number, ttlMs?: number): string;
/** True when the signature verifies AND exp > nowMs. */
export function verifyState(secret: string, token: string, nowMs: number): boolean;
```

Default `ttlMs` = 10 min. Uses `node:crypto` `createHmac`. Verify is constant-time
(`timingSafeEqual`) and returns false (never throws) on any malformed input.

### 2. `TikTokOAuthService` — `src/config/tiktok-oauth.service.ts`

`@Injectable()`. Reads `TIKTOK_CLIENT_KEY`, `TIKTOK_REDIRECT_URI`, `TIKTOK_SCOPES`
(default `user.info.basic,video.publish`), and the state secret (`JWT_SECRET`, already in
env) via `ConfigService`.

```ts
/** Build the TikTok authorize URL with a fresh signed state. */
buildAuthorizeUrl(nowMs: number): string;   // https://www.tiktok.com/v2/auth/authorize/?client_key&scope&response_type=code&redirect_uri&state
/** Verify a returned state token. */
verifyState(token: string, nowMs: number): boolean;
```

`buildAuthorizeUrl` throws a clear config error if `TIKTOK_CLIENT_KEY` / `TIKTOK_REDIRECT_URI`
are unset. The client secret is not used here (only at exchange, in 5a).

### 3. `TikTokAccountsController` — `src/config/api/tiktok-accounts.controller.ts`

`@Controller('api/tiktok-accounts')` + `@UseGuards(TrackingAuthGuard)` (class-level).
Mirrors `MetaAccountsController`'s token-free list pattern.

- `GET /` → `accounts.list()` mapped to a **token-free** projection: `id, open_id,
  username, display_name, avatar_url, active, last_refreshed_at, refresh_error, created_at`
  (never `access_token`/`refresh_token`).
- `DELETE /:id` → `accounts.delete(id)`; 404 if not found.
- `PATCH /:id` `{ active: boolean }` → `accounts.setActive(id, active)`.

### 4. `TikTokOAuthController` — `src/config/api/tiktok-oauth.controller.ts`

`@Controller('api/tiktok/oauth')`. Method-level guards (NOT class-level) so the callback
is public.

- `GET /start` `@UseGuards(TrackingAuthGuard)` → `{ url: oauth.buildAuthorizeUrl(Date.now()) }`.
  The dashboard navigates the browser to `url`.
- `GET /callback` (**no guard**) `@Redirect()` `?code&state&error?` →
  - if `error` present or `state` missing/`verifyState` false → return `{ url: <dashboard>?tiktok=error }`.
  - else `await tokenService.exchangeCode(code)`; on success → `{ url: <dashboard>?tiktok=connected }`;
    on throw (caught) → `{ url: <dashboard>?tiktok=error }`.
  - `<dashboard>` = `config.get('DASHBOARD_URL') ?? ''` + `/connections/tiktok`. Never 500s
    on a bad callback — always a redirect. Tokens never appear in logs or the redirect URL.

### 5. Repository — `TikTokAccountsRepository.delete(id)`

```ts
async delete(id: string): Promise<boolean> {
  const { rowCount } = await this.pool.query(`DELETE FROM tiktok_accounts WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}
```
(`list` and `setActive` already exist from 5a.)

### 6. Wiring + env

Register both controllers in `ChannelConfigModule.controllers`; add `TikTokOAuthService`
to its providers. Add to `apps/automation/.env.example`:

```bash
# TikTok OAuth scopes (comma-separated) requested at connect time.
TIKTOK_SCOPES=user.info.basic,video.publish
# Base URL the OAuth callback redirects the browser back to (the dashboard origin).
DASHBOARD_URL=
```

## Data flow

```
dashboard → GET /api/tiktok/oauth/start (authed) → { url }
browser   → window.location = url → TikTok consent → TikTok 302 → GET /api/tiktok/oauth/callback?code&state
callback  → verifyState(state) → TikTokTokenService.exchangeCode(code) [5a]
          → 302 → <DASHBOARD_URL>/connections/tiktok?tiktok=connected|error
dashboard → GET /api/tiktok-accounts (authed) → token-free list
```

## Error handling

| Situation | Behavior |
| --- | --- |
| `start` with missing client/redirect env | 500 config error (operator misconfig — visible) |
| `callback` with invalid/expired/forged state | 302 `?tiktok=error` (no exchange) |
| `callback` with `error` param from TikTok | 302 `?tiktok=error` |
| `exchangeCode` throws | caught → 302 `?tiktok=error` |
| `DELETE` unknown id | 404 |
| Any response/log | tokens never included |

## Testing

`node:test` via `cd apps/automation && npm test`. **No live network** (cost guard); the
token exchange is mocked.

- **state util** — `verifyState(secret, signState(secret, t), t)` true; expired (`t + ttl + 1`) false; tampered token false; garbage false (no throw); wrong secret false.
- **`TikTokOAuthService`** — `buildAuthorizeUrl` contains `client_key`, the scope, the redirect_uri, `response_type=code`, and a `state` that `verifyState` accepts; throws when client key/redirect unset.
- **`TikTokAccountsController`** — `GET /` returns the token-free projection (assert no `access_token`/`refresh_token` keys); `DELETE` 404 on missing; `PATCH` calls `setActive`. Fake repo.
- **`TikTokOAuthController`** — `start` returns `{ url }` from the service; `callback` with a valid state calls `exchangeCode` and returns `{ url: …?tiktok=connected }`; invalid state → `…?tiktok=error` and `exchangeCode` NOT called; `exchangeCode` throwing → `…?tiktok=error`. Fake service + token service.
- **Repository** — `delete` issues the right SQL/params and returns boolean (fake pool).

## Cost / safety guard (standing)

Build + `tsc` + unit tests only (`cd apps/automation && npm test`). No service restart, no
live TikTok calls, no publishing. No new dependency (`node:crypto` is built in). Two env
vars documented. The real flow needs app review + a registered public redirect URI.

## Deferred — 5d-2

The dashboard: a TikTok accounts page (list + a "Connect TikTok" button that calls
`/oauth/start` and navigates to the returned URL; delete/toggle), and the `AddStrategyModal`
rework (Destination→Type ordering, Type filtered by `GET /api/strategies/types`
`supportedPlatforms`, and a TikTok account selector when platform=tiktok).
