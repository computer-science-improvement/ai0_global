# TikTok Accounts + Token Service (sub-project 5a) — Design

**Status:** approved (brainstorming) — 2026-06-14
**Branch:** `feat/tiktok-accounts` (off `develop`)
**Parent feature:** recipe image-carousel for IG / FB / Threads / **TikTok**. TikTok is
**sub-project 5**, itself decomposed (it doesn't fit the Meta-only model). This is
**5a** — the TikTok account model + OAuth token storage/refresh foundation. Later TikTok
pieces: 5b (Content Posting API client + photo-carousel publisher), 5c (destination/binding
integration + strategy routing at 9:16), 5d (dashboard + web OAuth round-trip).

## Goal

Persist TikTok creator accounts and keep a valid access token available on demand. TikTok
access tokens expire (~24h) and rotate on refresh, so — unlike the static env-var Meta
tokens — they must live in the DB and be refreshed automatically. This sub-project does
**not** publish anything; it provides `getValidAccessToken(accountId)` for 5b.

## Non-goals (later TikTok sub-projects)

Publishing / the Content Posting API (5b). Wiring TikTok into the destination/binding
model and the recipe-carousel strategy (5c). Any dashboard UI or the web OAuth
authorize→callback round-trip (5d). The initial authorization code is obtained out-of-band
and seeded via a CLI script here.

## Why tokens live in the DB (deliberate exception)

`016_meta_accounts.sql` states the Meta OAuth token never lives in the DB — only the name
of the env var holding it. That works because Meta long-lived tokens are static. TikTok
tokens **rotate on every refresh**, so a static env var cannot hold them. `tiktok_accounts`
therefore stores the access/refresh tokens directly. They are stored in plaintext for v1
(internal DB, already trusted); encryption-at-rest is a possible later hardening. Tokens
are never logged.

## Components

### 1. Migration — `database/migrations/022_tiktok_accounts.sql`

```sql
-- 022_tiktok_accounts.sql — TikTok creator connections for the carousel publisher.
-- UNLIKE meta_accounts, the tokens live in the DB: TikTok access tokens expire (~24h)
-- and rotate on refresh, so a static env var cannot hold them. Plaintext for v1
-- (internal DB); tokens are never logged. client_key/secret stay in env.
CREATE TABLE IF NOT EXISTS tiktok_accounts (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  open_id                  TEXT NOT NULL UNIQUE,
  union_id                 TEXT,
  username                 TEXT,
  display_name             TEXT,
  avatar_url               TEXT,
  access_token             TEXT NOT NULL,
  refresh_token            TEXT NOT NULL,
  access_token_expires_at  TIMESTAMPTZ NOT NULL,
  refresh_token_expires_at TIMESTAMPTZ NOT NULL,
  scope                    TEXT,
  active                   BOOLEAN NOT NULL DEFAULT true,
  last_refreshed_at        TIMESTAMPTZ,
  refresh_error            TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (version) VALUES ('022_tiktok_accounts')
  ON CONFLICT (version) DO NOTHING;
```

(Distinct `version` string, so it coexists with any other `022_*` migration on another
branch — both apply independently.)

### 2. `TikTokAccountsRepository` — `src/config/tiktok-accounts.repository.ts`

Mirrors `MetaAccountsRepository` (pool via `@Inject(DB_POOL)`). `TikTokAccountRow`
interface matches the columns. Methods:

```ts
list(): Promise<TikTokAccountRow[]>
findById(id: string): Promise<TikTokAccountRow | null>
findByOpenId(openId: string): Promise<TikTokAccountRow | null>
/** Insert or update an account by open_id after a token exchange (onboarding/re-auth). */
upsertFromTokens(input: TikTokTokenSet & { openId: string; scope: string | null }): Promise<TikTokAccountRow>
/** Persist rotated tokens after a refresh; clears refresh_error, sets last_refreshed_at. */
updateTokens(id: string, tokens: TikTokTokenSet): Promise<void>
setRefreshError(id: string, message: string): Promise<void>
setActive(id: string, active: boolean): Promise<void>
```

`TikTokTokenSet = { accessToken; refreshToken; accessTokenExpiresAt: Date; refreshTokenExpiresAt: Date }`.

### 3. `TikTokTokenService` — `src/config/tiktok-token.service.ts`

The heart of 5a. Talks to `https://open.tiktokapis.com/v2/oauth/token/`. Reads
`TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_REDIRECT_URI` via `ConfigService`.

```ts
/** Exchange an authorization code for tokens and upsert the account. Returns the row. */
exchangeCode(code: string): Promise<TikTokAccountRow>

/** A valid access token for the account, refreshing first if it is near expiry. */
getValidAccessToken(accountId: string): Promise<string>

/** Force-refresh one account's tokens (used by getValidAccessToken). */
refresh(account: TikTokAccountRow): Promise<string>
```

- Token POST uses `application/x-www-form-urlencoded` with `client_key`, `client_secret`,
  `grant_type`, and either `code`+`redirect_uri` or `refresh_token`.
- Response (`access_token`, `refresh_token`, `expires_in`, `refresh_expires_in`, `open_id`,
  `scope`) → compute absolute expiries `now + expires_in*1000`. The "now" is read from a
  single `Date.now()` call inside the service (not in pure helpers).
- `getValidAccessToken`: load the account (throw if missing/inactive); if
  `access_token_expires_at <= now + 60s skew` → `refresh()`; else return `access_token`.
- `refresh`: POST `grant_type=refresh_token`; on success `updateTokens`; on failure
  `setRefreshError(msg)` and, if the refresh token itself is past
  `refresh_token_expires_at`, `setActive(false)`; rethrow.
- **A `protected post(url, form): Promise<any>` seam** wraps the axios call so unit tests
  inject a fake (mirrors the seams used in sub-projects 2–3). No network in tests.
- The client secret and tokens never appear in any thrown message or log line.

A tiny pure helper `tiktok-token.util.ts` holds `expiryFrom(nowMs, seconds): Date` and the
token-response → `TikTokTokenSet` shaping, unit-tested directly.

### 4. CLI seed — `scripts/tiktok-seed.ts`

Thin: reads an authorization `code` from `process.argv`, constructs the service (or calls
the exchange directly), and prints the resulting `open_id` / `username`. Lives under
`scripts/` (already excluded from `tsconfig` `exclude`). Not unit-tested (thin glue;
needs real creds to run).

### 5. Wiring — `TikTokModule` (`src/config/tiktok.module.ts`)

Provides `TikTokAccountsRepository` + `TikTokTokenService`, exports both, registered in
`AppModule`. Nothing consumes it yet (5b will).

## Data flow

```
seed (CLI): authorization code → exchangeCode → POST /oauth/token (authorization_code)
            → upsertFromTokens → tiktok_accounts row

publish-time (5b, later): getValidAccessToken(accountId)
            → if near expiry: refresh → POST /oauth/token (refresh_token) → updateTokens
            → return access_token
```

## Error handling

| Situation | Behavior |
| --- | --- |
| Missing client env creds | service methods throw a clear config error (no secret in message) |
| Account not found / inactive | `getValidAccessToken` throws |
| Token still valid | returns the stored access token (no network) |
| Refresh succeeds | `updateTokens` (rotates both tokens, sets `last_refreshed_at`, clears error) |
| Refresh fails | `setRefreshError`; if refresh token expired also `setActive(false)`; rethrow |
| Any logging | tokens / client secret never logged |

## Testing

`node:test` via `cd apps/automation && npm test`. **No live network** (cost guard).

Pure helper — `tiktok-token.util.test.ts`:
- `expiryFrom(1_000_000, 86400)` → `Date(1_000_000 + 86400_000)`.
- response-shaping maps `access_token`/`refresh_token`/`expires_in`/`refresh_expires_in` to a `TikTokTokenSet` with correct absolute expiries.

Repository — `tiktok-accounts.repository.test.ts` with a fake pool:
- `upsertFromTokens` / `updateTokens` / `setRefreshError` / `setActive` issue the expected SQL params; `findByOpenId` returns `rows[0] ?? null`.

Token service — `tiktok-token.service.test.ts` with a fake repo + overridden `post` seam:
- `getValidAccessToken` returns the stored token when not near expiry (no `post` call).
- `getValidAccessToken` refreshes when near/after expiry → calls `post` with
  `grant_type=refresh_token`, calls `updateTokens`, returns the new token.
- `exchangeCode` posts `grant_type=authorization_code` and calls `upsertFromTokens` with
  the parsed tokens + open_id.
- refresh failure (fake `post` throws / returns error) → `setRefreshError` called and the
  method rejects; tokens never appear in the error.
- account not found → `getValidAccessToken` rejects.

## Cost / safety guard (standing)

Build + `tsc` + unit tests only (`cd apps/automation && npm test`). No service restart, no
live TikTok calls, no publishing. The migration applies on next boot (the user's restart,
not ours). One new env block (`TIKTOK_CLIENT_KEY/SECRET/REDIRECT_URI`) in `.env.example`.
No new runtime dependency (axios already present).

## Deferred (later TikTok sub-projects)

- **5b** — Content Posting API client (photo-mode init → poll), the TikTok carousel
  publisher, consuming `getValidAccessToken`.
- **5c** — `DestinationPlatform` gains `'tiktok'`, a TikTok destination resolver +
  `TT:<uuid>` dedup key, binding `platform='tiktok'`, and recipe-carousel routing to
  TikTok with the renderer's 9:16 `opts`.
- **5d** — dashboard for TikTok accounts + the web OAuth authorize→callback round-trip.
