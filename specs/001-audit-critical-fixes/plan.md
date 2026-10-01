# 001: Plan

## Constitution Check
- I (code guarantees): every fix is deterministic code or config. ✅
- V (least privilege): FR-006 removes the shell-capable Agent SDK path. ✅
- VI (offline tests): every behavioural fix gets a node:test test, with no live calls. ✅

## Approach per requirement
- **FR-001 / FR-015 / FR-014:** edit `docker-compose.yml`.
  - Publish ports as `"${BIND_ADDR:-127.0.0.1}:${PORT}:…"`.
  - Redis gets `command: redis-server ${REDIS_PASSWORD:+--requirepass $REDIS_PASSWORD}`. Use a shell-form command so that an empty password works. BullMQ and ioredis connections read `REDIS_PASSWORD`; check `tracking-queue`/redis config.
  - Add a `backup` profile service (`postgres:16-alpine`) that loops: `pg_dump | gzip > /backups/ai0-$(date +%F).sql.gz`, then deletes all but the 14 newest, then sleeps 24h.
  - Document restore in `docs/runbooks/backup-restore.md`.
  - The file has an unrelated uncommitted `name: ai0_global` line from the owner. Keep it.
- **FR-002:** in `auth.service.ts`, an empty allowlist means throw `ForbiddenException('Login disabled: TRACKING_ALLOWED_TG_USER_IDS is empty')`. Update the tests.
- **FR-003:** `apps/dashboard/src/lib/env.ts` defaults `API_BASE` to `''`. `nginx.conf` gets one `location` per backend prefix (`/api/`, `/auth/`, `/tracking/`, `/activity/`, `/scheduled-posts/`, `/settings/`, `/stats/`, `/health`), each doing `proxy_pass http://automation:3000;` with **no URI part**, so the path is not rewritten. This mirrors `vite.config.ts` exactly, so prod behaves like dev. Remove the `.env.local` requirement comment.
- **FR-004:** `PAID_STATUSES` is computed from config: `['success']`, plus `'sandbox'` when `LIQPAY_SANDBOX==='true'`. Add a test.
- **FR-005:**
  - Add `isFloodWait(err): number | null` in `src/common/telegram/flood-wait.ts`. It checks `err.seconds` (a number) or `err.constructor?.name === 'FloodWaitError'`, falls back to the regex on `err.message`, and also checks `errorMessage === 'FLOOD'` with `seconds`.
  - Use it in both MTProto clients.
  - The tracking client records `floodUntil` and skips calls until that time passes. The agent client does the same.
  - Tracking workers throw `DelayedError` or re-add the job with `delay = seconds*1000` when flooded, where BullMQ allows it. Otherwise they skip and log.
- **FR-006 / FR-007:** in the two services, `permissionMode: 'default'`, `allowedTools: []`, `settingSources: []`. In `parseVerdict`, normalise to upper case, check for `NOT_DUPLICATE`/`NOT A DUPLICATE`/`UNIQUE` first, then require `DUPLICATE` as a whole word at the start.
- **FR-008:** add the guard at the top of the reset branch in `init-db.js`.
- **FR-009:** `git rm --cached`, plus a `.gitignore` entry for `apps/pipeline/src/data/normalized/pdr/auth.json`.
- **FR-010:** edit `ci-feature.yml`:
  - Triggers: branches `feat/**`, `fix/**`, `feature/**`, plus `pull_request`.
  - Jobs: install (pnpm 9 with `--frozen-lockfile`), automation lint + `tsc --noEmit` + `pnpm --filter automation test`, dashboard `tsc --noEmit`.
- **FR-011:** wrap `SwaggerModule.setup` in the env check.
- **FR-012:** add an `RateLimitGuard` (in-memory sliding window keyed by IP) and apply it to both login routes. Add a test.
- **FR-013:** add `safeEqual(a, b)` in `src/common/crypto/safe-equal.ts` and use it in all three places.

## Risks
- FR-003 changes how prod routes requests. Mitigation: the dev config is already proven, and the nginx locations are copied 1:1 from vite.
- FR-001: if the owner relies on remote `psql` to 5433, set `BIND_ADDR=0.0.0.0` explicitly. Note this in `.env.example`.
