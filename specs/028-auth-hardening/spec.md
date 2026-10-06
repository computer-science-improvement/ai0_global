# 028: Auth hardening: route guard, server-side gating of /app, revocable sessions, no dev-mode in production

**Status:** SPEC · **Depends on:** 001 (login rate limit, `safeEqual`, fail-closed `JWT_SECRET`) · **Migration:** `060_auth_sessions.sql`
**Owner comments addressed:** #15 (plans/brd-comments-2026-10-06.md)

## Why
The owner's comment on BRD 01 §3.2 says the guard is purely client-side and must be improved. The backend guards keep
the data safe, but the rest is weak: anyone who opens `/app` gets the app shell, a misbuilt image falls back to dev
mode and loops on 401s, a stolen cookie works for 30 days with no way to revoke it, and login attempts leave no trace.
This spec makes the server the source of truth for "is this browser logged in", enforces it at nginx and in the
router, and gives the owner control over sessions.

## Current state (as-is)
- **Client guard only.** `apps/dashboard/src/routes/app.tsx` shows an unstyled "Loading…" while `AuthProvider` calls
  `/auth/me`; without `me` it does `window.location.href = '/login'` (full reload) (BR-CORE-09, BR-CORE-10). nginx
  serves `index.html` for every path (`nginx.conf`, `try_files`), so anyone receives the shell. No `next` is kept.
- **Dev mode is the default.** `lib/env.ts` resolves `AUTH_MODE` to `dev` unless `VITE_TG_BOT_USERNAME` or
  `VITE_AUTH_MODE=token` is set; the Dockerfile and `docker-compose.yml:104-105` pass both empty. `auth-context.tsx`
  then fakes `DEV_USER`, the production backend answers 401, `api/client.ts` sends the user to `/login`, which offers
  "Continue in dev mode" again: a loop (BR-CORE-15, BR-CORE-17).
- **`/login` ignores existing sessions**; token login lands on `/app`, Telegram on `/app/channels`; Telegram errors use `alert()`.
- **Misleading errors.** Every token failure shows "Invalid token", whether wrong token, 429, network or unset
  `TRACKING_TOKEN` (BR-CORE-26); the hint exposes the env var name.
- **No revocation.** `AuthService` signs a stateless JWT (`expiresIn: '30d'`), cookie `maxAge` 30 days; logout only
  clears the local cookie (BR-CORE-19, BR-CORE-25). The only kill switch is rotating `JWT_SECRET`.
- **In-memory rate limit.** `auth/rate-limit.guard.ts`: per-IP `Map`, 10/min across both login routes, reset on
  restart (BR-CORE-21). No failure counting, no log.
- **`/auth/me` ignores Bearer**, while `TrackingAuthGuard` accepts Bearer → cookie → dev bypass; the paths disagree.
- **Hard reload on every 401** in `api()`, with no single-flight (BR-CORE-23).

## Threat model
| Threat | Today | After |
|---|---|---|
| Unauthenticated visitor opens `/app/*` | Gets the HTML shell; the client redirects after JS loads | nginx answers 302 to `/login?next=…` before any HTML; static assets stay public |
| Stolen or leftover cookie (lost laptop, shared PC) | Valid for 30 days; nobody can revoke it except by rotating `JWT_SECRET` | Revoke one session or all sessions; the next request fails; idle timeout 7 days |
| Brute force on the token form | 10/min/IP in memory, reset on restart, no record | Redis sliding window plus failure lockout; every attempt is audited; the owner is alerted on bursts |
| Image built without an auth mode | Dev mode in production, 401 loop | The build fails; a runtime banner covers a stray image; no fake user ever |
| Silent account takeover | No login history | `auth_events` log, a session list, and an owner ping on a login from a new device |
| Open redirect via `next` | n/a | `next` is accepted only as a same-origin `/app` path |
| Leaked `TRACKING_TOKEN` | Full API through Bearer | Unchanged; rotation stays the owner's lever (see Non-goals) |

## Functional requirements
| ID | Requirement |
|----|-------------|
| FR-001 | **Migration `060_auth_sessions.sql`.** <br>• `auth_sessions(id uuid pk, method text check in (token, telegram, link), subject_id bigint, first_name text, username text, ip inet, user_agent text, created_at, last_seen_at, revoked_at timestamptz null, revoked_reason text null)`, with an index on `(revoked_at, last_seen_at)`. <br>• `auth_events(id bigserial pk, at timestamptz default now(), kind text check in (login_ok, login_failed, rate_limited, locked_out, logout, revoked, revoke_all, expired), method text null, code text null, subject_id bigint null, session_id uuid null, ip inet, user_agent text)`. <br>Neither table ever stores a token, a token prefix or a widget hash. |
| FR-002 | **Sessions (`SessionService`).** <br>• Login inserts an `auth_sessions` row and signs a JWT `{sub, sid, method, firstName, username, v: 2}` with `exp` = `AUTH_ACCESS_TTL_MIN` (default 60). Cookie `tracking_jwt` keeps its attributes; `maxAge` = the idle window. <br>• **Valid** = not revoked, `last_seen_at + AUTH_IDLE_TTL_DAYS (7)` and `created_at + AUTH_ABSOLUTE_TTL_DAYS (30)` both in the future. <br>• **Sliding renewal:** a guarded request whose JWT is past half-life (or expired but within the idle window) is re-checked in the DB and gets a fresh cookie. <br>• `last_seen_at` written at most every 5 min. In-process cache `sid → state` (TTL 60 s), invalidated synchronously on revoke (single instance, 001 FR-015). Empty env = default. |
| FR-003 | **One authenticator.** `authenticate(req)` serves `TrackingAuthGuard`, `/auth/me` and `/auth/check`: Bearer `TRACKING_TOKEN` (constant-time) → session cookie → dev bypass (unchanged rules). Returns `{method: bearer|session|dev, identity, sid?}`. 401 body `{code}`: `no_credentials`, `session_expired`, `session_revoked`, `session_legacy` (JWT without `sid`). |
| FR-004 | **`GET /auth/check`** for nginx: 204/401, empty body, `no-store`; no writes, no cookie re-issue, no rate limit; DB read only on cache miss. On a DB error: 204 if the JWT is unexpired, else 503 (never 401, so an outage is not a logout). |
| FR-005 | **`GET /auth/me`** accepts Bearer and returns `{tgUserId, firstName, username, method, sessionId?, expiresAt?}`. The dev identity comes back only when the backend bypass applies. No session → 200 `null` (compatible). |
| FR-006 | **nginx gating of the shell (`apps/dashboard/nginx.conf`).** `location = /app` and `^~ /app/` use `auth_request /_auth_check` (internal, proxies to `automation:3000/auth/check`, cookie only, no body). 401 → 302 `/login?next=$request_uri`; 5xx → static `auth-unavailable.html` (503); `/app` HTML gets `no-store`. `/`, `/login`, `/report/*`, `/assets/*` and API prefixes stay ungated (prefix list mirrored with `vite.config.ts`). |
| FR-007 | **Precise login errors.** <br>• Login endpoints return `{code, message, retryAfterSec?}`: `bad_token`, `token_login_disabled`, `bad_signature`, `payload_expired`, `not_allowlisted`, `telegram_login_disabled`, `rate_limited` (plus a `Retry-After` header) and `locked_out`. <br>• The UI maps each code to plain text ("Too many attempts, try again in 42 s", "Token sign-in is not enabled on this server", plus "Can't reach the server" for network errors). No env var names; Telegram errors inline, not `alert`. |
| FR-008 | **Redis rate limit.** Replaces `RateLimitGuard`, using the existing ioredis `REDIS_CLIENT`: <br>• sliding-window ZSET `auth:rl:<ip>`, 10/min across both login routes; <br>• `auth:fail:<ip>`, 20 failures/h → `locked_out` for 1 h; <br>• global failures 50/h → one owner alert, no lockout (others cannot lock the owner out). <br>Redis unavailable → today's in-memory window plus a warning; never fully fail-open. |
| FR-009 | **Audit and alerts.** Every attempt, logout, revoke and lockout writes an `auth_events` row. A successful login from a new device (IP /24 or /48 + UA family unseen for 30 days) pings the owner via `TelegramNotifier` with method, IP, short UA and a pointer to Settings. A daily job purges events older than 180 days and sessions dead for 30+ days. |
| FR-010 | **Session management.** Guarded `GET /auth/sessions` (with `current`), `DELETE /auth/sessions/:id`, `POST /auth/sessions/revoke-all {includeCurrent}`, `GET /auth/events?limit=50`. `/app/settings` gets a **Security** section: sessions (method, device, IP, created, last seen, "this device") with **Revoke**, **Sign out other sessions**, **Sign out everywhere**, and recent events. |
| FR-011 | **Router guard.** `app.tsx` `beforeLoad` runs `context.queryClient.ensureQueryData(sessionQuery)` (key `['auth','session']`, `staleTime` 60 s); no session → `throw redirect({to: '/login', search: {next: location.href}})` (router-relative href). A cached session renders instantly; a cold check shows a styled `pendingComponent`, not "Loading…". No `window.location`. `/login` `beforeLoad` sends a logged-in user to the safe `next` or `/app`; both login methods land on `next ?? '/app'`. `AuthProvider` becomes a thin hook over the query. |
| FR-012 | **401 handling in `api()`.** Invalidate `['auth','session']`, one single-flight `router.navigate({to: '/login', search: {next, reason: code}})`, still throw `ApiError(401)`. `/login` shows the reason ("Your session expired", "You were signed out from another device", "Please sign in again after the security update"). |
| FR-013 | **No dev mode in production.** <br>• **Build:** a Vite plugin fails a production `vite build` with neither `VITE_TG_BOT_USERNAME` nor `VITE_AUTH_MODE=token`, unless `VITE_ALLOW_DEV_AUTH=true`; compose default becomes `${VITE_AUTH_MODE:-token}`. <br>• **Runtime:** a dev build on a host other than `localhost`/`127.0.0.1`/`*.localhost` shows a red "This build has no sign-in method" banner and hides "Continue". <br>• The client never fabricates a user (dev identity only from `/auth/me`). |
| FR-014 | **Logout** revokes the session (`revoked_reason='logout'`), clears the cookie and the query cache, then `router.navigate({to: '/login', replace: true})`. The button shows unless the session is a server-confirmed dev one. |
| FR-015 | **Login page.** Title "ai0". `/login?token=…` strips the token via `history.replaceState` before submitting (audit records only `method='link'`). `parseNext()` accepts the router-encoded form and nginx's raw `$request_uri` remainder; returns the path only if it starts with `/app`, with no scheme, `//` or backslash; otherwise `/app`. |

## Corner cases
- **Legacy cookies after deploy.** A 30-day JWT without `sid` → `session_legacy` → one re-login with an explanatory
  message. No bulk migration of old tokens.
- **Revoking the current session** from Settings: the response clears the cookie, and the client goes to `/login`.
- **Many 401s at once** (several queries fail together) → one navigation, guarded by a single-flight flag.
- **Client-side navigation from `/` to `/app`** never hits nginx; `beforeLoad` covers it.
- **The Back button after logout:** `/app` HTML is `no-store`, and the query cache is cleared, so no stale data shows.
- **Automation down:** nginx shows the 503 page, not `/login` (no loop). **Redis down:** the limiter degrades to
  memory; `/auth/check` and the guard never touch Redis.
- **`/apple`-style prefixes:** gating uses `= /app` and `^~ /app/`, so `/applications` is not gated.
- **Owner on mobile CGNAT:** lockout is per IP and the global counter never locks; another network still works.
- **Rotating `JWT_SECRET`** still logs everyone out (`session_expired`) and stays the emergency lever.
- **Bearer callers** (scripts, the editor harness) create no sessions and are not affected by revoke-all.
- **Vite dev server** has no nginx; the router guard alone is acceptable on localhost.

## Non-goals
- Roles or multiple users. "Operator" stays the single access class.
- 2FA or TOTP (see the open questions).
- Hiding the JS bundle: `/assets/*` stays public (no secrets inside; data is behind the API guards).
- Changing Bearer `TRACKING_TOKEN` semantics or adding per-script API keys.
- Choosing the login method at runtime (`GET /auth/methods`). The method stays a build-time setting in this spec.
- CSRF tokens. `sameSite=lax` plus JSON-only mutations is enough for now.
- Multi-instance deployment. The session cache assumes 001 FR-015.

## Success criteria
- **Backend unit:** `SessionService` (issue, half-life and expired-in-idle renewal, idle expiry, absolute cap, revoked,
  legacy, `last_seen` throttle); `authenticate()` precedence and 401 codes; `/auth/check` 204/401/503 incl. DB-error
  fallback; `/auth/me` with Bearer; every login error code; the Redis limiter on a fake Redis (window, lockout, global
  alert, fallback when Redis throws).
- **PG:** `060` applies; login → list → revoke one → revoke-all (others) → events rows; no secrets in any column.
- **nginx smoke** (`scripts/smoke-auth-gate.sh`, prod compose): `/app/editor` without cookie → 302
  `/login?next=/app/editor`; with a valid cookie → 200 `no-store`; `/assets/*.js`, `/`, `/report/x` → 200 without
  cookie; automation stopped → 503.
- **Dashboard vitest:** `parseNext` (encoded, raw, hostile); `api()` 401 single-flight; `/login` redirects a logged-in user.
- **Build check:** `VITE_AUTH_MODE= VITE_TG_BOT_USERNAME= pnpm --filter dashboard build` exits non-zero.
- **Manual check:** a deep link to `/app/agents/@manager` in a fresh browser goes to login and then back to the same page,
  with no flash of the shell. "Sign out everywhere" on a laptop logs out the phone on its next request.

## Open questions for the owner
1. **Lifetimes.** Default: 60-min access token, 7-day idle, 30-day absolute cap. Longer idle (30 days) for convenience?
2. **Legacy sessions.** Force one re-login on deploy? Default: **yes** (the only way to make old cookies revocable).
3. **New-device ping.** Should a successful login from a new device be reported to Telegram? Default: **on**.
4. **Login methods** (BRD 01 §3.3). Default: Telegram primary, plus a collapsed "Use access token" form when
   `VITE_AUTH_MODE=token` is also set.
5. **Lockout.** Default 20 failures/h/IP → 1 h lockout. Too strict?
6. **2FA (TOTP)** for token login: a later spec? Default: not now.
7. **Audit retention.** Default: 180 days.

## Task breakdown

### T1: Add session and audit schema with SessionService
**Scope:** `060_auth_sessions.sql`; `auth/session.service.ts` (issue, verify, renew, revoke, cache, `last_seen`
throttle); `auth/auth-events.repository.ts`; TTL env parsing with empty = default; the daily purge cron.
**Acceptance:** the FR-001 and FR-002 unit tests pass; the PG test applies the migration; no secret columns.
**Size:** M
**Depends on:** none

### T2: Route all backend auth through one authenticator
**Scope:** `authenticate()` used by `TrackingAuthGuard`, `/auth/me` and the new `/auth/check`; login endpoints create
sessions and return the FR-007 error codes; logout revokes; the `/auth/sessions*` and `/auth/events` endpoints; 401
`{code}` bodies; sliding-renewal `Set-Cookie` from the guard.
**Acceptance:** the FR-003, FR-004, FR-005, FR-007, FR-010 and FR-014 tests pass; the existing `auth.service.test.ts`
is updated; the 36 guarded controllers need no edits.
**Size:** L
**Depends on:** T1

### T3: Move the login rate limit to Redis and add lockout and alerts
**Scope:** a Redis sliding window plus failure counters; the in-memory fallback; `auth_events` rows for
rate_limited and locked_out; the new-device check and the burst alert through `TelegramNotifier`.
**Acceptance:** the FR-008 and FR-009 unit tests pass with a fake Redis, including the outage fallback;
`rate-limit.guard.test.ts` is replaced.
**Size:** M
**Depends on:** T1

### T4: Gate the /app shell in nginx
**Scope:** the `auth_request` locations, `@to_login`, `auth-unavailable.html`, `no-store` on `/app` HTML;
`scripts/smoke-auth-gate.sh`.
**Acceptance:** the nginx smoke assertions pass on `docker compose --profile prod`; `/`, `/login`, `/report/*`,
`/assets/*` and the API prefixes are unaffected.
**Size:** S
**Depends on:** T2

### T5: Replace the client guard with a router beforeLoad session check
**Scope:** `sessionQuery`; `beforeLoad` on `/app` and `/login`; `pendingComponent`; `parseNext`; a shared router
instance for `api()`; single-flight 401 navigation with a reason; a thin `AuthProvider`; logout clears the cache.
**Acceptance:** the FR-011, FR-012 and FR-015 (`next`) vitest cases pass; the manual deep-link check passes with no
`window.location` assignments left in `src/`.
**Size:** M
**Depends on:** T2

### T6: Refuse dev mode in production builds
**Scope:** the Vite plugin check, `VITE_ALLOW_DEV_AUTH`, the Dockerfile/compose default `token`, the runtime
non-localhost banner, removing `DEV_USER`.
**Acceptance:** the build check exits non-zero; the default compose build is in token mode; the banner renders on a
non-local host in a dev build.
**Size:** S
**Depends on:** T5

### T7: Rebuild the login page and add Settings → Security
**Scope:** branding, error-code messages, inline Telegram errors, token-link URL stripping, the optional token form
in Telegram mode (per Q4), reason banners; the Security section with sessions, revoke actions and events.
**Acceptance:** every FR-007 code renders its message; revoke-all from Settings logs out a second browser; no env var
names appear in the UI.
**Size:** M
**Depends on:** T2, T5
