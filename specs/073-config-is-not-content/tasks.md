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

- [ ] **T13 `checkPlanSkeleton` (FR-011 without its alert bullet; A1, A8, A22, A54, L2, L3).**
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

- [ ] **T14 Write paths (FR-012; A48).**
  - What:
    - `SkillStore` gains an optional second argument `ports?: { seriesSources?(agentId) }`; `writeAgentSkill` runs `sourceRefusal` and `originRefusal` on every write and the series check only with the port, refusing agent writes and warning on owner writes;
    - `addMemory` lints and returns `conflicts`;
    - `applyOwnerRule` re-lints;
    - the Rules artifact `edit` returns `conflicts`;
    - the memory form shows the warning line.
  - Files: `agents/skill-store.ts`, `agents/skill-warnings.ts` (a `seriesSourceConflict` helper), `api/editor-ops.service.ts`, `agents/agent-chat-tools.ts` (:113-121), `artifacts/artifact-adapters.ts` (rules `edit`), `editor.module.ts` (pass `lint` and `conflicts` to ops and the actions registry, `seriesSources` to `SkillStore`); `apps/dashboard/src/api/editor.ts` (response type), `routes/app.editor_.$channel.tsx` (the memory form block only).
  - Tests: `agents/skill-store.073.pg.test.ts` (agent refused, owner saved with `warnings`); `api/editor-ops.073.test.ts` (`rule_invalid`, `conflicts`); re-run and fix every test that builds a `SkillStore` or calls `writeAgentSkill` (A48's list; grep `SkillStore\|writeAgentSkill` in `*.test.ts`); the existing chat-tool refusal tests stay green.
  - Done when: the old Prompt skill «origin=original, PromptHero» written by the agent through any of the four paths is refused, and the same body from the owner is saved with a warning.

- [ ] **T15 Defaults and migration 098 (FR-013; A37, A38, A46, A47, L5).**
  - What:
    - `CARD_DEFAULTS.hashtagMin` 0; `upsert` is not changed (A38);
    - the `effectiveStyle` vocabulary rule;
    - the library key with `SCHEMA_KEY_RE`;
    - over-budget skills listed once in «Інші скіли» for the executor and the composer, and «Ще скіли (load_skill): …» for agent skills (A47);
    - `098_card_hashtag_default.sql` (DEFAULT 0 plus the backfill, nothing else) and its down file (L5).
  - Files: `api/card-input.ts`, `post/style/resource-style.ts`, `roles/prompts.ts` (:35-70, :87-89, :163-166), `roles/editor-runner.service.ts` (the `agentInlineSkills` callers :784 and :856), `database/migrations/098_card_hashtag_default.sql`, `database/migrations/down/098_card_hashtag_default.down.sql`.
  - Tests: `api/card-input.073.test.ts` (A38); `post/style/resource-style.073.test.ts`; update `rules/owner-style-overlay.test.ts:31` and add the platform-ref case (A46); `roles/prompts.073.test.ts` (A47); `repo/card-hashtag.098.migration.pg.test.ts` (A37).
  - Done when: the @pdr replay asks for no hashtags, `library` source `pdr_questions_2025` saves, an over-budget skill shows once in the listed skills, and 098 applies, backfills and rolls back on the scratch database.

- [ ] **T16 Docs and close-out.**
  - What:
    - runbook § 33 "Config is not content (spec 073)" in `docs/runbooks/agent-platform.md`, after § 32 if 072 has merged, else after § 31 at :994. It covers the config class, the pre-flight repair list, the poll-cap rule, the format lock, the mode-off behaviour, the catalogue, the `poll_correct_index` change for chat and owner-rule polls (A49), and the accepted limits (A14, A27, A44).
    - `Status: done` in `spec.md`; the "## Status" and "## Deltas from the spec" sections of this file, with the Deltas the amendments name (A11, A14, A23, A27, A44, A2).
    - the `specs/README.md` row 073 (DONE, migration 098) and 098 in the migration paragraph.
  - Files: `docs/runbooks/agent-platform.md`, `specs/073-config-is-not-content/spec.md`, `specs/073-config-is-not-content/tasks.md`, `specs/README.md`.
  - Tests: the full automation and dashboard suites under Node 20 (`nvm use 20.19.6`, `npm run build` in `apps/automation`), plus the PG suite on the scratch database.
  - Done when: both suites are green, the build passes on Node 20, and the README row reads DONE.

## Status

## Deltas from the spec
