# 069 tasks

- [x] T1 Follow-ups on cards and the source-change bundle: `payload.then` + `input.skip_then` in `applyOnce` with per-item results; `import_list` `series` / `stop_using` / `disable_skills` with `pendingTables` validation and `import_empty`; active tool descriptions and prompt/skill-file routing; `source_belongs_in_import` refusal; ActionCard follow-up checklist and results (English); runbook §§ 24–25 updated; tests.
- [ ] T2 Skill conflicts: `skillConflicts` / `sourceInSkill` in skill-warnings, `listForAgent` dep, hard/soft follow-ups on `write_skill` cards; tests with the review-4 pair.
- [ ] T3 Owner noise: union + numeric growth + `runLength` in `decideNote`; past days fire only first; edit-in-place (`retarget`, `api.edit`, fallbacks) with `supersede` returning ids; demotion to info + the daily «Повторюється без вашої реакції» block; `event_not_covered` gated; tests (unit + owner-bot PG).
- [ ] T4 Manager: deterministic `escalate()` in housekeeping (two triggers), escalation notes and memory lines, digest `escalations` + not-followed open list, `submit_review` `escalations` with `checkEscalations`, `DEFAULT_MANAGER_TIMES ['09:00']`, `cache: false`, `postOnce` dep; tests (unit + PG for the SQL).
- [ ] T5 Chat and attribution: write claims, backing from earlier turns and applied cards, claim retry without the first answer; `origin_mismatch` lint, chat read capture into draft lint, skill refusal for `origin=original` with a source; tests; docs (runbook § 28, specs README row 069 DONE, spec status done).

## Status

- T1 — done (commit below in `git log`: «069 T1»).

## Deltas from the spec

- **T1 · `prepareSeriesChange` option.** The spec names `{ pendingTables: [dataset] }`. The option is `{ pendingTables?: string[]; pendingEntities?: Record<string,string> }`: the entity of the dataset being created is needed for the format check of A3 (`datasetFormat(new_schema.entity)` against the series format), and the catalog already carries it for datasets that exist. A dataset the library already has keeps its own entity.
- **T1 · where the bundle lives.** The follow-up builder is a new file `docs/import-bundle.ts` (`buildBundle`, `thenLine`); `import-list-tools.ts` only calls it. `ImportPayload` and `payloadOf` are not touched: the tool spreads `then` into the payload (`{ ...payloadOf(…), then }`), so 070's `split_on` edits there do not conflict. The new zod fields are at the end of `ImportListInput`.
- **T1 · skipped items.** An item in `input.skip_then` is recorded `{ ok: false, error: 'skipped' }`; an item with `ticked: false` and no `skip_then` at all is `not_ticked` (A2). Both show on the card as «left unticked» / «not ticked».
- **T1 · limits.** At most 8 follow-ups per card (`MAX_FOLLOW_UPS`, checked at propose time with the registered kinds and unique keys); `disable_skills` takes at most 5 names. A name already switched off is dropped with a note (`follow_up_notes`), not an error. A system skill (`safety` / `isProtectedSkill`) is refused with `safety_skill`; the skill's owner handle is resolved over the orchestrator and its children, a shared skill goes on the orchestrator.
- **T1 · `sourceInSkill` is a heuristic.** It returns the first sentence that (a) has `provider=<x>`, (b) takes posts / prompts / content with a verb of taking and names a URL or «API», or (c) names a dataset (`library:x`, `data://x`, «dataset x») together with «only / instead of / лише / замість». A skill about how to use a row, or a link to put into a post, passes. Negated mentions («PromptHero не використовую») are not refused here: the conflict path of T2 handles them.
- **T1 · prompt text.** `buildComposerSystemPrompt` adds the source-change line only when there is no persona (the named agent's persona already carries it). The «do not re-announce a corrected answer» etiquette line from the code map belongs to FR-006 and comes in T5.
- **T1 · loadout.** Nothing to change: `import_list` is `chatOnly`, and loadouts only cover tools that are not chat-only, so a loadout never hides it from the composer. A test pins that (`import-list-tools.069.test.ts`).
- **T1 · dashboard build** needs `VITE_ALLOW_DEV_AUTH=true` locally (the production-build guard); this is not a change.
