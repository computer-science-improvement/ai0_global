# 068 tasks

- [x] T1 Cause and classifier: `skip_slot` `cause` (required) with `skipSlotError` shared with preview-run, prompt lines; `classifyClose` new-format parse, legacy fixes (unanchored code words, Cyrillic-safe regexes, library wins), `planner_*` / `preflight_no_material` codes in skip-cause, skip-reasons, idea-outcome; streak families with critic transparent and the pause-cause mapping; catalog help + runbook § 19; the review-4 replay fixture and tests.
- [ ] T2 Honest empty day and lower minimum: `skipped_series[].cause`, locked skip with a material cause, `short_day` / `short_days`, placeholder slots in the plan transaction, replan supersedes future placeholders, refusal texts; `planPerDay` with pauses (Telegram and network), silent-days uses the lowered minimum; unit + PG tests.
- [ ] T3 Pre-flight on library slots and at plan time: `series:` / `directive:` hints ignored, `data://` / `library://` row checks, `library:<table>` empty check, `preflight_no_material`; `assessPlanned` in `submit_plan` / `submit_network_plan`; `formatAvailable` filters allowed formats; shared `SlotPreflight` wiring; tests.
- [ ] T4 `query_data` `refs` (ids / legacy refs, flags, `ref_dataset_mismatch`, hints); migration 095 (+ down) for `prompts.post_requires` with its PG test; docs (runbook § 27, specs README row 068 DONE, spec status done).

## Status

In progress. One commit per task:

- T1 — `skip_slot` `cause` and `skipSlotError` (shared with the preview dry run), the executor prompt line, `classifyClose` (the cause first, Cyrillic-safe legacy text, `planner_*` / `preflight_no_material` codes), the streak families with transparent critic closes, `not_next_in_order` in the content-failure codes, `SERIES_SKIP_STREAK` help, runbook § 19, the review-4 replay fixture and tests, dashboard skip labels.

## Deltas from the spec

- **T1: anchored legacy codes stay `no_material`** (A5). `source_already_posted:` at the start of the text, the embedded `max_steps: … source_already_posted` form and `preflight_source_used` are still `no_material`, so the 060 tests that pin them are unchanged. Only a guard code inside an agent's sentence is `source_used`, and the new-format `skipped by agent: source_used:`. A streak cannot tell the two apart (one family).
- **T1: `planner_*` is read with the `preflight_*` codes,** before the story check, not after it: the planner's own reason may mention a story, and its code must decide.
- **T1: `cause` is optional in the JSON schema** (the model sees it as required in the description, and a `refine` fails a call with neither `cause` nor `code`). A5 says optional with a `code`; a flat `required` would have refused `code`-only calls from the live-slot and story-guard prompts.
- **T1: one prompt line.** Only `prompts.ts` (executor user prompt) and the zod `describe` name the enum, as A5 says; the other «skip_slot з причиною» lines are unchanged.
- **T1: `StreakHit.cause` is `PauseCause`** (`no_material | source_unreachable`). A critic run is no longer a hit at all, so `PAUSING_CAUSES` stays only as the check in the breaker. `SkipCause` gained `source_used` and `quality`.
- **T1: the fixture holds 45 rows,** all slots of the replayed groups (Prompt, pdr, «AI-новини дня», @game_exchange_dev plain and «Знижки тижня», and 89320f09), not only the skips: the post and the critic rows are what end or pass a run.
- **T1: dashboard labels** (optional in the spec): `skipReason` shows the named cause, the planner's empty day and `preflight_no_material`.
