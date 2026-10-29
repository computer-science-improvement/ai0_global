# 073 tasks

One commit per task, in this order. T1–T6 are the quick wins; they ship value even if the rest waits. Anchors and traps are in `<scratchpad>/w7/map-073.md`. Every commit message ends with `(AI0-251)`. Nothing starts the service, publishes or makes a paid call; PG tests run only with `EDITOR_PG_TEST_URL` (the scratch database).

The tasks follow the spec's section "Amendments after the builder check". `A<n>` and `L<n>` refer to its items; where the body of the spec differs, the amendment wins.

- [x] **T1 Poll cap exempts series and pins (FR-001; A2, A23, A33, A45, A52).**
  - What:
    - exemption by the slot's mark (series or pin) at plan and publish; `pin` in both poll-cap SQLs (`SqlPollCaps.load`, `loadPollPosts`); `playbookSeries` and `exemptSeries` go;
    - `checkPublishGuards` adds only `pin: !!slot.scheduleRuleId`, because it already passes `series` (A52). `chat/drafts.service.ts` is not edited (A2);
    - at plan time the pin exemption applies to `PollCapCtx.recent` rows; `PollSlotLike` gets no `pin` (A23);
    - the two other counters (A33): `AuditPost.pollCapExempt` set by `slotPosts`, skipped by `pollCapCheck`; the digest's `exempt` column, used by `pollsOver` only;
    - `poll_series_over_cap`, `pollSeriesPerWeek` and the `pause_series` conflict fix are removed (the manager directive stays).
  - Files: `roles/poll-cap.ts`, `post/polls/poll-cap-guard.ts`, `tools/role-tools.ts` (:227-230 only), `rules/config-conflicts.ts`, `roles/plan-rules.ts` (:154 call), `network/network-plan.ts` (:235 call), `post/integrity/types.ts` (:26), `post/integrity/checks/polls.ts` (:47-63), `audit/post-audit.service.ts` (`slotPosts` :166-193), `manager/quality-digest.ts` (`PostRow` :162-165, posts query :417-424, `pollsOver` :256).
  - Tests:
    - new `post/polls/poll-cap.073.test.ts` (the guard and `pollCapCheck`); `roles/poll-cap.073.pg.test.ts` for the `pin` column;
    - update `post/polls/polls.test.ts:147-150`, `roles/poll-cap.test.ts:55-60`, `roles/poll-cap.pg.test.ts:76-95` (A45) and `rules/config-conflicts.040.test.ts` (:45, :49, :52, :79);
    - `manager/quality.test.ts` (a quiz series does not raise `polls_over_cap`) and `manager/quality.pg.test.ts` (the column);
    - `post/polls/poll-cap-guard.pg.test.ts` stays green unchanged.
  - Done when: a daily quiz series on a resource with `polls_per_week` 1 passes the guard on every day of a week in the test, an improvised second poll is still refused, and the digest and the post audit do not flag the series.

- [x] **T2 Series format lock at plan time and in lint (FR-002; A20, A21, A22).**
  - What:
    - `lockSeriesFormats(slots, series, defaultRef)` in `submit_plan` and `submit_network_plan`, with A21's matching rule and the changed slots named in the tool result;
    - series slots are exempt from card and section weights;
    - `validatePlaybook` and `seriesProblems` check a series format against `implementedFormats(r.platform)`, and section keys only when their weight is above 0, with a message that names the card (A22);
    - lint's `lockedFormat` is `slot.format` of a series or pin slot (A20);
    - `seriesNote` drops «чи формат».
    - The publish-time `series_format_mismatch` is T11 (A34).
  - Files: `schedule/plan-schedule-rules.ts`, `tools/role-tools.ts` (`submit_plan`, the lint call in `checkPublishGuards`), `network/network-tools.ts` (:405-424), `roles/plan-rules.ts`, `network/network-plan.ts` (:135), `network/playbook.ts` (:109-111, :125), `schedule/schedule.service.ts` (`seriesProblems` :604-605 only), `schedule/series-guard.ts` (:111), `post/lint-post.ts` (:131-134 and `LintIntegrity`).
  - Tests: `schedule/series-format.073.test.ts` (A21: a single plan with no `resource_ref`, and a network plan in which one name exists on two resources; an unknown series is left unchanged; lint's locked format); update tests that expect `формати … недоступні` for weight-0 keys or a series format outside the card weights (grep `недоступн` in `network/`, `launch/` and `setup/` tests); `migration/proposal.test.ts` stays green.
  - Done when: the @pdr case (card quiz, section quiz 0, quiz series) validates as a plan and a playbook, and a submitted series slot in another format is saved in the series format, with the tool result naming it.

- [x] **T3 Ladder keeps locked formats; answer-key rows stay (FR-003; A19, A35).**
  - What: `formatLocked(slot)`; `ladderPlan({ locked })` gives a locked slot only `revise_source` (when the failure is fixable) and `next_candidate`, never an evergreen or `lighter_format` step (A19); the runner's `fallback` passes it; `quiz_answer_mismatch` joins `NEVER_PASS` and the :237 line goes.
  - Files: `silent/fallback-ladder.ts`, `roles/editor-runner.service.ts` (:546-556 only).
  - Tests: `silent/fallback-ladder.073.test.ts` (each failure kind: a fixable and a non-fixable critic reject, lint, a guard); update `silent/pass-row.071.test.ts` :97-100 (`passed` is `[]`) and :129 (false) (A35). The loops at :101 and :158 and the `not_next_in_order` cases stay.
  - Done when: a failed quiz series slot never gets a `lighter_format` or evergreen step, and a `quiz_answer_mismatch` leaves the row unpassed.

- [x] **T4 Mode off is off (FR-004; A25, A44, L6).**
  - What:
    - `claimDue` checks the channel's mode;
    - the scheduler skips a slot it cannot run with `mode_changed`;
    - `skipStale` writes `mode_changed` for off channels;
    - `upsert` off→on skips overdue planned content slots in its transaction;
    - `upsertChannel(key, body, opts?: { replan?: boolean })` starts the day's replan, not awaited and with its errors caught, only under A25's conditions; `EditorOpsDeps.plans` gains `Partial<Pick<EditorPlansRepository, 'getActivePlan' | 'listSlots'>>`;
    - launch's `setMode` passes `{ replan: false }` (L6).
  - Files: `repo/editor-plans.repository.ts`, `repo/editor-channels.repository.ts`, `editor.scheduler.ts` (:212), `api/editor-ops.service.ts`, `editor.module.ts` (:2177-2181, one argument).
  - Tests:
    - `repo/mode-off.073.pg.test.ts`; an `editor.scheduler` unit test with a fake `plans` for the :212 path;
    - `api/editor-ops.073.test.ts` (fake runner): off→on past the plan hour with an empty afternoon starts one replan; no active plan, a placeholder plan, a future planned content slot or `replan: false` start none; a thrown `editor_disabled` or `replan_in_progress` still saves the mode;
    - then run A44's PG list with `EDITOR_PG_TEST_URL`, adding an `editor_channels` row (mode not `off`) where a test inserts slots for a key that has none.
  - Done when: an off channel's due slot stays `planned`, then is skipped `mode_changed` (never «stuck»); switching on at 14:00 with an empty afternoon starts one replan, and with no plan for today starts none (the scheduler plans it).

- [x] **T5 Launch quick fixes (FR-006; A26).**
  - What: the checklist link `/app/agents/inbox?tab=approvals`; new `launch/plan-ahead.ts` `planTodayAndTomorrow` (A26), which the `planAhead` closure calls.
  - Files: `launch/launch-checklist.ts` (:86), `launch/plan-ahead.ts` (new), `editor.module.ts` (`planAhead` :2182-2186 only).
  - Tests: `launch/plan-ahead.073.test.ts` (fake runner and `getActivePlan`: each day once; a non-placeholder tomorrow is left alone; a throwing today still plans tomorrow; tomorrow is right across a DST change); `launch/launch-checklist.073.test.ts` asserts the `first_posts` link from `buildChecklist` (no test pins it today).
  - Done when: Start calls the planner for today and tomorrow once each, and the link opens the Approvals tab.

- [x] **T6 Planner retries survive a restart; the alert says why (FR-005; A1, A11, A13, A14, A43).**
  - What:
    - new `schedule/planner-runs.ts` with `plannerRunsOn(pool, channelKey, tz, day, opts?)` returning `{ n, failed, lastFailedAt }` from one query (A11);
    - seed `plannerTries` only when a key is absent, over A13's window, as `{ n: failed, at: lastFailedAt }` (A13, A43);
    - the runner dependency `lastToolErrors(runId, tool)`; both planner alerts (`runPlanner`, `runNetworkPlanner`) append «Причини: …» with the validator's lines only (A1).
  - Files: `schedule/planner-runs.ts` (new), `editor.scheduler.ts` (`maybePlan`, `maybePlanAhead`, a `seedTries` helper), `roles/editor-runner.service.ts` (:418-420), `network/network-runner.ts` (:274-276), `editor.module.ts` (wire `lastToolErrors` and the pool).
  - Tests: new `editor.scheduler.073.test.ts` with its own fake pool (A13's two cases; one test for today's key and one for the ahead key); `editor.scheduler.test.ts` unchanged; `roles/planner-alert.073.test.ts`; `schedule/planner-runs.073.pg.test.ts` for the SQL (`n`, `failed`, `lastFailedAt`, `since`, the local-day boundary).
  - Done when: a restart after 3 failed planner runs does not start a 4th that day, a restart after 2 waits at least 30 minutes after the second before the third, and the alert carries the validator's lines.

- [x] **T7 A series that stops is noticed (FR-007; A24, A41, A42).**
  - What:
    - `planner_skipped: <reason>` placeholders for non-material `skipped_series`;
    - `EMPTY_DAY_ERROR_RE` as in A42, with no `\b` (it is spliced into Postgres `~`);
    - `RULES` gains `['other', /^planner_skipped\b/]`; `classifyClose` ignores `planner_skipped`;
    - `evaluateSilentDays` adds `stalled:<name>` to the day's `series_missed` parts after two consecutive local days (A24). No new inbox kind. Until T9 the body and alert lines name the code; T9 switches them to `reasonFor`.
  - Files: `schedule/empty-day.ts` (:45, placeholders), `schedule/plan-schedule-rules.ts` (an exported `nonMaterialSkips`), `series-pause/skip-cause.ts` (:92-93), `silent/skip-reasons.ts` (the 068 push :78-83), `silent/silent-days.ts` (:187-218).
  - Tests: `schedule/empty-day.073.test.ts`; `repo/editor-plans.073.pg.test.ts` (A42: `replacePlan` supersedes future `planner_skipped:` and `series_in_quiet_hours:` placeholders; `insertEmptyDay` twice writes one row); `silent/silent-days.073.test.ts` (A24's four cases); `isPlaceholderPlan` (`repo/editor-plans.repository.ts:194`) still holds for a plan of only placeholders.
  - Done when: two days of `planner_skipped` for «Prompt» add one `stalled:Prompt` part, and one day does not.

- [x] **T8 `poll_correct_index` (FR-008; A49).**
  - What: the lint error and its Ukrainian text; grep the tests under `apps/automation/src` for poll-format fixtures with `correct_index` and change the linted ones to `quiz` (`post/render-telegram.test.ts:71` is a render test: check whether it lints).
  - Files: `post/lint-post.ts` (:200-213), and the fixtures the grep finds.
  - Tests: `post/lint-post.073.test.ts`.
  - Done when: a poll with `correct_index` fails lint, a quiz with it passes, and the suite is green.

- [x] **T9 Reason catalogue (FR-014; A10, A28, A29, A39).**
  - What:
    - `reasons/catalogue.ts` with `ReasonEntry` (the contract's text, verbatim), `REASONS`, `reasonFor` and `reasonOfError` (no `codeOfError`), with entries for every code that exists after T1–T8, `planner_skipped` and `series_stalled` included;
    - the dashboard mirror `lib/reasons.ts` (`{ code, en, fix?.en, link? }`) with its drift test, and `reasonLink` (A29);
    - `skipReason` as in A28: special cases kept, then the mirror lookup, no legacy-text port, `fix` and `link` optional, the fallback label "Skipped — reason not classified";
    - the slot details dialog shows the fix line and the link;
    - silent-days lines use the catalogue, T7's stalled lines included.
  - Files: `apps/automation/src/editor/reasons/catalogue.ts`, `silent/silent-days.ts`; `apps/dashboard/src/lib/reasons.ts`, `lib/slot-plan.ts` (:107-125), `lib/slot-plan.test.ts`, `components/editor/SlotPlan.tsx`.
  - Tests:
    - `reasons/catalogue.073.test.ts` with the table `COVERED` over the lists that exist now: `CONTENT_FAILURE_CODES`, `SKIP_SLOT_CAUSES`, `PREFLIGHT_CODES`, the `EMPTY_DAY_ERROR_RE` codes, the `RULES` prefixes, `NOT_A_MISS` and `OWNER` (A39);
    - `apps/dashboard/src/lib/reasons.test.ts` (drift; `reasonLink` for each template, null for an unknown or unresolved one);
    - `lib/slot-plan.test.ts` (only the :31-48 cases whose code gains a fix; the :48 sample keeps its line with the new label);
    - `no-cyrillic-ui.test.ts`; a visual check on the mock API (port 3173).
  - Done when: every listed code is covered, the dashboard never shows "Note", and the drift test fails if a server `en` changes without the mirror.

- [x] **T10 Skip class `config`: the classification (FR-010; A5, A6, A9, A31, A36, A51, L4, L7).**
  - What:
    - `readiness/slot-config.ts` with `CONFIG_FAILURE_CODES` (A6's list) and `isConfigCode` only; the checker is T12;
    - `config` in `SKIP_GROUPS`; the `config` rule, built from the list, before `lint`; `series_source_mismatch` out of content and lint;
    - delete `['other', /^preflight_format_unavailable\b/]` (:80) and rewrite the comment at :74-77; `preflightCauseOf` stays `'infra'` (A5);
    - `config_series_gone` in `NOT_A_MISS` (kept one array literal) and in the dashboard mirror `lib/status-tone.ts:80` (A51);
    - `classifyClose` ignores the config group;
    - every config code in `NEVER_PASS` (A31);
    - `ideaOutcomeOf` returns `accepted` for the config group; `SKIP_UK` and `GROUP_UK` gain `config: 'налаштування'` (A36);
    - catalogue entries of kind `config` for every listed code and for `series_rate_over_card_max`, with their dashboard mirror entries; `COVERED` gains `CONFIG_FAILURE_CODES` (A39);
    - `preflight_no_material` stays material (L4), and the `preflight_host_blocked` entry stays material (L7).
  - Files: `readiness/slot-config.ts` (new), `silent/skip-reasons.ts`, `series-pause/skip-cause.ts`, `silent/fallback-ladder.ts` (`NEVER_PASS` :224), `network/idea-outcome.ts` (:34-46), `owner-bot/owner-reports.ts` (:90-93), `silent/silent-days.ts` (:96-98), `reasons/catalogue.ts`, `apps/dashboard/src/lib/reasons.ts`, `apps/dashboard/src/lib/status-tone.ts` (:80). `api/editor-chat.controller.ts` is not edited (A36).
  - Tests:
    - `silent/skip-class.073.test.ts`: `skipGroupOf` is `config` for every listed code; `classifyClose` is `ignore` for each, `series_format_unavailable` and `series_in_quiet_hours` included (A9); `shouldPassRow` is false for each;
    - update `preflight/slot-preflight.test.ts:155` to `'config'`; `series-pause/series-pause.060.test.ts:49` and `preflight/slot-preflight.test.ts:159` and :165 stay green;
    - `ideaOutcomeOf`, the owner report and the silent-days label with `config_format_mismatch: x` and `series_source_mismatch: x`;
    - `apps/dashboard/src/lib/status-tone.test.ts:95-108` stays green; `reasons/catalogue.073.test.ts` covers the new list.
  - Done when: `series_source_mismatch: x` reads as config in every consumer, the 060 breaker ignores it, and its row is never passed.

- [x] **T11 Config errors at publish end the slot (FR-010 runner part, FR-002 publish part; A20, A27, A30, A31, A34, L1, L3).**
  - What:
    - `publishGuard(slot, refs: { libraryRef?; sourceUrl?; format? })` returns `series_format_mismatch` as in A34, before `series_source_mismatch`; `tools/role-tools.ts:223` and `platform/platform-tools.ts:85` pass `format: spec.format`;
    - `ROW_GUARD_CODES` gains `series_format_mismatch` (A31);
    - `configStop(probe)` in `silent/fallback-ladder.ts`; `StepOutcome` gains `'config'`;
    - `runExecutor` ends the slot after the first attempt and inside `fallback()` as in A30: no ladder, no 15-minute retry, no row pass;
    - the optional dependency `onConfigSkip`, not wired (L1, L3), and the once-a-day owner note through `configNoted` for codes outside `NOT_A_MISS` (A27).
  - Files: `schedule/schedule.service.ts` (`publishGuard` :358-387), `tools/role-tools.ts` (:223), `platform/platform-tools.ts` (:85), `silent/fallback-ladder.ts`, `roles/editor-runner.service.ts` (`runExecutor` :465-495, `fallback` :521-650).
  - Tests: `schedule/series-format.073.test.ts` gains A20's four publish cases; `silent/fallback-ladder.073.test.ts` gains `configStop` and the dropped `libraryRef` on `series_format_mismatch`; new `roles/editor-runner.073.test.ts` with A30's four cases (`passRow` never called, `onConfigSkip` once, the note once per channel, code and day); `schedule/schedule.071.test.ts:42` and `live/live-slots.e2e.pg.test.ts:229-230` stay green unchanged.
  - Done when: a `series_format_mismatch` at publish ends the slot `skipped`, never `planned` for a retry, never `lighter_format`, and the breaker's streak is unchanged.

- [x] **T12 `checkSlotConfig` and the config pre-flight (FR-009; A3, A4, A7, A12, A15, A16, A17, A18, A32, A50, A53, L2, L4).**
  - What:
    - `readiness/slot-config.ts` gains `ConfigProblem` (L3), `SlotConfigSlot`, `SlotConfigCtx`, `checkSlotConfig` and `repairSlotConfig` (A7); `detail` is one English line (A53);
    - `SeriesForSlot.active?`, filled by `seriesForSlot` (A4);
    - the private `seriesMaterial` extracted from `executorContext`, and `ScheduleService.slotConfigContext(card, slot, o?)`: read-only, no inbox call, null when there is nothing to check (A3, A12, A16);
    - `roleTools` and `executorToolNames` in the runner (A12);
    - `EditorPlansRepository.patchSlotConfig`, running slots only, appending to `fallback.repairs`; `SlotFallback.repairs?` (A7, A32);
    - the runner's `slotConfig` dependency and A15's flow (after the derived branch, before the pre-flight), using T11's note and `onConfigSkip`;
    - `readiness/fixtures/onboarding-1027.ts` (L2).
  - Files: `readiness/slot-config.ts`, `readiness/fixtures/onboarding-1027.ts` (new), `roles/editor-runner.service.ts` (`run()` :362-376, `runExecutor` :438-445), `schedule/schedule.service.ts` (:291-330), `schedule/series-guard.ts` (:46-55), `silent/fallback-ladder.ts` (`SlotFallback` :89), `repo/editor-plans.repository.ts`, `editor.module.ts` (wire `slotConfig`).
  - Tests:
    - `readiness/slot-config.073.test.ts`: a pause row gives no problem (A4); `series` null and `[]` (A16); resolution by name and resource, then by name (A17); `preflight_no_material` for an empty required source (L4);
    - `roles/editor-runner.073.test.ts` gains: a repair continues to the writer with the patched row; a gone series skips with no LLM call and no note; A50's tool test; `fallback.repairs` survives the ladder and the retry (A32);
    - `schedule/slot-config-context.073.test.ts`: zero inbox calls on an empty required source (A3), and the null cases (A16);
    - `preflight/slot-preflight.073.test.ts`: a repair, then `preflight.run`, yields the row once (A18);
    - `repo/slot-config.073.pg.test.ts`: `patchSlotConfig` patches a running slot, returns null for any other, and appends `repairs`;
    - the @pdr and @prompts replays on `onboarding-1027.ts`.
  - Done when: a Prompt slot with PromptHero hints runs on `data://prompts/<next>` without a publish-time `series_source_mismatch`, and a slot of a removed series costs $0.

- [x] **T13 `checkPlanSkeleton` (FR-011 without its alert bullet; A1, A8, A22, A54, L2, L3).**
  - What:
    - `readiness/plan-skeleton.ts`: `checkPlanSkeleton(card, playbook, series, resources, day?)`, `SkeletonResource.tz?`, `producibleFormats`, `SKELETON_CODES` (A8, A22);
    - `ScheduleServiceDeps.formatOk?`, wired in `editor.module.ts` as `(f) => formatAvailable(f, env).ok` (A22);
    - `planContext` passes `planDate` and builds `excluded`; `matchDue`, `dueInstances` and the network validator's due map leave those instances out; both validators refuse a slot that names one; `excludedPlaceholders` adds their config placeholders to `empty` (A54);
    - the planner block lists them «не плануй «<series>»: …» (A53);
    - the day maximum is raised to the due series instances;
    - catalogue and mirror entries for `SKELETON_CODES`, appended to `COVERED` (A39).
    - `editor.scheduler.ts` is not edited (A1).
  - Files: `readiness/plan-skeleton.ts` (new), `schedule/schedule.service.ts` (`ScheduleServiceDeps` :48-70, `planContext` :168-196, `plannerBlock` :227), `schedule/plan-schedule-rules.ts` (`PlanScheduleCtx`, :123-144), `network/network-plan.ts` (:110, :150), `schedule/empty-day.ts`, `roles/plan-rules.ts` (:97-101), `editor.module.ts` (`formatOk`), `reasons/catalogue.ts`, `apps/dashboard/src/lib/reasons.ts`.
  - Tests: `readiness/plan-skeleton.073.test.ts` (A8: `series` on both instance codes, `at` when `day` is given; `producibleFormats`); `schedule/plan-schedule-rules.073.test.ts` and `network/network-plan.073.test.ts` (A54 on both planner paths); `readiness/stage-replay.073.test.ts`, "no false blocker on @ai0_global", reading `readiness/fixtures/stage-*.json` and `test.skip` with a reason when the file or a field is missing (L2).
  - Done when: a series at 23:30 with quiet hours from 23 gets a config placeholder and no `plan_invalid` on both planner paths, and the @ai0_global stage file, when present, gives zero problems.

- [x] **T14 Write paths (FR-012; A48).**
  - What:
    - `SkillStore` gains an optional second argument `ports?: { seriesSources?(agentId) }`; `writeAgentSkill` runs `sourceRefusal` and `originRefusal` on every write and the series check only with the port, refusing agent writes and warning on owner writes;
    - `addMemory` lints and returns `conflicts`;
    - `applyOwnerRule` re-lints;
    - the Rules artifact `edit` returns `conflicts`;
    - the memory form shows the warning line.
  - Files: `agents/skill-store.ts`, `agents/skill-warnings.ts` (a `seriesSourceConflict` helper), `api/editor-ops.service.ts`, `agents/agent-chat-tools.ts` (:113-121), `artifacts/artifact-adapters.ts` (rules `edit`), `editor.module.ts` (pass `lint` and `conflicts` to ops and the actions registry, `seriesSources` to `SkillStore`); `apps/dashboard/src/api/editor.ts` (response type), `routes/app.editor_.$channel.tsx` (the memory form block only).
  - Tests: `agents/skill-store.073.pg.test.ts` (agent refused, owner saved with `warnings`); `api/editor-ops.073.test.ts` (`rule_invalid`, `conflicts`); re-run and fix every test that builds a `SkillStore` or calls `writeAgentSkill` (A48's list; grep `SkillStore\|writeAgentSkill` in `*.test.ts`); the existing chat-tool refusal tests stay green.
  - Done when: the old Prompt skill «origin=original, PromptHero» written by the agent through any of the four paths is refused, and the same body from the owner is saved with a warning.

- [x] **T15 Defaults and migration 098 (FR-013; A37, A38, A46, A47, L5).**
  - What:
    - `CARD_DEFAULTS.hashtagMin` 0; `upsert` is not changed (A38);
    - the `effectiveStyle` vocabulary rule;
    - the library key with `SCHEMA_KEY_RE`;
    - over-budget skills listed once in «Інші скіли» for the executor and the composer, and «Ще скіли (load_skill): …» for agent skills (A47);
    - `098_card_hashtag_default.sql` (DEFAULT 0 plus the backfill, nothing else) and its down file (L5).
  - Files: `api/card-input.ts`, `post/style/resource-style.ts`, `roles/prompts.ts` (:35-70, :87-89, :163-166), `roles/editor-runner.service.ts` (the `agentInlineSkills` callers :784 and :856), `database/migrations/098_card_hashtag_default.sql`, `database/migrations/down/098_card_hashtag_default.down.sql`.
  - Tests: `api/card-input.073.test.ts` (A38); `post/style/resource-style.073.test.ts`; update `rules/owner-style-overlay.test.ts:31` and add the platform-ref case (A46); `roles/prompts.073.test.ts` (A47); `repo/card-hashtag.098.migration.pg.test.ts` (A37).
  - Done when: the @pdr replay asks for no hashtags, `library` source `pdr_questions_2025` saves, an over-budget skill shows once in the listed skills, and 098 applies, backfills and rolls back on the scratch database.

- [x] **T16 Docs and close-out.**
  - What:
    - runbook § 33 "Config is not content (spec 073)" in `docs/runbooks/agent-platform.md`, after § 32 if 072 has merged, else after § 31 at :994. It covers the config class, the pre-flight repair list, the poll-cap rule, the format lock, the mode-off behaviour, the catalogue, the `poll_correct_index` change for chat and owner-rule polls (A49), and the accepted limits (A14, A27, A44).
    - `Status: done` in `spec.md`; the "## Status" and "## Deltas from the spec" sections of this file, with the Deltas the amendments name (A11, A14, A23, A27, A44, A2).
    - the `specs/README.md` row 073 (DONE, migration 098) and 098 in the migration paragraph.
  - Files: `docs/runbooks/agent-platform.md`, `specs/073-config-is-not-content/spec.md`, `specs/073-config-is-not-content/tasks.md`, `specs/README.md`.
  - Tests: the full automation and dashboard suites under Node 20 (`nvm use 20.19.6`, `npm run build` in `apps/automation`), plus the PG suite on the scratch database.
  - Done when: both suites are green, the build passes on Node 20, and the README row reads DONE.

## Status

Done. T1–T16 are committed on `worktree-wf_77f463e3-89e-1` (BASE ae131b3b), one commit per task, each after a green build, lint (0 errors, 40 warnings = the baseline) and the full automation suite on Node 20.

| Task | Commit |
| --- | --- |
| T1 Poll cap exempts series and pins | 18f2ef5d |
| T2 Series format lock | 3ac0e2a8 |
| T3 Ladder keeps locked formats | 43311f5a |
| T4 Mode off is off | 03248e8c |
| T5 Launch quick fixes | 4a2bd75b |
| T6 Planner retries survive a restart | 8f2ca02b |
| T7 A series that stops is noticed | c1fd7e5e |
| T8 `poll_correct_index` | c9bde8d3 |
| T9 Reason catalogue | 384a16ca |
| T10 Skip class `config` | 86a8a2ae |
| T11 Config errors at publish | b15ac76a |
| T12 `checkSlotConfig` and the pre-flight | 76e3e351 |
| T13 `checkPlanSkeleton` | 797f1510 |
| T14 Write paths | e3b73adc |
| T15 Defaults and migration 098 | 28d9f257 |
| T16 Docs and close-out | the commit that carries this file |

Migration: `098_card_hashtag_default` only (with its idempotent down file). Runbook: § 33 in `docs/runbooks/agent-platform.md`.

## Deltas from the spec

The amendments name these first.

- **A2.** `chat/drafts.service.ts` is not edited. It passes neither a series nor a pin and has no slot to read them from, so a chat poll or quiz is improvised and stays capped by the card's `polls_per_week`.
- **A11.** `plannerRunsOn` returns `{ n, failed, lastFailedAt }`, not a number. 074's ceiling reads `.n`.
- **A14.** Two limits are accepted: owner replans and Start's planner runs count toward the scheduler's three tries (after 20:00 the ahead window and today's retries overlap), and after a restart the next day's `maybePlan` does not see the previous evening's failed ahead tries, so it may try up to three more times.
- **A23.** Submitted plan slots never carry a pin (code materialises pins). At plan time the pin exemption applies to the `PollCapCtx.recent` rows only; `PollSlotLike` gets no `pin`.
- **A27.** The once-a-day config note is kept in the runner's memory (no table), so a restart can repeat it once that day. The lead deletes it at the 072 merge (L1).
- **A44.** A deleted channel's slots have no `editor_channels` row; they stay planned until `skipStale` writes «stale: …». That is accepted. The A44 PG list ran file by file (see T4 below).

Per task, in the order the work was done:

T1 18f2ef5d
- The digest's and post audit's `exempt` SQL also counts a `series:` hint (A33 names only the columns); consistent with the guard.
- `PollCapCtx.recent[].pin` is optional; `pollCapGuard` now returns null without a query for a series or pin slot.
- `ResourceConfig.pollsPerWeek` (`rules/config-conflicts.ts`) stays in the interface but nothing reads it any more (the service still fills it).
- New helper `pollCapExempt` in `roles/poll-cap.ts`; `exemptSeries` and `SeriesLike` are gone.

T2 3ac0e2a8
- A series slot is exempt from the card/section weights but `validatePlan` still refuses a format that cannot be produced here (`SUPPORTED_FORMATS` / `formatOk`, e.g. a carousel without hosting): «формат X серії «Y» зараз неможливий тут». T13's `series_format_unavailable` takes that case out of the due set before the planner is told to plan it.
- `validateNetworkPlan` exempts a slot whose `series` is due that day; it checks the format against `implementedFormats(platform)` instead of the section weights.
- `lockSeriesFormats` matches inactive series too; `checkSlotSeries` / `due` still reject a slot of an inactive series afterwards.
- The tool result key for the lock is `format_locked` (also appended to the `plan_invalid` details so a rejected plan still tells the planner what code changed).
- The section-key message for a Telegram resource names the card: «формати X недоступні — у картці каналу їх немає (або вага 0); …».

T3 43311f5a
- `formatLocked` also treats a `series:` hint as locked (a series instance planned before the column was set) and a poll / quiz slot with a `data://` / `library://` hint; a non-poll slot with a dataset hint stays unlocked.
- `silent/pass-row.071.test.ts` :97-105: the quiz case moved into the loop of codes that never pass the row; the :158 `not_next_in_order` cases are untouched.

T4 03248e8c
- `upsertChannel` awaits the cheap checks (hour, active plan, slots) inside a try/catch and does not await the planner: `replan(key, { wait: false })` is started with `void … .catch(log)`. The save never fails on them.
- The replan skip is logged with the HttpException's `error` code (`editor_disabled`, `replan_in_progress`), not just its class name.
- `editor_plans.channel_key` has an FK with ON DELETE CASCADE, so a deleted channel's slots are deleted with its plans; the A44 note about slots of a key without an `editor_channels` row only concerns direct inserts. None of the twelve listed PG tests (nor `payments/ad-revenue.pg.test.ts`, which also calls `claimDue`) needed a channel row added.
- A44's list passes file by file. Run in one `tsx --test` process set against the shared scratch DB, `network/derived-slots.e2e.pg.test.ts` failed once because a concurrent test file's `claimDue` took its duplicate slot; the same race exists on BASE (every `claimDue` claims any due slot in the DB).
- `skipStale` writes `mode_changed` after the derived `source_not_published` update, so a derived slot of an off channel keeps naming its source.

T5 4a2bd75b
- `planTodayAndTomorrow` also catches a failing `getActivePlan` read for tomorrow (logs and does not plan blindly); a plan whose rationale is null counts as a real plan, as in `maybePlanAhead`.
- The dashboard's `lib/launch.test.ts` still uses `/app/approvals` as an arbitrary internal path for `isExternal`; it does not pin the link, so it is left alone.

T6 8f2ca02b
- `lastToolErrors(pool, runId, tool)` and the `reasonsClause` formatter live in `schedule/planner-runs.ts` beside `plannerRunsOn`; the alert puts «Причини: …» on its own line.
- A failing seed read leaves the key absent; once the process makes its own try the key is in the Map and is not read again (the in-memory count takes over).
- The scheduler tests are appended to the `editor.scheduler.073.test.ts` that T4 created; the pool there answers the `plannerRunsOn` SQL by matching `e.role = 'planner'`. `editor.scheduler.test.ts` is unchanged and green.
- The network planner's alert is tested with a real `NetworkRunner` over a fake repo (`planner-alert.073.test.ts`).

T7 c1fd7e5e
- `stalledSeries` (exported from `silent/silent-days.ts`) qualifies a close by skip group `lint` or `other` (`planner_skipped` is in `other` through the RULES line). The `config` group joins in T10 (`STALL_GROUPS`).
- Until T9 the stalled body and alert lines named the code of today's latest close; T9 switched them to the catalogue.
- The stalled part is added to today's `series_missed` note only; yesterday's note (reported once, A8) is untouched. The part is `stalled:<name>`, one per series.
- `insertEmptyDay` already treats a second placeholder of the same series within 90 minutes as the same close (spec 068), whatever its code; the PG test uses instants more than 90 minutes apart for separate rows.

T8 c9bde8d3
- No linted fixture needed changing: the only `format: 'poll'` with `correct_index` is `post/render-telegram.test.ts:71`, a render test that never lints; every other fixture is a quiz.
- `schedule/schedule-cards.pg.test.ts` test 1 asserted that `format: 'video'` is refused for a Telegram series; since T2 (a series' format only has to be implemented on the platform) `video` passes, so the refused case now uses `reel` (not a Telegram format).
- Runbook § 33 says that a chat or owner-rule poll that carries `correct_index` now fails lint as `poll_correct_index`.
- Three PG files (`playbook-examples`, `network-offers`, `executors`) fail on the shared scratch DB only because of leftover `pgt034t5_sky*` agents from other runs (`uq_agents_top_scope`); they pass on a fresh throwaway migrated DB.

T9 384a16ca
- `reasonFor(code)` returns `ReasonEntry | undefined` (a caller falls back to the bare code); besides the contract's `REASONS`, `reasonFor` and `reasonOfError`, the catalogue exports `reasonText(error, 'en' | 'uk', max?)`: «label: the system's words (80 chars) — what to change», or the raw text clipped when there is no entry. The silent-day lines use it.
- Entries (66 at that commit) also cover the skip groups, the run statuses, the unreachable-source codes, `story_skip`/`story_repeat`, `guard_failed`, and the legacy texts (`retrying`, `waiting_for_budget`, `required_source_empty`, `superseded`, `draft_canceled`, `rejected_by_owner`, `agent_paused`, `skipped_by_agent`, `skipped_by_owner`); `reasonOfError` maps each of those.
- `series_format_unavailable` and `series_in_quiet_hours` have entries of kind `config` because `EMPTY_DAY_ERROR_RE` names them; `series_source_mismatch` and `preflight_format_unavailable` are kind `config` too (kind is a display group).
- The A28 special cases keep today's label strings and their own `code` strings; each borrows the `fix` and `link` of the catalogue entry of its server code. The `skipReason` link is the path TEMPLATE; `reasonLink(entry, vars)` fills it.
- The data route's `TABS` moved to `lib/data-tabs.ts` (`DATA_TABS`, `isDataTab`) so that `reasonLink` validates `?tab=` against the same list (I12); the route imports it.
- `SlotDescription` takes `links?: { channel?; agent?; dataset? }` (full view only); the agent Plan passes the handle and the Telegram channel key, the slot page passes the channel key (so an `:agent` link is left out there and the fix line stays).
- The Telegram alert of `series_missed` now lists its lines in Ukrainian (it reused the English lines before).
- The dashboard mirror body was generated from the server file by a script; `reasons.test.ts` evaluates the server's `REASONS` literal, so the literal must stay free of helpers and spreads (a comment in the server file says so).
- Visual check on the mock API (port 3173, stopped): the slot page shows the label, the detail, «What to change: …» and the link; an unresolved `:agent` leaves the line without a link; an unknown text reads "Skipped — reason not classified".

T10 86a8a2ae
- `SKIP_GROUPS` is `['critic', 'lint', 'config', 'cap', 'nothing_fresh', 'budget', 'other']`; the `config` rule is built from `CONFIG_FAILURE_CODES` and sits before `lint` in `RULES`.
- Until T11 a `series_source_mismatch` at publish is no longer a content failure (`classifyFailure` returns null for it); T11 adds `configStop` and ends the slot at once.
- The catalogue gains the `config` group entry and entries for `config_series_gone`, `config_format_mismatch`, `config_source_mismatch`, `config_source_missing`, `config_tools_missing`, `series_format_mismatch` and `series_rate_over_card_max` (all kind `config`). The dashboard mirror was regenerated.
- `status-tone.ts` NOT_A_MISS gains `config_series_gone` in the same commit as the server list (A51).
- `ideaOutcomeOf` returns `accepted` for the config group next to budget and cap; `silent-days` `STALL_GROUPS` gains `config`.
- `lint-changed.sh` lists one pre-existing warning in `owner-bot/owner-reports.ts:382` (not touched); the total stays at the 40-warning baseline.

T11 b15ac76a
- `configStop` writes `code` alone (no trailing ": ") when the tool error has no details; with details it is `code: details`, clipped at 500, as A30 says.
- In the first-attempt path `runExecutor` keeps the slot's earlier `fallback.steps` (a retry's steps) and adds no step; the ladder path adds the step with outcome `config` and its reason (300 chars) and ends with `final = { code: 'config', step: <the step> }`.
- `noteConfigSkip` calls `onConfigSkip(channelKey, code)` first (a throwing hook is swallowed), then the once-a-day note; a code for which `isNotAMiss` is true (`config_series_gone`) sends no note. The note is `⚙️ <channel>: <entry.uk>. <fix.uk>`, the bare code when the catalogue has no entry; the day is the card's local date; the map lives on the runner, so a restart may repeat a note once that day (no table).
- The lead deletes `noteConfigSkip` and the `configNoted` map at the 072 merge and wires `onConfigSkip` to the readiness recheck (L1); nothing else imports them.
- `role-tools.ts` publish_post is covered by the type (`format: spec.format`) and by the platform twin's test; the Telegram tool test would need the whole lint/ledger stack, so there is none.

T12 76e3e351
- (I1) `seriesMaterial(series, ref, { roll })` is the extracted reader. `executorContext` (a run) passes `roll: true`, because a finished cycle round must be rolled or the run would skip a series that has material; `slotConfigContext` passes `roll: false` and reaches both ports (`unposted` and `nextRow`) with it. The options exist now in `data/data-query.ts` (`nextInRound(..., { roll })`) and `data/data-catalog.ts` (`CatalogOptions.roll`), and `editor/schedule/next-row.ts` has the new `unpostedPort(pool)`; `nextRowPort` forwards the option. 071 owns the same option at the merge (I1): the three signatures are the ones the spec's I1 names, so the merge should be a no-op.
- (I1) A cycle dataset whose round is done but not yet rolled, with postable rows left, reads as `material: null` (unknown) from the config check, not «empty»: the run will roll it. `repo/slot-config.073.pg.test.ts` pins that `slotConfigContext` leaves `data_reuse_rounds` unchanged and that `executorContext` then rolls it. A dataset with no postable row at all reads «empty»; a `reuse never` dataset is «empty» once every row is used.
- `config_tools_missing` and `config_source_missing` apply in both source modes (`suggested` and `required`), as the spec's literal text says; only `preflight_no_material` is limited to a required source. `library://` hints (aliases of the series' own dataset) are not flagged as stray; a URL, a `data://` or `library:` hint of another dataset is.
- The repair note is `<code>: <what changed>` per repaired problem, joined with `; ` (`config_format_mismatch: text → quiz`, `config_source_mismatch: hints → series:Prompt, data://prompts/13`); `{ note: '' }` means nothing was repairable and nothing is written. Hints repair to `series:<name>` plus the next row, else the series' own dataset hints (`sourceHints(source)`).
- The gate fails open: a thrown error from the context, the patch or the check lets the slot go on as before; a patch that returns null (the slot is no longer running) leaves the problem standing and the slot is skipped with it.
- Every `ConfigProblem` carries `series` (the name the slot gave, `config_series_gone` included); `detail` is one English line and the Ukrainian text comes from the catalogue. `config_source_mismatch` is only reported for a `required` library series; a `suggested` one may name other material.
- (I5, I13) `isRepairable` (true only for `config_format_mismatch` and `config_source_mismatch`) and `SOURCE_READ_TOOLS` (library → query_data, search_library; feed → fetch_feed, web_fetch; api → fetch_api; network_highlights → get_network_highlights) are exported from `readiness/slot-config.ts`. The names were verified against the real tool builders with a probe; `editor-runner.073.test.ts` builds the same registry for A50.
- (A32) `SlotFallback.repairs` is appended in SQL by `patchSlotConfig` and the runner's three `fallback` writes now spread the existing fallback, so a repair note survives the ladder, the 15-minute retry and the final write.
- `roleTools(role, card, registry, loadoutAllow)`, `executorToolNames(card, { registry, loadoutAllow, exclude })` and `toConfigSlot(slot)` are exported from `roles/editor-runner.service.ts`; `run()` itself uses `roleTools`, so the check and the run cannot drift (A50).
- (L2) The @pdr and @prompts replays run on `readiness/fixtures/onboarding-1027.ts`, a synthetic rebuild of the review's two channels (no stage capture was available in the worktree).
- `editor-runner.073.test.ts`'s `setup()` gained `gate`, `registry` and `loadoutAllow` options and a no-script mode; the T11 tests are unchanged.

T13 797f1510
- `SkeletonResource` gains `quiet?: Quiet` next to `tz?`. The validators judge a slot against its own resource's quiet hours (Instagram's default 22–7 is not the card's), so the check must too; without it the card's hours apply. `skeletonResourcesOf(card, resources, env?)` (I6) builds `tz` and `quiet` from `resourceClock`; `skeletonResourcesWith(card, resources, formatOk?)` is the same with an explicit `formatOk`, which is what `ScheduleService` uses (it has `formatOk`, not an env).
- `checkPlanSkeleton`'s `playbook` argument is reserved for 072's seam (`_playbook`); the check reads the `series` list it is given. Without a day a series gets one problem per code and its detail lists all the times; with a day, `series_rate_over_card_max` looks at that weekday only. A series with both problems on one instance gets both problems from the check; `planContext` excludes the instance once, with the first code (the format).
- (A54) Beyond the spec text, both validators also lower the day's minimum by the excluded instances on that resource (`excludedOn`), as they do for material skips; otherwise a day whose only owed post is the excluded one still demands an improvised post, which is the `plan_invalid` this task removes. `ScheduleService.minPerDay` (the silent-days expectation) is not changed: the excluded instance leaves a config placeholder the day's note already shows.
- The day's maximum is raised to the due series instances in `validatePlan` only (the file the task lists). The network validator keeps `sec.per_day.max`: `validatePlaybook` already refuses a series count above a section's maximum at save.
- The network planner's own «Серії за розкладом» list (`networkPlannerBlock`) still names an excluded instance; the schedule block right below it says «не плануй «<series>»: <reason>» and the validator refuses a slot for it. The network runner has no `ScheduleService`, so it was left alone.
- The refusal text is `слот N (…): серія «X» <date> виключена: <reasonFor(code).uk> — не плануй її`; a series whose every instance is excluded gets it instead of «не за розкладом або неактивна». The planner block line is exactly «- не плануй «<series>»: <uk>» (the English detail when the code has no entry), once per series and reason.
- `planContext` adds `excluded` only when it is non-empty, never for a paused series, and a check that throws excludes nothing. `SCHEDULE_INFRA` now injects `ConfigService` for the env behind `formatOk`.
- Catalogue and dashboard mirror entries for the three skeleton codes already existed (T9 and T10), so this task only appends `SKELETON_CODES` to `COVERED`; no catalogue text changed.
- (L2) No `stage-*.json` exists in the worktree, so "no false blocker on @ai0_global" skips with its reason here. The reading assumes the schedule API's own response shape; the same reading is exercised on a synthetic capture in that shape, including cases where it must fail.

T14 e3b73adc
- `seriesSourceConflict(body, series, opts?)` is the I14 judge, built on `profileOf`, `ruledOut` and `ORIGIN_ORIGINAL_RE` of the older checks (their internals gained one set, `SourceProfile.prescribed`: a `data://` / `library:` key or a `provider=` value anywhere, a host only in a clause that takes or names a source, never a link shown in a post). It returns `SeriesSourceConflict[]` with `reason` `other_source`, `rules_out_source` or `original_with_source`. `SeriesSourceFact` carries `{ series, kind: library|feed|api, ref, format?, brief? }`; `seriesSourceFacts(series)` (new `agents/series-sources.ts`) builds it from the active `source_mode: required` series of a playbook, and `requiredSeriesSources({ agents, network })` is the `SkillStore` port (a child agent is judged on its parent's playbook).
- A skill is judged against the series it is about: the only required series when the agent has one, else those that share a format word or a name word with the skill (`topicOf`, as `skillConflicts` does). A skill about no required series gets no series verdict. `origin=original` counts only with a library or feed series, and not in a sentence with a negation, another origin or «власн…» / «own».
- `skillWriteProblems(body, series?, opts?)` is the one list every path uses: the two chat-tool checks (same refusal objects) plus the series ones, each with an English owner `warning`. When `originRefusal` already fired, the series' `original_with_source` is dropped (one finding, said once).
- `SkillStore.writeAgentSkill` runs them after the agent guards (`safety_skill`, `skill_locked`, `owner_authored` come first). An agent write is refused with `problems[0].refusal` (`{ error, details, hint }`; the result type gained `hint?`). An owner write is saved and returns `warnings: SkillLintIssue[]` (`{ code, message }`), also appended to `lint.warnings`, because the skills tab already toasts `lint.warnings` and the dashboard needed no edit. `warnings` is absent when clean. The new public `SkillStore.writeProblems(agentId, text)` is what the chat tools and the skill artifact's `check` call.
- Beyond the file list, the chat's `edit_my_skill` and the builder's `write_skill` also refuse a series conflict at proposal time (`seriesRefusal` in `skill-conflict-followups.ts`, through `writeProblems`; without it they behave as before). Otherwise the old Prompt skill, which passes `sourceRefusal` and `originRefusal`, would reach the owner as a card and be saved with a warning only. The skill artifact gained a `check` (an agent's card is refused at once, FR-002 of 048) and its `edit` returns `warnings` for the owner.
- `ConflictNote`, `newConflictsOf(before, after, ruleIds)` and `conflictNote` live in `rules/config-conflicts.ts`; `newConflicts` in `agent-chat-tools.ts` delegates to `newConflictsOf`. The three rule paths return `conflicts: [{ code, ref, detail }]` only when non-empty: `addMemory` (`{ id, conflicts? }`), the Rules artifact `edit` (`AdapterEdit` / `EditResult` gained `warnings?` and `conflicts?`; `ArtifactsService.patch` returns them beside the detail; the update-artifact tool and its Apply pass `conflicts` on), and `applyOwnerRule(memory, p, { lint?, conflicts? })`.
- `addMemory` lints kinds `rule` and `avoid` only; an insight is a note and is not linted or checked for conflicts. The 400 body is `{ error: 'rule_invalid', details: ['«<text>»: <detail>', …] }`, the Rules artifact's own format. `applyOwnerRule` throws `rule_invalid: <code>: <detail>` at Apply, which fails the card with the reason (a `KeepPendingError` would leave an unappliable card, since the text cannot be edited on it).
- `editor.module.ts`: `channelRuleLint(infra)` and `channelConflictNotes(pool, repos, infra)` are the one lint and the one conflicts read for the memory form, the Rules artifact and the Apply; `EDITOR_OPS` now injects `AGENT_INFRA` (no cycle: `AGENT_INFRA` injects neither). The dashboard (`api/editor.ts`, the memory form of `app.editor_.$channel.tsx`) shows one English amber line «Saved, but it conflicts with the channel setup: …»; a 400 clears it and the toast says why. The Artifacts panel's own types were left alone (the fields ride in the response).

T15 28d9f257
- The two `agentInlineSkills` callers are in `roles/editor-runner.service.ts` (the derived adapt and the native platform executor); the line numbers in the task text (:784, :856) had moved. The adapt path builds `own` once and passes `[...own.inline, moreSkillsLine]` as `agentSkills`; the native path names the overflow in «Ще скіли (load_skill): …» only when the executor skill list below it does not already carry the name (that list holds every executor skill, so a skill that applies to the executor shows once, there).
- `inlineSkills` / `agentInlineSkills` report `overflow` only for a skill that exists and did not fit, and never for a voice skill (`human-voice`, `anti-slop`, `voice-core`; they have their own reference line). `agentInlineSkills` keeps its old inlining of a voice name from `inlineNames` when it fits; only its overflow skips them. `buildSystemPrompt` lists the overflow for every role (planner and reviewer too), with the skill's own description, clipped for the writer like the other listed skills. The description comes from `skills.get(name)`, so a skill the role's `list()` does not include is still reached when the card or the agent asked for it.
- `moreSkillsLine(overflow)` is exported from `roles/prompts.ts` for the runner.
- The library-source message in `card-input.ts` changed from "library sources take a table name" to "library sources take a dataset key (a-z, 0-9 and _, starting with a letter)"; no test pinned the old text.
- `effectiveStyle` leaves an explicit stored `off` alone; only a stored `vocabulary` with `Array.isArray(vocabulary) && !vocabulary.length` becomes `off`. `makeDefaultCard` (chat) already had `hashtagMin: 0`; `upsert` is unchanged (A38).
- `rules/owner-style-overlay.test.ts` carries A46's three cases. `card-hashtag.098.migration.pg.test.ts` creates its own database like the 095 test and applies every migration except 098 (097 is absent here).

T16 (this commit)
- Runbook § 33 is placed after § 31 (the dashboard redesign): § 32 (spec 072) has not merged in this branch. If 072 lands first, renumber.
- The final report's browser checks: the slot dialog fix line and link (T9, mock port 3173) and the memory form's amber conflict line (T14, mock port 3173). Both mock servers are stopped.
- Verification at the end: build on Node 20 exit 0; lint 0 errors, 40 warnings (the baseline); automation `npm test` without PG 4362 tests, 3852 pass, 0 fail, 510 skipped (the PG files); all 128 PG test files run one at a time against a fresh migrated database: 509 tests, 509 pass, 0 fail, 0 skipped; dashboard 633 of 633 and `tsc` exit 0; dashboard `vite build` passes.
- Two PG tests fail at random when every file runs in parallel against one database, and pass alone and in the serial run: `manager/quality.pg.test.ts` («stable without changes»: the digest hash covers network-wide state that a parallel file changes) and `network/network-offers.pg.test.ts` (it offers a legacy group a parallel file created). Each of the two whole-suite runs hit exactly one of them, a different one each time. Neither file's subject was changed by 073 beyond T1's `exempt` column in the digest, which its own tests cover.
