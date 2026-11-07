# 091 tasks

- [x] T1 Target and state (FR-001, FR-002 states): `slo/slo-target.ts` `dailyTarget`, `slo/slo-state.ts` `sloState`, both pure, with unit tests for every rule and state.
- [x] T2 Replacement test first (FR-003): a scheduler test that pins today's `plainPaused` gate behaviour and the new expected behaviour (a skipped plain slot gets a replacement, the channel keeps planning). It fails until T5.
- [x] T3 Migration 104 + down (FR-002): `channel_slo`; close open non-owner `resource:telegram:%` pauses with `resumed_by='slo'` and an inbox line; `ChannelSloRepository` (upsert day row, grouped counts query); PG migration test.
- [x] T4 Breaker (FR-002): no `resource:` pauses from `SeriesBreaker.check`; `onPlainStreak` hand-off; the repository guard refuses a `resource:telegram:` key without cause `owner`; remove `plainPausedChannels` and the scheduler gate; update the `series-pause.060*` tests.
- [x] T5 Replacements (FR-003): move `freeTime`/`roomBlock` to `slo/slot-time.ts` (news-watch imports them); `controller.onSlotClosed` from `skipByCode`, the ladder's final skip and `skipStale`; insert with `replaces_slot_id` + `ON CONFLICT DO NOTHING`, chain depth 2, `meta.slo`; `REPLACEABLE` keeps `meta.slo` slots; budget gate check; PG tests.
- [x] T6 Recovery ladder (FR-004): `slo/recovery-ladder.ts` `nextRung`; the wider live window up to `SLO_WIDEN_MAX_HOURS` (reuse `scanLive` widening from `72bd12c8`); other pillar by dataset runway; another probed source; evergreen with the dark cap; `starved` note. Optional: `preflight_stale` drops the idea instead of the slot.
- [x] T7 Dark recovery (FR-005): clear `plannerTries` and the persisted counter; the recovery planner context; the evergreen fallback when the planner returns nothing; caps; the 72 h action note keyed by `dark_since`; decision rows (090 `autonomy_decisions`, gate `slo_recovery`).
- [x] T8 Controller tick (FR-010): `SloController` in `EditorScheduler.tick` after the breaker check and before claiming; per-tick caps with a unit test; `SLO_CONTROLLER=off` restores today's path (keep the old gate behind the flag until the 14-day check passes).
- [x] T9 Detectors and manager (FR-006, FR-007): `silent-days` and `escalation` read `dailyTarget`; `dark_day` note becomes `info`; KPI digest `slo` signal; manager prompt line; `task` directives on `recovering`/`dark` channels get `meta.slo.rung='directive'`.
- [x] T10 API + dashboard + report (FR-008): `GET /api/editor/slo`; `/app/health` Channels panel (English, compact card + details dialog, 7-day strip); «Канали» in the daily report shows published/target; dashboard test with the mock API.
- [x] T11 Settings (FR-009): catalog entries with English help texts; catalog test.
- [x] T12 Verify: unit, PG (scratch DB), `npx tsc --noEmit`, `npm run build` on Node 26; dashboard `tsc` + tests; `specs/README.md` row and the migration note.

## Deltas from the spec (merged 2026-11-07)
- The spec's `meta.slo` is the new column `editor_slots.slo` (editor_slots has no meta column). Migration 104 closes the non-owner channel pauses without an inbox line.
- The breaker and the repository guard cover `resource:telegram:` only; platform `resource:` pauses are still created. Both stay as before under `SLO_CONTROLLER=off`.
- The inserter creates a placeholder plan (the reserved-only rationale the planner still replaces) when the day has none; a replacement also refuses when the day is at `postsPerDayMax`. Only slots of the channel's local today are replaced; an expired close never triggers one; an unclassified skip counts as `quality`; a slot the owner touched counts as an approval hold.
- The scheduler also reports every slot after `runExecutor` (deduped by slot id and the unique index).
- `starved` is also set by a plain-slot streak under 24 h with at least 2 rungs tried today and no open SLO slot (one `channel_starved` info note a day). The 72 h note is kind `channel_dark` (action), keyed by `dark_since`.
- An evergreen replacement is an ordinary fixed slot with the evergreen topic and angle (the runner reaches evergreen only as a fallback step). `other_series` considers library series only (dataset runway). `widen_live` adds value only above the 24 h widening `scanLive` already does. Dark recovery respects the evergreen cap too.
- The target in silent days: the `channel_slo` row first, then the pause-aware `minPerDay` hook, then `dailyTarget`. Escalation, the KPI digest and the daily report use the Kyiv day.
- A `task` directive slot is marked when the orchestrator reports it done (`report_directive_done` with `ref_type` slot): no code inserts that slot.
- The HTTP controller is `SloApiController` (the tick is `SloController`). A held channel's bar is empty, not full.
- Not done: `preflight_stale` dropping the idea instead of the slot (optional in the spec).
- Found on dev-stage after the deploy (2026-11-07): a recovery run fired at 23:43 Kyiv into quiet hours, planned nothing and its 24 h spacing pinned the next run to the same dead hour. A run now needs room left in the day and no planned slots ahead (not counted otherwise), and the SLO_DARK_HOURS spacing holds within the local day only.
