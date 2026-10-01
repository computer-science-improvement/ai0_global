# 001 — Audit critical fixes

**Status:** In progress · **Branch:** feat/editor-agent · **Source:** re-audit 2026-10-01

## Why
The re-audit confirmed a set of defects. Each one either exposes production (open data stores, a
fail-open login, a shell-capable agent fed with untrusted input), silently breaks money flow (the LiqPay
callback returns 404), or raises the risk of a Telegram account ban (flood-wait handling never fires).
All of them are small and independent, and all must land before the editor agent goes live.

## User stories
- **US1 (owner):** I want the production box to expose only the HTTPS entrypoint, so that Redis,
  Postgres and the raw API cannot be reached from the internet.
- **US2 (owner):** I want login to refuse everyone when the allowlist is empty, so that a missing env var
  cannot hand out admin.
- **US3 (owner):** I want paid ad orders to actually become `paid`, so that the money path works end to end.
- **US4 (owner):** I want the MTProto clients to honour flood-wait, so that my user accounts do not get banned.
- **US5 (owner):** I want CI to run tests on my real branch names, so that regressions are caught.

## Functional requirements
| ID | Requirement | Evidence (before) |
|----|-------------|-------------------|
| FR-001 | Postgres, Redis and automation ports bind to `127.0.0.1` by default. The bind address can be overridden through env. Redis requires a password when `REDIS_PASSWORD` is set. | `docker-compose.yml:12-14,28-29,50-52` |
| FR-002 | Telegram login rejects every user when `TRACKING_ALLOWED_TG_USER_IDS` is empty. | `auth.service.ts:27-30` |
| FR-003 | The production nginx forwards `/api/*` **without** stripping the prefix. Every backend controller lives under `api/` or a known root prefix (`auth`, `health`). The dashboard API base is `''`, and paths carry their own `/api`. External callbacks (LiqPay, TikTok) resolve. | `apps/dashboard/nginx.conf:8-9`, `lib/env.ts:1` |
| FR-004 | LiqPay treats only `success` as paid. `sandbox` counts only when `LIQPAY_SANDBOX=true`. | `liqpay-callback.controller.ts:5` |
| FR-005 | Flood-wait is detected by error class or `seconds` field, not by message regex. The client sleeps or skips for `seconds`, and BullMQ jobs are delayed by that amount. | `agent-mtproto.client.ts:11`, `tracking-mtproto.client.ts:65` |
| FR-006 | Runtime Agent SDK calls (`semantic-dedup`, `topic-router`) do not run with `bypassPermissions` + project settings. They use `permissionMode:'default'`, an explicit empty `allowedTools`, and `settingSources: []`. | `semantic-dedup.service.ts:58-60`, `topic-router.service.ts:38-40` |
| FR-007 | `parseVerdict` in semantic dedup is exact-token, so "NOT A DUPLICATE" ≠ DUPLICATE. | `semantic-dedup.service.ts:89-95` |
| FR-008 | `init-db --reset` refuses to run unless `ALLOW_DB_RESET=yes` and `NODE_ENV !== production`. | `apps/pipeline/src/init-db.js:23-31` |
| FR-009 | `apps/pipeline/src/data/normalized/pdr/auth.json` is untracked and gitignored. The owner rotates the session (manual). | git ls-files |
| FR-010 | CI runs on `feat/**`, `fix/**`, `feature/**`: lint, automation `tsc`, automation tests, dashboard `tsc`. | `.github/workflows/ci-feature.yml:9` |
| FR-011 | Swagger is served only when `NODE_ENV !== production` or `SWAGGER_ENABLED=true`. | `main.ts:52` |
| FR-012 | `/auth/token-login` and `/auth/telegram-login` are rate-limited (in-memory, 10 req/min/IP). | `auth.controller.ts` |
| FR-013 | Secret comparisons (Bearer, API key, Telegram hash) use `timingSafeEqual`. | `tracking-auth.guard.ts:18`, `api-key.guard.ts:38`, `auth.service.ts:22` |
| FR-014 | A nightly `pg_dump` sidecar profile (`backup`) writes gzip dumps to a host volume and keeps 14 of them. The runbook documents off-box copy and restore. | none exists |
| FR-015 | The single-instance invariant is documented in `docker-compose.yml` next to `automation`. | not documented |

## Out of scope
Git history rewrite to purge `auth.json` (owner's call, destructive). Dependency major upgrades (see 002/007).

## Success criteria
- SC-1: `docker compose config` shows no `0.0.0.0` publishes for postgres, redis or automation.
- SC-2: New and updated unit tests cover FR-002, 004, 005, 007, 012 and 013, and all of them pass.
- SC-3: A CI workflow file triggers on `feat/**` and contains a test step.
