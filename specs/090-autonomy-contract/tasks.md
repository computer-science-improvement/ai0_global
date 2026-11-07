# 090 tasks

- [x] T1 Registry (FR-001): `autonomy/owner-gates.ts`, the `OwnerGate` type, the closed registry from the spec table, `gateFor(key)`, the `OWNER_SILENCE=wait` mapping, and a pinning unit test covering keys, `onSilence` and the `humanOnly` set.
- [x] T2 Migration 103 + down (FR-010): `autonomy_decisions` with indexes; `AutonomyDecisionsRepository` (`record`, `list`, `markUndone`); a typed `undo` union and the pure `undoCall(undo)`; a PG migration test (apply, re-apply, down).
- [x] T3 Directives (FR-002): catalog default of `DIRECTIVE_TIMEOUT_APPLY_KINDS`, read through the registry. A `timeout_applied` directive goes to its executor in the same housekeeping pass (skips `RESOLVE_WITHIN_MS`). Contest of an applied directive rolls back via the executor. Remove the `NOT_RESPONDING_AFTER` memory line and add the "owner answered N of M" digest fact. Help text of `DIRECTIVE_TIMEOUT_HOURS`. `weekWork` counts applied and dropped. Unit + PG tests.
- [x] T4 Pending actions (FR-003): `PENDING_ACTION_TTL_HOURS` replaces `ACTION_TTL_MS`. `expireOld` routes by the registry: apply through the Apply handler with `applied_by='auto:silence'`, or drop. `change_source` guard (add/limit only, probe within 6 h, not chat). Chat cards always drop. Decision rows. Tests.
- [x] T5 Playbooks (FR-004): pure `structuralForSilence(prev, next)` next to `network/playbook.ts`, with tests. The hourly sweep activates `pending_owner` versions older than `PLAYBOOK_PENDING_HOURS` that are not structural, using the owner-approve path. Decision row with the previous version as undo.
- [x] T6 Pauses (FR-005): log `retryStale` resumes as decisions; `series_resume` joins `AUTO_SAFE_FIX_KINDS`, guarded to `pause_cause_gone`; update the pinning test.
- [x] T7 Audit fixes (FR-006): the safe-kind constant with a pinning test; the hourly check applies safe open findings older than `AUDIT_AUTO_FIX_HOURS` through `runFix` with `by='auto:silence'`; failures go to the daily report once.
- [x] T8 Setup proposals (FR-007): the safe-section constant (read the names from `setup/setup.types.ts`); apply safe sections after `SETUP_PROPOSAL_APPLY_HOURS`; status `partially_applied`; tests.
- [x] T9 Launch (FR-008): catalog default `LAUNCH_GRADUATION=auto`; check that readiness blockers still hold graduation (existing launch tests plus one new).
- [x] T10 Owner surface (FR-009, FR-011): «Зроблено без вас» in the daily report and «Чекає саме на вас» in the weekly; inbox notes outside FR-009 posted as `info` without a Telegram card; the owner-bot sweep reads `autonomy_decisions` for the closing outcome; report tests.
- [x] T11 API + dashboard (FR-010): `GET /api/autonomy/decisions`, `POST /api/autonomy/decisions/:id/undo`; `/app/health` "Decided without you" section (English, compact card + details dialog, Undo where `undo` is set); dashboard test with a mock API.
- [x] T12 Settings (FR-012): catalog entries with English help texts; settings catalog test.
- [x] T13 Verify: unit, PG (scratch DB), `npx tsc --noEmit`, `npm run build` (nest build) on Node 26; dashboard `tsc` + tests; `specs/README.md` row and the migration note.

## Deltas from the spec (merged 2026-11-07)
- `change_source` on silence applies `add` and `replace` (replace of a failing source by a probed one, undo puts the old source back); `remove` never applies.
- Directive timeouts log `undo: null`: executors write playbook versions and card edits, and `contest()` works only from status `new`. The way back is the playbook-version Undo of its own decision. `advice`/`task` timeouts are queued for the orchestrator's next run (no executor).
- An owner's Apply on an overdue card is settled by the registry too (apply with the `auto:silence` mark, or expire).
- Playbooks: the origin of rule lines is not recorded, so without `ownerRuleLines` any dropped or rewritten rule line is structural (waits). Adding rule lines may go ahead.
- Setup safe sections are `formatting` and `examples_voice` only (`brief_profile` rewrites the brief, `schedule` changes the posting rate); setup undo is null (no stored previous values).
- Audit undo exists for `memory_retire` and `skill_inline_off` only; the audit has no pause ports, so `series_resume` runs through readiness.
- `LAUNCH_GRADUATION` default changed in code (`launch-graduation.ts`), not only in the catalog: the code read env with its own default.
- Not mapped in «Чекає саме на вас»: bot admin rights on their own, mode switches (nothing waits). `token_expired` is not a state of its own (`token_invalid`, `no_access` are).
- `series_paused` notes no longer get an owner-bot card (info); Resume / Keep paused stay on the note in the Inbox.
