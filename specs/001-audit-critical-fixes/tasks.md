# 001: Tasks

Verify after each phase with: `pnpm --filter automation test && (cd apps/automation && npx tsc --noEmit)`.

## Phase 1: Infra (US1)
- [x] T001 [P] Bind postgres, redis and automation (and the dashboard port) to `${BIND_ADDR:-127.0.0.1}` in `docker-compose.yml`. Add the single-instance comment on `automation` (FR-001, FR-015).
- [x] T002 [P] Redis optional password: set the compose `command` and add `REDIS_PASSWORD` to every ioredis/BullMQ connection factory in `apps/automation/src`. Add it to `.env.example` (FR-001).
- [x] T003 [P] Add the `backup` profile service plus `docs/runbooks/backup-restore.md` (FR-014).

## Phase 2: Auth (US2)
- [x] T004 Make the Telegram-login allowlist fail closed, with a test (FR-002).
- [x] T005 [P] Add `safeEqual` with a test, and use it in tracking-auth.guard, api-key.guard and auth.service (FR-013).
- [x] T006 [P] Add `RateLimitGuard` with a test, and apply it to the `/auth/token-login` and `/auth/telegram-login` routes (FR-012).
- [x] T007 [P] Gate Swagger behind an env check (FR-011).

## Phase 3: Money and routing (US3)
- [x] T008 Change LiqPay `PAID_STATUSES` to be config-driven, with a test (FR-004).
- [x] T009 Make nginx forward all prefixes without stripping them, and set the dashboard `API_BASE` default to `''` (FR-003).

## Phase 4: MTProto safety (US4)
- [ ] T010 Add `isFloodWait` helper with tests covering a FloodWaitError-like object, an `errorMessage` of `'FLOOD'` with `seconds`, and a plain Error (FR-005).
- [ ] T011 Use it in `agent-mtproto.client.ts` and `tracking-mtproto.client.ts`, adding a `floodUntil` skip window (FR-005).

## Phase 5: Agent SDK and data safety
- [ ] T012 Lock down permissions on the semantic-dedup and topic-router SDK options (FR-006).
- [ ] T013 Make `parseVerdict` match exact tokens, with tests (FR-007).
- [ ] T014 [P] Add a guard to `init-db --reset` (FR-008).
- [ ] T015 [P] Untrack the PDR `auth.json` and add it to `.gitignore` (FR-009).

## Phase 6: CI (US5)
- [ ] T016 Rewrite `ci-feature.yml`: new triggers, plus tests and dashboard tsc steps (FR-010).

## Done when
All tasks are checked, every test passes, and `tsc` is clean for automation and the dashboard.
