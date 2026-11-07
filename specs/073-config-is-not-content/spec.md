# 073 — Config is not content

Status: done · Builds on 034 (poll cap, ladder steps), 037 (fallback ladder), 047 (dataset formats), 060 (series breaker), 061 (slot pre-flight), 068 (honest empty days), 069 (skill source refusals), 071 (rows in order) · Migration 098 · Linear AI0-251

> **Read the «Amendments after the builder check» section at the end first.** Where it differs from the body, the amendment wins.

Wave 7, W1 (with 072 and 076); it is merged first. The binding contract is `<scratchpad>/w7/contract.md`; the authoritative design is `docs/reviews/2026-10-27-channel-onboarding.md` §6 "073" and §7. The code map with every anchor is `<scratchpad>/w7/map-073.md`. Anchors are at `feat/editor-agent` 1ecb8160.

## Why

The owner's goal: «мені потрібно щоб коли я додаю новий канал то це було просто, швидко і зручно, щоб не доводилось 2 тижні дебажити його роботу».

Today a wrong setting looks like bad content. The writer is paid, the post fails a guard, the ladder retries it in a lighter format, the row is put aside, the breaker counts the skip as a dead source, and the owner reads "Note" or a raw guard line. Two stage channels show it:

- **@pdr_dev_channel.** A quiz went out as a plain poll (review 2, post 1725). The playbook gave quiz weight 0 while the card had quiz. An owner rule asked for «poll з correct_index». There was no series. `hashtag_min 1` with an empty vocabulary made the writer invent `#пдр`. The topic «Білети ПДР» misses `QUIZ_TOPIC_RE`, so the poll cap allowed one quiz a week.
- **@ai0_prompts_dev.** 8 of 9 Prompt slots skipped: `series_source_mismatch`, `origin_mismatch`, «prompt_text порожній». An old skill said origin=original or PromptHero. Owner rule #23 fought the language check.

Failure classes closed (review table §3): **F03** card formats, section weights and `series.format` disagree; **F06** config errors surface only after a paid run, classed as content; **F12** a knowledge question goes out as a plain poll; **F14** the poll cap blocks a quiz series at publish; **F16** series briefs, rules, skills and style disagree (hashtags); **F20** a series' format is not enforced, the ladder turns quiz into text; **F21** card and playbook duplicate formats and the rate; **F23** rule and skill checks depend on the path that wrote them; **F24** planner retries reset on restart, the alert has no cause; **F29** slots of a channel switched off are claimed and swept as "stuck". Quick wins: **F25** (checklist link, plan tomorrow at Start) and **F27** (a series that stops is noticed). Partly **F11** (the reason catalogue; 072 brings the panel).

## What

### FR-001 The poll cap never blocks a series or a pin (F14)

Current: `pollCapGuard` (`post/polls/poll-cap-guard.ts:108`) exempts only series in `playbookSeries` that are owner- or migration-made or locked (`roles/poll-cap.ts:29-31`). `checkPublishGuards` passes `ctx.extras.network.playbook.series` (`tools/role-tools.ts:229`), which `runTelegramExecutor` (`roles/editor-runner.service.ts:659-675`) never sets, so on a Telegram channel no series is exempt. Chat drafts pass none (`chat/drafts.service.ts:191`). At plan time `pollCapErrors` (`roles/poll-cap.ts:36-56`) gets the series list from `plan-rules.ts:154` and `network-plan.ts:235`.

Change:
- A poll or quiz slot or post is **exempt** when it is a series instance (`series_name` or a `series:` hint) or a pin (`schedule_rule_id` set). Exempt posts neither block nor count. No playbook lookup: the mark is on the slot. This replaces the review's "load the resource's full series list" (see Lead calls).
- `PollCapRow` and the `SqlPollCaps.load` rows (`roles/poll-cap.ts:73-94`) gain `pin: boolean` from `s.schedule_rule_id IS NOT NULL`; `loadPollPosts` (`poll-cap-guard.ts:62-84`) selects `series` and `pin` in both branches.
- `PollCapGuardInput.playbookSeries` (`poll-cap-guard.ts:52`) is replaced by `pin?: boolean`; `exemptSeries` goes. `checkPublishGuards` passes `series: slotSeriesOf(slot)` and `pin: !!slot.scheduleRuleId`.
- The refusal text for an improvised slot stays. It no longer says "make a series slot text" because a series slot never gets it.
- `rules/config-conflicts.ts`: the code `poll_series_over_cap` (:150-169), `pollSeriesPerWeek` (:96-100) and the `pause_series` conflict fix (:47, :233-234) are removed. The manager directive kind of the same name is unrelated and stays.

### FR-002 Series format is authoritative for series slots (F03, F20, F21)

Current: nothing compares a slot's format with its series' format. `validatePlan` checks every slot against card weights (`roles/plan-rules.ts:103-104`, :128). `validateNetworkPlan` checks every unique slot against section weights (`network/network-plan.ts:135`). `validatePlaybook` requires every section key, weight 0 included, to be in the card formats (`network/playbook.ts:109-111`) and every series format to be a card format with weight > 0 (:125, via `network-context.ts:92`). `seriesProblems` repeats that (`schedule/schedule.service.ts:604-605`). Lint refuses a format the card lacks (`post/lint-post.ts:131-134`).

Change:
- New pure `lockSeriesFormats(slots, series): { slots, changed: Array<{ i: number; from: string; to: string }> }` in `schedule/plan-schedule-rules.ts`. `submit_plan` (`role-tools.ts:275-311`, before `validatePlan` at :294) and `submit_network_plan` (`network/network-tools.ts:405`, before `validateNetworkPlan` at :424) set a series slot's format to `series.format` before validating. The tool result names the changed slots in one line, so the planner learns.
- `validatePlan` and `validateNetworkPlan` exempt series slots from the card and section weight checks. Card formats and section weights govern only improvised slots.
- `validatePlaybook` (:125) and `seriesProblems` (:604) check a series format against the platform's implemented formats, not card weights. The section-key check (:109-111) flags only keys with weight > 0, and its message names the card ("the card has no quiz; add it to the card or set the weight to 0").
- **At publish.** `ScheduleService.publishGuard` (`schedule.service.ts:358-387`) already resolves the series. It returns `series_format_mismatch` when a series slot's `spec.format` differs from `series.format`. Improvised slots are not checked.
- **Lint.** `LintIntegrity` gains `lockedFormat?: string`. `checkPublishGuards` (`role-tools.ts:202-203`) sets it to `slot.format` for a series slot or a pin, and `format_not_allowed` is not raised when `spec.format === lockedFormat`.
- `seriesNote` (`schedule/series-guard.ts:111`) drops «чи формат» from «Можеш узяти інше джерело чи формат у межах плейбука».

### FR-003 The ladder keeps the format of series, pins and answer-key rows (F20)

Current: `ladderPlan` (`silent/fallback-ladder.ts:293-305`) adds `lighter_format` from `LIGHTER_FORMATS` (:280-285, quiz → text, poll → text) for any slot. `shouldPassRow` (:235-239) puts the row aside on `quiz_answer_mismatch` (:237). `checkQuizGroundTruth` (`post/quiz-ground-truth.ts:16-38`) raises that code only when the row has a known answer and the writer marked another option, so the row is fine and the attempt is wrong.

Change:
- `ladderPlan` takes `locked: boolean`. When it is set there is no `lighter_format` step, and the evergreen step keeps the slot's format or is left out.
- The runner's `fallback` (`editor-runner.service.ts:521-650`, `ladderPlan` at :556) passes `locked = formatLocked(slot)`. That new pure helper in `fallback-ladder.ts` is true for a series instance, a pin, or a poll/quiz slot with a `data://` or `library://` row hint.
- `quiz_answer_mismatch` joins `NEVER_PASS` (:224), and the `:237` line goes. The ladder's next step retries with the code's own text, which since spec 079 names the option by its `num` («правильна відповідь у базі — варіант num=N: "…". Познач саме його як correct_index»).

### FR-004 A channel switched off is off (F29)

Current: `claimDue` (`repo/editor-plans.repository.ts:516-528`) claims due slots of every channel. The scheduler then drops slots of channels outside `listActive` (mode ≠ off; `repo/editor-channels.repository.ts:112-115`) with `continue` (`editor.scheduler.ts:212`), so they stay `running` and `sweepStuck` (:584-599) fails them as «stuck in running (crash?)».

Change:
- `claimDue` adds `AND EXISTS (SELECT 1 FROM editor_channels c WHERE c.channel_key = s.channel_key AND c.mode <> 'off')`.
- `editor.scheduler.ts:212` skips a slot it cannot run with `mode_changed` (the existing `NOT_A_MISS` prefix, `silent/skip-reasons.ts:21`) instead of leaving it running.
- `skipStale` (`editor-plans.repository.ts:568-581`) writes `mode_changed` instead of «stale: missed its time window» for slots of a channel in mode off.
- **Switching back on.** `EditorChannelsRepository.upsert` (:203-255) already audits a mode change inside its transaction (:237-246). On `off → approve | shadow | live` it skips that channel's planned content slots whose time has passed with `mode_changed`. `EditorOpsService.upsertChannel` (`api/editor-ops.service.ts:149-162`) then starts `replan(key, { wait: false })` when the local hour is past `planHour` and today's active plan has no future planned slot. A new option `{ replan?: boolean }` (default true) lets launch's `setMode` (`editor.module.ts:2177-2181`) opt out, because Start plans by itself (FR-006).

### FR-005 Planner retries survive a restart; the alert says why (F24)

Current: `plannerTries` is an in-memory Map (`editor.scheduler.ts:109`), used by `maybePlan` (:344-354) and `maybePlanAhead` (:311-321), with 3 tries 30 min apart (:96-97). A restart resets the count. `runPlanner` sends «планувальник … не склав план (status: error)» (`roles/editor-runner.service.ts:418-420`) without the validator's lines; the network planner does the same (`network/network-runner.ts:274-276`).

Change:
- When a key is missing from the Map, the scheduler seeds it from `editor_runs`. It takes the count and latest `started_at` of the channel's `role = 'planner'` runs that have no `editor_plans.run_id` match. The window starts at the later of the key's first eligible time (plan hour today; for the ahead key, the batch hour today) and now − 6 h. This is the same query shape as `maybeOrchestrate` (:330-342).
- New runner dependency `lastToolErrors(runId, tool): Promise<string[]>`. It reads the last `is_error` step of `submit_plan` / `submit_network_plan` from `editor_run_steps` and returns the validator lines (up to 5, each clipped to 200 characters). Both alerts append them as «Причини: …».

### FR-006 Launch quick fixes (F25)

- The checklist link: `launch/launch-checklist.ts:86` changes from `'/app/approvals'` (no route) to `'/app/agents/inbox?tab=approvals'` (`apps/dashboard/src/nav/registry.ts:81`, `routes/app.agents_.inbox.tsx:11-12`).
- **Start plans tomorrow too.** `planAhead` (`editor.module.ts:2182-2186`) runs `runPlanner(card)` for today and then `runPlanner(card, { planDate: <tomorrow in the card's zone> })`. A tomorrow plan that already exists (not a placeholder) is left alone, as `maybePlanAhead` does.

### FR-007 A series that stops is noticed in two days (F27)

Current: `skippedSeriesPlaceholders` (`schedule/empty-day.ts:50`) writes placeholders only for the material causes (`materialSkips`, `schedule/plan-schedule-rules.ts:152`). An unlocked series that the planner skips for any other reason leaves no trace.

Change:
- Every `skipped_series` entry of a due series leaves a placeholder. A material cause keeps `planner_<cause>: <reason>`; any other cause gets `planner_skipped: <reason>`.
- `classifyClose` (`series-pause/skip-cause.ts:74-102`) returns `ignore` for `planner_skipped`, so the breaker does not count it.
- `silent/silent-days.ts` adds `series_stalled`. It fires when a series had only non-material, non-owner closes on two consecutive local days: `planner_skipped`, the `config` class (FR-010), `lint`, or `other`. That gives one note per series, with subject `missSubject(ref)` (:94) and part `stalled:<name>`, so it merges with today's miss note.

### FR-008 A poll with a correct answer is a quiz (F12)

`lintPost`'s poll branch (`post/lint-post.ts:200-213`) adds the error `poll_correct_index` when `format === 'poll'` and `poll.correct_index` is set. Its text is «опитування не має правильної відповіді: прибери correct_index; питання з правильною відповіддю — це формат quiz, його задає план, не пост». The format lock (FR-002) keeps the writer from switching the format itself.

### FR-009 `checkSlotConfig` and the $0 config pre-flight (F06)

New pure module `apps/automation/src/editor/readiness/slot-config.ts` (the contract's name):

```ts
export type ConfigProblem = { code: string; detail: string };
export interface SlotConfigSlot { channelKey: string; resourceRef: string | null; format: string; seriesName: string | null; sourceHints: readonly string[]; scheduleRuleId?: string | null }
export interface SlotConfigCtx {
  series:  ReadonlyArray<Pick<Series, 'name' | 'resource_ref' | 'format' | 'active' | 'source' | 'source_mode'>> | null; // incl. inactive; null = unknown
  catalog: SeriesSourceCatalog | null;          // network/series.ts, as seriesSourceErrors reads it
  tools:   ReadonlySet<string> | null;          // the executor's tool names after the loadout; null = unknown
  nextRow?: string | null;                      // spec 071's next row of a required library source
  material?: 'ok' | 'empty' | null;             // the required source's unposted count, as executorContext reads it
}
export const CONFIG_CODES = ['config_series_gone', 'config_format_mismatch', 'config_source_mismatch', 'config_source_missing', 'config_tools_missing'] as const;
export function checkSlotConfig(slot: SlotConfigSlot, ctx: SlotConfigCtx): ConfigProblem[];
export function repairSlotConfig(slot: SlotConfigSlot, problems: readonly ConfigProblem[], ctx: SlotConfigCtx): { format?: string; sourceHints?: string[] } | null;
export const isConfigCode = (code: string) => boolean;   // CONFIG_CODES + series_format_mismatch, series_source_mismatch, preflight_format_unavailable
```

Checks, in order:
- `config_series_gone`: the slot names a series that is missing or `active: false`. Today `seriesForSlot` ignores `active` and returns null for a missing series (`schedule.service.ts:291-306`), so the slot runs as an unbound post.
- `config_format_mismatch`: the format differs from `series.format`. **Repairable.**
- `config_source_mismatch`: a `required` library series whose hints name another dataset (`data://<other>/…`, `library:<other>`) or a URL. This is the publish-time `seriesSourceMismatch` (`series-guard.ts:62-91`) moved before the writer. **Repairable:** the hints become `series:<name>` plus `ctx.nextRow`, or `library:<table>` when there is no next row (as `withNextRow` does, `preflight/slot-preflight.ts:157-173`).
- `config_source_missing`: `seriesSourceErrors` (`network/series.ts:119-133`) against `ctx.catalog`. This covers a dataset that does not exist and a dataset whose format is not the series format.
- `config_tools_missing`: the tool the source kind needs is absent from `ctx.tools`. The tools are library → `query_data` or `search_library`; feed → `fetch_feed` or `web_fetch`; api → `fetch_api`; network_highlights → `get_network_highlights`.
- When `ctx.material === 'empty'` for a required source, it returns `preflight_no_material`. That code stays in the material class (FR-010), so the 060 breaker still pauses a dead series. The contract asks that "the required source has material", and that is how this module answers it.

Wiring:
- `runExecutor` (`editor-runner.service.ts:425-498`) calls a new optional dependency `slotConfig(slot, card)` after `seriesContext` (:435-436) and before the material pre-flight (:441-445). Repairable problems are fixed in place at $0 through the new `EditorPlansRepository.patchSlotConfig(id, { format?, sourceHints?, note })`. The note lands in `fallback.steps` as `config_repair`. Any other problem skips the slot with `<code>: <detail>` through `skipByCode` (:735-739).
- `ScheduleService.slotConfigContext(card, slot)` builds the context: the playbook series including inactive ones, the catalog through `seriesSourceCatalog` (`network/series-edit.ts:65`), the next row and the unposted count it already reads (:312-327).
- The tool set comes from a pure helper `executorToolNames(card, ctx)`, extracted from `run()` (:362-376: `intersectAllow` + `executorTools`, `EXECUTOR_DENY` :198), so the check and the run see the same tools.
- `seriesForSlot` returns `active` and is otherwise unchanged.

### FR-010 Skip class `config` (F06)

- `silent/skip-reasons.ts`:
  - `SKIP_GROUPS` (:8) gains `config`.
  - New `CONFIG_FAILURE_CODES` holds the `isConfigCode` set.
  - `RULES` (:25-31) gets `['config', /^(config_\w+|series_format_mismatch|series_source_mismatch|preflight_format_unavailable)\b/]` before `lint`.
  - `series_source_mismatch` leaves `CONTENT_FAILURE_CODES` (:12-16) and the lint pattern (:28).
  - `config_series_gone` joins `NOT_A_MISS` (:21): the owner removed or paused the series.
- `classifyClose` (`series-pause/skip-cause.ts:74-102`) returns `ignore` for the config group. A config skip never counts toward the breaker.
- A config skip returns its idea to the pool (`network/idea-outcome.ts:40-42`), and the group consumers get a `config` label: `owner-bot/owner-reports.ts:91` («налаштування») and `silent/silent-days.ts:96-98`.
- **Runner.** When the attempt's last publish error (`PublishProbe.last`, `fallback-ladder.ts:155-176`) is a config code, the slot ends `skipped` with `<code>: <details>`. That holds whatever the agent did next (a `skip_slot` or nothing), with no ladder step, no 15-minute retry (:474-495) and no row put aside (config codes join `NEVER_PASS`).
- **One owner note.** At most one Ukrainian note per channel and code per local day, through the runner's `notify`. It is built from `reasonFor(code).uk` and `fix.uk` (FR-014).
- **Seam for 072.** The runner gains an optional dependency `onConfigSkip?: (channelKey: string, code: string) => void`. It is not wired in W1; at merge the lead connects it to `ReadinessService.recheck(channelKey, 'config_skip')`.

### FR-011 `checkPlanSkeleton` at plan time (F03, F21)

New pure module `apps/automation/src/editor/readiness/plan-skeleton.ts`:

```ts
export interface SkeletonResource { ref: string; platform: Platform; formats: readonly string[] } // producible here (implemented ∩ hosted)
export function checkPlanSkeleton(card: EditorCard, playbook: Playbook | null, series: readonly Series[], resources: readonly SkeletonResource[]): ConfigProblem[];
```

It checks only active series:
- `series_format_unavailable`: the series format cannot be produced on its resource. Card and section weights are not consulted, because the series is exempt (FR-002).
- `series_in_quiet_hours`: a cadence time falls inside the card's current quiet hours. The playbook was checked at save (`playbook.ts:128-131`), but a later card edit is not.
- `series_rate_over_card_max`: a weekday's instances on the channel's own resource exceed `card.postsPerDayMax`.

Use:
- `ScheduleService.planContext` (`schedule.service.ts:168-196`) computes the problems. A due series named by `series_format_unavailable` or `series_in_quiet_hours` is left out of the due set (`matchDue`, `plan-schedule-rules.ts:123-144`). The planner block (:227) lists it as «не плануй: <detail>», and code writes its placeholder `<code>: <detail>` (config class) with the plan.
- `validatePlan`'s day maximum (`plan-rules.ts:97-101`) becomes `max(card.postsPerDayMax, due series instances)`, since the series is authoritative. `series_rate_over_card_max` is then a warning for the doctor and the alert.
- `maybePlan` adds the problem lines to the planner failure alert (FR-005).

### FR-012 Write paths check what they write (F16, F23)

- **Skills.** `SkillStore.writeAgentSkill` (`agents/skill-store.ts:281`) runs `sourceRefusal` and `originRefusal` (`agents/skill-warnings.ts:284`, :323) for every caller. Today only the chat tools run them (`agents/agent-chat-tools.ts:264-268`, `agents/builder-tools.ts:279-283`); the self-edit (`agent-skill-tools.ts:106`), the dashboard (`agents.service.ts:301`) and the skill artifact (`artifacts/artifact-adapters.ts:380`) do not. A new optional port `seriesSources?(agentId)` returns the agent's required series sources. A body that names another source, or calls read material "original" while a series reads a library or feed, gives `series_source_conflict`. An agent write is refused with the existing error shapes. An owner write is saved and returns `warnings`.
- **Rules.**
  - The memory form, `EditorOpsService.addMemory` (`api/editor-ops.service.ts:331-337`), runs the rule lint used by the Rules artifact (`ownerRuleLint`, `editor.module.ts:453-458`; `lintOwnerRule`, `agents/rule-lint.ts:47`) for kinds `rule` and `avoid`. On issues it answers 400 `rule_invalid`.
  - `applyOwnerRule` (`agent-chat-tools.ts:113-121`) re-runs the lint at Apply, because the card can be days old.
  - All three paths (the form, the Rules artifact `edit` at `artifact-adapters.ts:232-291`, and the Apply) return `conflicts`: the `ConfigConflictsService.forAgent` codes that appear after the write and were not there before.
  - The memory form on `/app/editor/$channel` (`routes/app.editor_.$channel.tsx:140`) shows them as one warning line (English).

### FR-013 Defaults that do not invent (F16)

- `CARD_DEFAULTS.hashtagMin` becomes 0 (`api/card-input.ts:15`; `makeDefaultCard` already has 0, `chat/default-card.ts:24`).
- **Migration 098** `098_card_hashtag_default.sql`:
  - `ALTER TABLE editor_channels ALTER COLUMN hashtag_min SET DEFAULT 0;`
  - `UPDATE editor_channels SET hashtag_min = 0 WHERE cardinality(hashtags) = 0 AND hashtag_min > 0;`
  - the `schema_migrations` footer.
  - The down file restores `DEFAULT 1` only; the backfill is not undone. The column is defined at `042_editor.sql:21-22`, with CHECK at :37.
- `effectiveStyle` (`post/style/resource-style.ts:88-99`): a stored `hashtags: 'vocabulary'` with a known empty vocabulary (`Array.isArray(o.vocabulary) && !o.vocabulary.length`) reads as `off` (:96).
- A card library source accepts dataset keys with digits. `card-input.ts:37` uses `SCHEMA_KEY_RE` (`data/data.types.ts:24`) instead of `/^[a-z_]+$/`.
- An inline skill over the remaining budget is listed with the on-demand skills instead of being dropped (`roles/prompts.ts:41`, :64). `inlineSkills` returns `overflow: string[]` and the prompt builder adds them to the listed names.

### FR-014 One reason catalogue (F11, part)

New `apps/automation/src/editor/reasons/catalogue.ts`, exporting the contract's `ReasonEntry` verbatim, `REASONS`, `reasonFor(code)` and `codeOfError(error): string | null`. `codeOfError` maps a slot error to its code: `<code>:`, `skipped by agent: <cause>:`, `planner_*`, and the legacy texts «stale: …», «series "X": required source … has nothing left» and «retry after …».

- Entries cover:
  - the skip groups;
  - `CONTENT_FAILURE_CODES`, `CONFIG_FAILURE_CODES`, `PREFLIGHT_CODES` and `SKIP_SLOT_CAUSES`;
  - the cap codes (`daily_cap_reached`, `poll_cap_reached`, `min_gap`, `quiet_hours`, `blackout_window`);
  - the critic and budget codes, `no_fresh_item`, `source_not_published`, `stale`;
  - the `NOT_A_MISS` and owner prefixes;
  - `planner_*`, the `checkPlanSkeleton` codes and `series_stalled`.

  `link` uses `/app/editor/:channel`, `/app/agents/:agent`, `/app/data/:dataset` or `/app/agents/inbox?tab=approvals`.
- The test fails when an exported code list has a code with no entry, when `en` or `fix.en` contains Cyrillic, or when `uk` is empty.
- **Dashboard.**
  - `apps/dashboard/src/lib/reasons.ts` mirrors `{ code, en, fix?.en, link? }`. A drift test reads the server file with `readFileSync`, the pattern in `components/chat/SlashMenu.test.ts:23-27`.
  - `skipReason` (`lib/slot-plan.ts:107-125`) takes the label from the mirror and gains `fix` and `link`. The `'Note'` fallback (:124) becomes "Skipped — reason not classified", and `lib/slot-plan.test.ts:48` changes.
  - `SlotPlan.tsx:45` shows the fix line and the link in the slot details dialog.
- `silent/silent-days.ts` uses `reasonFor(code).en` with the fix instead of the raw clip: the dark-day «Latest:» at :165 and the `series_missed` lines at :204.

## Not doing

From §7 of the review, binding:
- no MTProto;
- no code path that changes a mode (FR-004 only reacts to the owner's switch);
- no card-to-playbook mirroring (series are made independent of both instead);
- no paid rehearsal;
- no event bus or DB triggers;
- no stored full prompts;
- no archetype presets or "New channel" dialog;
- no automatic rewriting of skill, rule or brief prose (FR-012 refuses or warns, never edits);
- no stale-drafts card.

Also out of scope:
- the Readiness panel and doctor (072);
- repair after a config change (074);
- dataset publish profiles (075);
- source probes (076);
- `QUIZ_TOPIC_RE` and `content_kind` inference (FR-001 makes them irrelevant for series).

## Tests

Unit tests (no DB, fakes only; `*.073.test.ts`):
- `poll-cap.073`: a series instance and a pin are exempt at plan and at publish and do not count; an improvised poll is still capped. The guard needs no `playbookSeries`. The config-conflicts 040 test drops `poll_series_over_cap` (:45, :49, :52, :79).
- `series-format.073`:
  - `lockSeriesFormats` rewrites and reports;
  - the single and network validators exempt series slots;
  - `validatePlaybook` accepts a quiz series with quiz weight 0 and flags a weight > 0 section key the card lacks;
  - `publishGuard` returns `series_format_mismatch` only for series slots;
  - lint honours `lockedFormat`.
- `fallback-ladder.073`: `ladderPlan({ locked: true })` has no `lighter_format`; `formatLocked` cases; `shouldPassRow` is false for `quiz_answer_mismatch` and the config codes.
- `slot-config.073`: every code, `repairSlotConfig`, the tool mapping per source kind, and `preflight_no_material` for an empty required source. `executorToolNames` equals what `run()` offers, checked on a fake registry.
- `skip-class.073`: `skipGroupOf` returns `config`; `classifyClose` ignores config and `planner_skipped`; the runner (fake loop and repos) ends a slot on a config publish error with no ladder, no retry and no pass.
- `plan-skeleton.073`: the three codes; the due set without excluded series; the day maximum.
- `planner-retry.073`: a seeded count stops a 4th try after a restart; the alert carries the lines.
- `lint-post.073`: `poll_correct_index`.
- `defaults.073`: `CARD_DEFAULTS`, `effectiveStyle`, the library key with digits, overflow listing.
- `catalogue.073`: coverage, no Cyrillic in `en`, non-empty `uk`, `codeOfError` on the stage error texts.
- `silent-days.073`: `series_stalled` after two days, not after one, not for owner or material skips.

PG tests on the scratch database (`EDITOR_PG_TEST_URL`, `*.073.pg.test.ts`):
- `claimDue` skips mode off;
- `skipStale` writes `mode_changed`;
- `upsert` off→on skips overdue slots, and `replan` starts only past the plan hour;
- the planner-retry seed query;
- `patchSlotConfig`;
- migration 098 up and down on a copy with `hashtag_min 1` and empty hashtags;
- the poll-cap SQL `pin` column.

Dashboard (`apps/dashboard`, vitest):
- `reasons` drift test; `slot-plan.test.ts` with no "Note";
- `no-cyrillic-ui.test.ts` still passes;
- launch checklist link;
- visual check of the slot dialog on the mock API at port 3173.

Acceptance replays: `readiness/fixtures/onboarding-1027.ts`, built from the review's stage notes.
- **@pdr_dev_channel.** A quiz series on a card whose section has quiz weight 0 plans as quiz, publishes past the poll cap on day 2, and never lightens to text. An owner-rule poll with `correct_index` fails lint with `poll_correct_index`. `#пдр` is not asked for (no vocabulary means hashtags are off).
- **@ai0_prompts_dev.**
  - A Prompt slot whose hints point at PromptHero URLs is repaired to the next `data://prompts/N` row before the writer.
  - The old skill write «origin=original» by the agent is refused.
  - `series_source_mismatch` at publish is class `config` and never counts toward the breaker.
- **No false blocker on @ai0_global.** Its card and active playbook give zero `checkSlotConfig` and `checkPlanSkeleton` problems for a full day of slots. The fixture is a read-only export (see Lead calls).

## Lead calls (answered — see Amendments)

1. **Poll-cap exemption by the slot's own mark, not the playbook list.** Recommendation: yes. A slot only carries `series:` from a planned series, an inactive series is caught by `config_series_gone`, and chat drafts and the Telegram executor need no network context.
2. **`series_source_mismatch` moves from content to config.** Recommendation: yes. The planner chose the source, not the writer. The pre-flight repairs most cases first, and the publish guard stays as the backstop.
3. **The config pre-flight repairs format and source hints in place instead of skipping.** Recommendation: yes. Only `config_format_mismatch` and `config_source_mismatch` are repaired; they are on 072's closed auto-safe list.
4. **The day maximum is raised to the due series instances** instead of rejecting the plan. Recommendation: yes, following lead decision 1. The doctor warns about it.
5. **The config-skip owner note in W1.** One per channel and code per day; at merge, the lead may route it through 072's blocker note instead. Recommendation: keep it until 072's note lands, then remove it in the merge commit.
6. **The @ai0_global fixture.** Recommendation: the lead exports the card and active playbook from the dev stage through the owner's terminal before T10, with no secrets, as `readiness/fixtures/ai0-global.json`.

## Amendments after the builder check

The builder check (2026-10-29, base 1ecb8160) and the lead's decisions after the drafts (`<scratchpad>/w7/contract.md`, section "Decisions after the drafts") change the body. These rules override it. Every anchor below was re-checked at 1ecb8160. `tasks.md` follows this section.

### Lead decisions

**L1. Lead calls 1–6 are accepted as recommended.** L2 replaces call 6's file name.
- The per-day config note (call 5) ships in W1. At the 072 merge, the lead wires `onConfigSkip` to `ReadinessService.recheck(key, 'config_skip')` and deletes 073's note in the merge commit.

**L2. The stage fixture (call 6).**
- The lead owns it. The file is `apps/automation/src/editor/readiness/fixtures/stage-<channel>.json`, holding raw API responses: `{ channel_key, captured_at, channel, schedule, skills, rules, series_pauses, datasets: [schema] }`.
- 073 never writes or commits a stage file.
- The "no false blocker on @ai0_global" test scans `readiness/fixtures/stage-*.json` and takes the file whose `channel_key` is `@ai0_global`. It builds the inputs from `channel` (the card) and `schedule` (its series). When there is no such file, or a field is missing, it is `test.skip` with a reason.
- The @pdr and @prompts replays use the synthetic `readiness/fixtures/onboarding-1027.ts`, built from the review's description. They never wait for stage data.

**L3. Names other specs import.** Use these exact names. Nothing else is shared.
- `readiness/slot-config.ts`:
  - `type ConfigProblem = { code: string; detail: string; series?: string; at?: string }` (`at` is ISO);
  - the exported types `SlotConfigSlot` and `SlotConfigCtx`;
  - `checkSlotConfig(slot, ctx): ConfigProblem[]`;
  - `repairSlotConfig(slot, problems, ctx): { format?: string; sourceHints?: string[]; note: string }`;
  - `CONFIG_FAILURE_CODES` and `isConfigCode(code)`. These are the single source for 072, 074 and 076. There is no `CONFIG_CODES`.
- `readiness/plan-skeleton.ts`: `checkPlanSkeleton(card, playbook, series, resources, day?)`. 072's seam calls it with the first four arguments, so keep their order.
- `ScheduleService.slotConfigContext(card, slot, o?)`. It is read-only, posts nothing to the inbox, and is the one loader of `SlotConfigCtx` for 072, 074 and 077.
- `executorToolNames(card, ctx)`, extracted from the runner (A12).
- `EditorPlansRepository.patchSlotConfig(id, r)`. It patches running slots only. 074 writes planned slots through its own guarded `patchPlanned`.
- `plannerRunsOn(pool, channelKey, tz, day, opts?)` in `schedule/planner-runs.ts` (A11). 073's retry seed and 074's ceiling share it.
- `reasons/catalogue.ts`:
  - `ReasonEntry`, byte-identical to the contract's text;
  - `REASONS`;
  - `reasonFor(code)`;
  - `reasonOfError(text): string | null`. There is no `codeOfError`.
- The dashboard mirror `apps/dashboard/src/lib/reasons.ts`: `{ code, en, fix?.en, link? }` plus a drift test. 072, 074 and 077 read labels only from it.
- The runner's optional dependency `onConfigSkip?: (channelKey: string, code: string) => void`. It is not wired in W1.

**L4. `preflight_no_material` is material, not config.**
- It is never in `CONFIG_FAILURE_CODES`.
- `checkSlotConfig` returns it for an empty required source, and it keeps counting toward the 060 breaker.

**L5. Migration 098** is `editor_channels.hashtag_min` DEFAULT 0 plus the backfill. Nothing else.

**L6. Start.** Launch's `setMode` passes `{ replan: false }`. Any later edit to Start keeps it.

**L7. Who owns which code.**
- 073 owns the doctor-visible codes `series_format_unavailable`, `series_in_quiet_hours` and `series_rate_over_card_max`, with catalogue entries of kind `config`.
- 072 does not duplicate the per-day maximum check. It arrives through 072's config seam at the 072 merge.
- 073 creates `config_series_gone`: the code, its `NOT_A_MISS` entry, its catalogue entry and its dashboard mirror entry. 074 reuses it and adds only `config_series_changed` and `config_replan_capped`. See Open 2.
- 076 owns `source_probe_failed` and the reuse of `preflight_host_blocked` for an all-feeds-unreachable skip. 073's catalogue entry for `preflight_host_blocked` is material (`nothing_fresh`), never config.

**L8. Shared lines.**
- 073 merges first in W1. It edits `planAhead` (`editor.module.ts`) and `schedule/schedule.service.ts` first; 072, 074, 075 and 077 build on 073's version.
- `executorContext(slot, { notify: false })` is 077's (W3). 073 does not add a `notify` option; it reads material through a private read-only helper (A3).

**L9. Scope in the shared `readiness/` folder.** 073 writes only `slot-config.ts`, `plan-skeleton.ts`, `fixtures/onboarding-1027.ts` and their tests. The Readiness panel and the ConflictsLine replacement are 072's.

**L10. Unchanged rules.**
- Tests use fakes, and PG tests run only on the scratch database.
- Dashboard text is English, checked by the Cyrillic test. Owner-bot and Telegram texts are Ukrainian.
- The mock API uses port 3173. The runbook section is § 33, and the Linear issue is AI0-251.

### Builder check

**A1 (check 1: accepted).** `maybePlan` (`editor.scheduler.ts:344-354`) sends no alert. The planner alerts are in `runPlanner` (`roles/editor-runner.service.ts:418-420`) and in `runNetworkPlanner` (`network/network-runner.ts:274-276`).
- FR-011's last bullet is dropped. The alerts carry only FR-005's validator lines (`lastToolErrors`).
- Skeleton problems reach the planner through the planner block. They reach the owner through their placeholders (`series_missed`) and, from the 072 merge, through the doctor.
- `editor.scheduler.ts` leaves the skeleton task.

**A2 (check 2: accepted).** `chat/drafts.service.ts:191` passes neither a series nor a pin, and it has no slot to read them from. It is not edited. A chat poll is improvised and stays capped (Deltas).

**A3 (check 3: accepted).** `executorContext` posts `series_source_empty` (`sourceEmpty`, `schedule.service.ts:319`). The fix:
- Extract the private read-only `seriesMaterial(s: SeriesForSlot, ref: string): Promise<{ left: number | null; nextRow: string | null }>`. It holds the `unposted` count of a required library source and `nextRowOf` (:330).
- `executorContext` calls it and keeps its note and its `sourceEmpty`.
- `slotConfigContext` calls only `seriesMaterial`, never `executorContext`.
- `material` is `'empty'` when `left === 0`, `'ok'` when `left > 0`, and null otherwise.
- Test: `slotConfigContext` on an empty required source makes zero inbox calls.

**A4 (check 4: accepted; one fact corrected).** `seriesForSlot` (`schedule.service.ts:291-306`) finds a series by name whether it is active or not. A missing series falls through to the pin rule (:301-304), then to null. `SeriesForSlot` (`schedule/series-guard.ts:46-55`) has no `active`.
- `SeriesForSlot` gains `active?: boolean`.
- `config_series_gone` means the named series is missing from `ctx.series`, or has `active === false`.
- A breaker pause is not `active: false`. It lives in `series_pauses`, and its planned slots are skipped `series_paused: …` by `series-pause/series-pauses.repository.ts:102` (not by `seriesContext`). It never yields `config_series_gone`.
- Test: an active series with a pause row gives no problem.

**A5 (check 5: accepted; the test path corrected).**
- Delete `['other', /^preflight_format_unavailable\b/]` from the push at `silent/skip-reasons.ts:78-83` (line :80).
- Rewrite the comment at :74-77 to say the code is `config` in the digest and `infra` as a 060 cause. `preflightCauseOf` keeps returning `'infra'`.
- The test that pins `other` is `preflight/slot-preflight.test.ts:155`; it becomes `'config'`.
- `series-pause/series-pause.060.test.ts:49` (`ignore`) and `preflight/slot-preflight.test.ts:165` (back to the pool) stay green.

**A6 (check 6: accepted).** `CONFIG_FAILURE_CODES` is defined once, in `readiness/slot-config.ts`:
```ts
export const CONFIG_FAILURE_CODES = [
  'config_series_gone', 'config_format_mismatch', 'config_source_mismatch', 'config_source_missing', 'config_tools_missing',
  'series_format_mismatch', 'series_source_mismatch', 'preflight_format_unavailable',
  'series_format_unavailable', 'series_in_quiet_hours',
] as const;
export function isConfigCode(code: string | null | undefined): boolean;
```
- `silent/skip-reasons.ts` imports the list. There is no cycle: `slot-config.ts` imports only `network/series.ts` (zod and the API names) and types.
- The `config` rule in `RULES` is built from the list and placed before `lint`: `new RegExp(`^(${CONFIG_FAILURE_CODES.join('|')})\\b`)`.

**A7 (check 7: accepted).** `repairSlotConfig` returns `{ format?, sourceHints?, note }`, exactly as the contract says.
- "Nothing repairable" is `{ note: '' }`, with neither field set; the runner then makes no patch.
- `note` is one English line that starts with the codes, for example `config_format_mismatch: text → quiz; config_source_mismatch: hints → series:Prompt, data://prompts/503`.
- `patchSlotConfig(id, { format?, sourceHints?, note }): Promise<EditorSlot | null>` runs `UPDATE … WHERE id = $1 AND status = 'running' RETURNING *`. It sets `format` and `source_hints` when given, appends `{ at, note }` to `fallback.repairs` (A32), and returns null for a slot that is not running.

**A8 (check 8: accepted).**
- `ConfigProblem` gets `series?` and `at?` (L3).
- `checkPlanSkeleton` takes an optional fifth argument `day?: string` (YYYY-MM-DD), and `SkeletonResource` gains `tz?: string` (default `card.timezone`).
- `series_format_unavailable` and `series_in_quiet_hours` always carry `series`.
  - Without `day`: one problem per series and code.
  - With `day`: one problem per due instance of that day, with `at = zonedToUtc(day, time, tz)` as ISO.
- `series_rate_over_card_max` carries neither field.
- `planContext` passes `planDate`, and matches excluded instances by `(series, at)`.
- Test: a 074-style consumer gets `series` for both instance codes, and `at` when `day` is given.

**A9 (check 9: partly accepted).**
- `series_format_unavailable` and `series_in_quiet_hours` are in `CONFIG_FAILURE_CODES` (A6), so `skipGroupOf` returns `config` and `classifyClose` returns `ignore` for both. Unit-test each.
- `series_rate_over_card_max` is never a slot error, so it stays out of the list. It is a warning with a catalogue entry of kind `config`.

**A10 (check 10: accepted).** Rename `codeOfError` to `reasonOfError(text: string | null | undefined): string | null` everywhere: FR-014, the catalogue task, the tests and `silent-days.ts`.

**A11 (check 11: accepted; the return is an object).** New `apps/automation/src/editor/schedule/planner-runs.ts`:
```ts
export async function plannerRunsOn(pool: Pick<Pool, 'query'>, channelKey: string, tz: string, day: string, opts?: { since?: Date }):
  Promise<{ n: number; failed: number; lastFailedAt: Date | null }>;
```
- `day` is the local day (in `tz`) that the runs started on.
- `n` counts every `role = 'planner'` run of the channel on that day, and at or after `since` when it is given: scheduler runs, owner replans and Start's runs. 074's ceiling reads `.n`.
- `failed` counts those runs that have no `editor_plans.run_id` match. `lastFailedAt` is the latest `started_at` among them.
- All three come from one SQL query, parsed defensively: `Number(row?.n ?? 0)`, and a missing date gives null.
- That it returns an object, not a number, goes in Deltas for the lead (Open 1).

**A12 (check 12: accepted).**
- The signature is `slotConfigContext(card, slot, o?: { tools?: ReadonlySet<string> | null })`, and `ctx.tools = o?.tools ?? null`. The runner passes its tool names; 072, 074 and 077 pass nothing, so the tools check is skipped.
- `roleTools(role, card, registry, loadoutAllow)` is a new exported pure helper in `roles/editor-runner.service.ts`. It returns `executorTools(role, registry.forRole(role, intersectAllow(card.toolsAllow, loadoutAllow)), card.toolsAllow)`, and `run()` (:362-376) uses it.
- `executorToolNames(card, ctx: { registry: Pick<ToolRegistry, 'forRole'>; loadoutAllow: string[] | null; exclude?: ReadonlySet<string> }): Set<string>` returns the names of `roleTools('executor', …)` minus `exclude`.
- The runner computes `loadoutAllow` as `run()` does (`this.d.loadout.allowFor(ctx?.agent, { role: 'executor', registry })`).
- It passes `exclude` as `run()`'s attempt will: `PLATFORM_ONLY` for a Telegram slot and `TELEGRAM_ONLY` for a platform slot (:179-180, :674, :910).

**A13 (check 13: accepted).** Drop "now − 6 h". The window starts at the key's first eligible instant.
- For `maybePlan` (today, D): the plan hour on D in the card's zone.
- For `maybePlanAhead` (the key D+1, checked on D): `APPROVAL_BATCH_HOUR` (`approval/approval-timing.ts:11`, 20:00) on D.
- The seed is `plannerTries.set(key, { n: r.failed, at: r.lastFailedAt?.getTime() ?? 0 })`, so `PLANNER_RETRY_MS` spacing holds across a restart.
- Tests:
  - three failures at 06:00, 06:30 and 07:00 (plan hour 6), then a restart at 15:00: no fourth try;
  - two failures, then a restart: one more try, at least 30 minutes after the second.

**A14 (check 14: accepted; one fact corrected).** Both keys have the form `${channelKey}:${planDate}` (`editor.scheduler.ts:316` and :349). The ahead key is tomorrow's date, and the next day's `maybePlan` reuses it in memory. `editor_runs` (`database/migrations/042_editor.sql:88-103`) has no plan date, so the seed counts by window. Two limits are accepted and listed in Deltas:
- Owner replans and Start's planner runs count toward the scheduler's three tries. After 20:00, the ahead window and today's retries overlap, so either can lose tries.
- After a restart, the next day's `maybePlan` does not see the previous evening's failed ahead tries, because its window starts at the plan hour. It may try up to three more times.

Write one test for today's key and a separate one for the ahead key.

**A15 (check 15: accepted).** The config check in `runExecutor`.
- **Position.** It runs after the derived branch (:438) and before the pre-flight (:440-445). Derived slots have no series.
- **The dependency.** `slotConfig?: { context(card, slot, o): Promise<SlotConfigCtx | null>; patch(id, r): Promise<EditorSlot | null> }`, wired to `schedule.slotConfigContext` and `repos.plans.patchSlotConfig`. When it is absent nothing happens, so the existing `runExecutor` tests stay green.
- **The flow.**
  1. Load `ctx` with `tools: executorToolNames(…)` (A12). A null `ctx` means there is nothing to check.
  2. Run `checkSlotConfig(toConfigSlot(slot), ctx)`, where `toConfigSlot` fills `seriesName` from `slotSeriesOf(slot)` (A17).
  3. If `repairSlotConfig` sets a field, call `slot = (await patch(slot.id, fix)) ?? slot`, so the runner continues with the repaired row. Then run `checkSlotConfig` once more on that row.
  4. If any problem remains, skip the slot with `skipByCode(slot, `${p.code}: ${p.detail}`)` (:735-739).
- **After a skip.** For every config code, call `onConfigSkip(card.channelKey, code)`. Send the owner note (A27) only for a code that is not in `NOT_A_MISS`, so `config_series_gone` gets no note.
- `preflight_no_material` skips with its own code: material class, with no note.

**A16 (check 16: accepted).** `slotConfigContext` returns null when the slot names no series (`slotSeriesOf` is null), or when the channel has no orchestrator or no active playbook. Otherwise `ctx.series` is the playbook's full list, inactive series included.
- In `checkSlotConfig`, `series === null` skips `config_series_gone`, `config_format_mismatch` and `config_source_*`.
- `[]` together with a series name gives `config_series_gone`.
- Test both cases.

**A17 (check 17: accepted).**
- `SlotConfigSlot.seriesName` comes from `slotSeriesOf(slot)` (`post/polls/poll-cap-guard.ts:103`), in FR-001 and in FR-009 alike.
- `checkSlotConfig` resolves the series by name plus `resourceRef ?? 'telegram:' + channelKey` first, then by name alone, as `seriesForSlot` does (:296).

**A18 (check 18: rejected as a risk; the test stays).** `withNextRow` (`preflight/slot-preflight.ts:156-173`) first drops the row hints of the next row's dataset, then de-duplicates with a `Set`. A repair that wrote `series:<name>` plus the next row therefore cannot produce a duplicate.
- The repair rule is unchanged: `series:<name>` plus `ctx.nextRow` when there is a next row, else `series:<name>` plus `library:<table>`.
- Keep one test: a repair followed by `preflight.run` yields the row exactly once.

**A19 (check 19: accepted).** A locked slot gets no evergreen step.
- `ladderPlan({ …, locked: true })` returns only `revise_source` (when the failure is fixable) and `next_candidate`. With `MAX_LADDER_EXTRA_STEPS = 1` (`silent/fallback-ladder.ts:107`), a locked slot runs one of them.
- Test each failure kind: a fixable and a non-fixable critic reject, lint, and a guard.

**A20 (check 20: partly accepted).**
- `series_format_mismatch` covers series instances and pins. `publishGuard` compares `refs.format` (A34) with `seriesForSlot(slot).format`: `series.format` for a series, and `r.format ?? slot.format` for a pin (:303).
  - The format check runs once the series or pin resolves, before `series_source_mismatch`.
  - The existing `if (s && !s.pin)` block stays for the source and order checks.
- Rejected: reading `seriesForSlot` before lint. Lint's `lockedFormat` stays `slot.format` for a slot with a series or a pin.
  - Reason: `checkPublishGuards` re-reads the slot (`tools/role-tools.ts:184`) after the run-time repair (A15) has set `format = series.format`. `publishGuard` is the backstop for a slot that was not repaired.
  - So a series or pin post in another card-allowed format passes lint and is refused at publish with `series_format_mismatch` (config).
- Tests:
  - a pin with `rule.format` that differs: refused;
  - a pin without `rule.format`: compared with `slot.format`;
  - a series slot: refused on a mismatch;
  - an improvised slot: never checked.

**A21 (check 21: accepted).** The matching rule of `lockSeriesFormats(slots, series, defaultRef)` (`schedule/plan-schedule-rules.ts`):
- A slot's series is `slot.series`, else its `series:` hint. Its resource is `slot.resource_ref ?? defaultRef`.
- Match by name and resource first, then by name alone.
- A slot that names an unknown series is left unchanged.
- `changed[].i` is the index in the submitted array.
- Test a single plan (no `resource_ref`) and a network plan in which one name exists on two resources.

**A22 (check 22: accepted).** The format table is `implementedFormats(platform)` (`platform/capabilities.ts:94`). For Telegram it is text, photo, album, carousel, poll, quiz, longread and video. "Hosted" is `formatAvailable(format, env)` (`preflight/slot-preflight.ts:44`); only the carousel needs hosting.
- New pure `producibleFormats(platform, formatOk?)` in `readiness/plan-skeleton.ts`: `implementedFormats(platform).filter((f) => !formatOk || formatOk(f))`.
- At save time, with no env, `validatePlaybook` (`network/playbook.ts:125`) and `seriesProblems` (`schedule/schedule.service.ts:604-605`) check a series format against `implementedFormats(r.platform)`. Section keys (:109-111) are checked against the card's formats only when their weight is above 0.
- `ScheduleServiceDeps` (`schedule.service.ts:48-70`) has no env, so it gains `formatOk?: (format: string) => boolean`. `editor.module.ts` wires it as `(f) => formatAvailable(f, env).ok`, the pattern at :549.
- `planContext` builds each resource's `SkeletonResource.formats` as `producibleFormats(platform, this.d.formatOk)`.

**A23 (check 23: accepted).** Submitted plan slots never carry a pin.
- Pins are materialised by code (`ScheduleService.materialiseAgent`, `schedule.service.ts:254-285`) and reach `validatePlan` only as fixed times.
- At plan time, the pin exemption applies to the `PollCapCtx.recent` rows. `PollSlotLike` gets no `pin` (Deltas).

**A24 (check 24: accepted).** There is no new inbox kind, no registry change and no index change.
- `stalled:<name>` becomes one more part of the day's `series_missed` note, and so of a merged `dark_day` note (`mergeDayNotes`, `silent/silent-days.ts:244`).
- `evaluateSilentDays` adds the part to the `series_missed` parts (:207), plus one line in the body and in the alert. That happens when, on both today and the previous local day, every slot of the series closed for a non-material, non-owner reason and none went out. The qualifying reasons are `planner_skipped`, the config group, `lint` and `other`.
- The body line is "Series "<name>" has not gone out two days in a row: <reasonFor(code).en>". The alert line is «Серія «<name>» не виходить два дні поспіль: <reasonFor(code).uk>».
- `series_stalled` stays as a catalogue entry (kind `skip`) for these texts.
- Tests:
  - one day: no part;
  - two days: one part;
  - a material or owner close on either day: none;
  - a post out on either day: none.

**A25 (check 25: accepted, with a narrower trigger).** Switching a channel back on.
- `EditorOpsDeps.plans` gains `Partial<Pick<EditorPlansRepository, 'getActivePlan' | 'listSlots'>>`, so the existing fakes still work.
- `upsertChannel(key, body, opts?: { replan?: boolean })` reads `previousMode` from `upsert`'s return. When all of the following hold, it starts `void this.replan(key, { wait: false }).catch(log)`, without awaiting:
  - `previousMode` is `off`;
  - the new mode is not `off`;
  - `opts.replan !== false`;
  - the local hour is at or past `planHour`;
  - today's active plan exists, is not a placeholder (`isPlaceholderPlan`), and has no slot with `kind = 'content'`, `status = 'planned'` and `scheduledAt > now`.
- If today has no active plan, or only a placeholder one, nothing starts: the scheduler's `maybePlan` plans on its next tick. So the two paths never both start a planner.
- `replan`'s `editor_disabled` and `replan_in_progress` errors are caught and logged. The mode save never fails because of them.

**A26 (check 26: accepted).** New `apps/automation/src/editor/launch/plan-ahead.ts`:
```ts
export async function planTodayAndTomorrow(d: { runner: Pick<EditorRunnerService, 'runPlanner'>; plans: Pick<EditorPlansRepository, 'getActivePlan'>; now?: () => Date; log?: (m: string) => void }, card: EditorCard): Promise<void>;
```
- Today: `runPlanner(card)`; a throw is caught and logged.
- Tomorrow is `shiftDate(localDate(now, card.timezone), 1)`. It is date arithmetic, so it is safe across DST.
- A tomorrow plan that exists and is not a placeholder is left alone. Otherwise run `runPlanner(card, { planDate: tomorrow })`.
- The two runs are sequential. A failed or erroring today run does not stop tomorrow's.
- The `planAhead` closure (`editor.module.ts:2182-2186`) becomes a call to this function.

**A27 (check 27: accepted).**
- The runner keeps `private readonly configNoted = new Map<string, string>()`, keyed `${channelKey}:${code}`, with the local date in the card's zone as the value.
- The note is sent through `safeNotify`: `⚙️ ${channelKey}: ${entry.uk}${entry.fix ? `. ${entry.fix.uk}` : ''}`, falling back to the bare code when the catalogue has no entry.
- After a restart, a note may repeat once that day. There is no table (Deltas). The lead deletes this note at the 072 merge (L1).

**A28 (check 28: accepted, except the sample).** The dashboard mirror and `skipReason`.
- The mirror is keyed by server code.
- `skipReason` keeps its existing special cases and its own `code` strings (`planner_empty`, `superseded`, `owner`, `agent`, `paused`, `unavailable`, …). The `en` of those entries equals today's labels, copied from `lib/slot-plan.ts:111-125`.
- After the special cases, it looks up the leading `<code>` or `<code>:` token in the mirror. It does not port `reasonOfError`'s legacy-text mapping.
- `SkipReason` gains `fix?: string` and `link?`, set only when the entry has them. Update only the `deepEqual` cases at `lib/slot-plan.test.ts:31-48` whose code gains a fix.
- The fallback is `{ code: 'other', label: 'Skipped — reason not classified', detail }`. The sample at :48 (`retry after max_steps`) stays unclassified on the dashboard and keeps its line with the new label.

**A29 (check 29: accepted).** `reasonLink(entry, vars: { channel?: string; agent?: string; dataset?: string })` in `lib/reasons.ts`.
- It returns typed TanStack `Link` props from a small switch over the known templates:
  - `/app/editor/$channel`;
  - `/app/agents/$handle`;
  - `/app/data/$key`;
  - `/app/agents/inbox` with `search: { tab: 'approvals' }`.
- It returns null for an unknown template or an unresolved placeholder. The slot dialog then shows the fix line without a link.
- No string or `as any` casts: they defeat tsc.

**A30 (check 30: accepted).** The runner's config path.
- **The helper.** New pure `configStop(probe: Pick<PublishProbe, 'last'> | null): { code: string; reason: string } | null` in `silent/fallback-ladder.ts`. When `probe.last` holds a code for which `isConfigCode` is true, it returns `{ code, reason: clip(`${code}: ${detailsText(details)}`, 500) }`. `PublishProbe.last` survives a later `skip_slot`; only a successful publish clears it (:164-173).
- **After the first attempt.** In `runExecutor`, right after the first attempt (:465-466), compute `const cfg = configStop(probe)`. When it is set and the fresh slot is `running` or `skipped`:
  - write `status: 'skipped'`, `error: cfg.reason` and `fallback: { ...after.fallback, final: { outcome: 'skipped', code: 'config', step: 'initial', reason: cfg.reason } }`. Add no step: the digest's `laddered` counts slots that have steps (`manager/quality-digest.ts:197`);
  - call `onConfigSkip` and send the note (A27), then `onSlotDone`;
  - return. Neither `fallback()` nor the 15-minute retry (:474-495) runs.
- **Inside `fallback()`.** After each step's attempt, check `configStop(p)` before `classifyFailure`. When it is set:
  - push the step with outcome `'config'`;
  - set `final = { outcome: 'skipped', code: 'config', step: st.step, reason }` and break;
  - in the end write (:643), use `final.reason` as the error when `final.code` is `'config'`, as is already done for `'series_skip'`.
- **Types.** `StepOutcome` gains `'config'`, and the doc of `FallbackFinal.code` lists `config`. `SlotFailure` and `classify` do not change.
- **Tests** in `roles/editor-runner.073.test.ts`, with a fake loop and repos:
  - a config error followed by `skip_slot`: the error is the config reason;
  - a config error and then nothing: skipped, `retryAt` never set, no second attempt;
  - a config error on a ladder step: skipped with that reason;
  - in every case, `passRow` is never called and `onConfigSkip` is called once.

**A31 (check 31: accepted).**
- `ROW_GUARD_CODES` (`fallback-ladder.ts:149`) gains `series_format_mismatch`.
- `NEVER_PASS` (:224) gains every `CONFIG_FAILURE_CODES` code.
- Tests: `shouldPassRow` is false for each config code, and a probe refused with `series_format_mismatch` drops its `libraryRef`.

**A32 (check 32: accepted, simplified).** There is no `config_repair` step.
- `SlotFallback` gains `repairs?: Array<{ at: string; note: string }>`. It is JSONB, so no migration is needed. `patchSlotConfig` appends to it in SQL.
- The two runner writes of `fallback` keep it. :490 spreads `after.fallback`; :648 spreads the slot's `fallback`, which is the repaired row (A15).
- `pinLevelOf`, `priorCriticPasses`, `attemptRejections`, the step counter and the digest read only `steps` and `final`.
- Test: a repaired slot that then fails, climbs the ladder and is retried still has `fallback.repairs`.

**A33 (check 33: accepted; one fact corrected).** Two more counters count series and pins today. `AuditPost` (`post/integrity/types.ts:26`) has no series field, so the check's "available on the audit row" is wrong.
- **`pollCapCheck`** (`post/integrity/checks/polls.ts:47-63`) serves the export audit, the golden set and the post audit.
  - `AuditPost` gains `pollCapExempt?: boolean`. `audit/post-audit.service.ts` `slotPosts` (:166-193) sets it from `s.series_name IS NOT NULL OR s.schedule_rule_id IS NOT NULL` (or a `series:` hint).
  - `pollCapCheck` skips an exempt post and does not count exempt `previous` posts. Export posts (no slot) are unchanged.
- **The digest** (`manager/quality-digest.ts`).
  - `PostRow` (:162-165) gains `exempt?: boolean`, from `(s.series_name IS NOT NULL OR s.schedule_rule_id IS NOT NULL) AS exempt` in the posts query (:417-424).
  - `pollsOver` (:256) uses the count of polls that are not exempt. `polls.count` and `share` (:300) keep counting every poll, because they are the format mix.
- **Tests:**
  - `manager/quality.test.ts`: a quiz series does not raise `polls_over_cap`;
  - `manager/quality.pg.test.ts`: the column;
  - `post/polls/poll-cap.073.test.ts`: `pollCapCheck`.

**A34 (check 34: accepted).** `publishGuard(slot, refs: { libraryRef?; sourceUrl?; format?: string | null }, o)`.
- When `refs.format` is given and differs from the resolved series or pin format, it returns `{ error: 'series_format_mismatch', details }`:
  - for a series: «серія «<name>» виходить у форматі <series format>, а пост — <format>. Формат задає серія: зроби пост у <series format>»;
  - for a pin: «закріплений слот має формат <format>, а пост — <format>: зроби пост у <format>».
- The callers pass `format: spec.format`: `tools/role-tools.ts:223`, and `platform/platform-tools.ts:85` with the platform post's format.
- `format` is optional, so `schedule/schedule.071.test.ts:42`, `live/live-slots.e2e.pg.test.ts:229-230` and the fakes in the tool tests stay as they are.
- The publish-time check moves from the format-lock task into the runner task, which lands it together with the config handling.

**A35 (check 35: accepted; the lines corrected).** The ladder task updates two places in `silent/pass-row.071.test.ts`:
- :97-100: `quiz_answer_mismatch` no longer puts the row aside, so `passed` is `[]`;
- :129: `shouldPassRow(… 'quiz_answer_mismatch' …)` becomes false.

The loops at :101 and :158 stay; none of their codes ever passes. Keep the `not_next_in_order` cases.

**A36 (check 36: accepted; one file needs no change).**
- `network/idea-outcome.ts` `ideaOutcomeOf` (:34-46) returns `accepted` (back to the pool) when `skipGroupOf(e) === 'config'`, before the `used` fallback.
- `owner-bot/owner-reports.ts:90-93` `SKIP_UK` and `silent/silent-days.ts:96-98` `GROUP_UK` each gain `config: 'налаштування'`.
- Test each file with `config_format_mismatch: x` and `series_source_mismatch: x`.
- `api/editor-chat.controller.ts:16-19` (the drafts' CONFLICT set) does not list `series_source_mismatch` and is not edited.

**A37 (check 37: accepted).** The migration test is `apps/automation/src/editor/repo/card-hashtag.098.migration.pg.test.ts`, in the style of `data/prompts-rule.095.migration.pg.test.ts`.
- It creates its own throwaway database (`pgDbName` / `pgWithDb`) with `init.sql` and every migration except 098. 097 is 072's and is absent in W1.
- It inserts two channels with `hashtag_min 1`: one with empty `hashtags`, one with a vocabulary.
- After applying 098:
  - the first channel has 0 and the second keeps 1;
  - the column default is 0;
  - a raw INSERT without the column gets 0.
- After applying the down file twice: the default is 1, the `schema_migrations` row is gone, and the values are unchanged.
- The footer is `INSERT INTO schema_migrations (version) VALUES ('098_card_hashtag_default') ON CONFLICT DO NOTHING;` (the version is at most 64 characters). The down file ends with `DELETE FROM schema_migrations WHERE version = '098_card_hashtag_default';`.

**A38 (check 38: accepted).**
- `upsert` is not changed: it writes `hashtag_min` explicitly (`repo/editor-channels.repository.ts:214-232`). New cards get `CARD_DEFAULTS.hashtagMin` 0.
- `api/card-input.073.test.ts` asserts `CARD_DEFAULTS.hashtagMin === 0`, and that `mergeCard` keeps `hashtagMin 1` on an existing card with a vocabulary.

**A39 (check 39: accepted).** The coverage test is table-driven: `const COVERED: Array<[string, readonly string[]]>` in `reasons/catalogue.073.test.ts`.
- The catalogue task covers the lists that exist when it lands.
- The config-class task appends `CONFIG_FAILURE_CODES` with its entries, in the same commit.
- The skeleton task appends `SKELETON_CODES` with its entries, in the same commit.

**A40 (check 40: accepted).**
- The task order is now: the catalogue, then the config class (classification first, then the runner), then `checkSlotConfig`, then the skeleton.
- The `shouldPassRow` assertion for the config codes moves to the config-class task.

**A41 (check 41: accepted).** The `EMPTY_DAY_ERROR_RE` change (A42) and its PG test go in the stalled-series task, and the skeleton task relies on them.

**A42 (check 42: accepted, with a Postgres note).**
- `schedule/empty-day.ts:45` becomes `'^(planner_(no_material|source_unreachable|skipped)|series_format_unavailable|series_in_quiet_hours)'`.
  - It has no `\b`: the regex is spliced into Postgres `~` (`repo/editor-plans.repository.ts:370` and :396), where `\b` means a backspace.
- `RULES` gains `['other', /^planner_skipped\b/]` in the 068 push. The config codes come through A6.
- `classifyClose` returns `ignore` for `planner_skipped`, next to the `planner_*` lines (:92-93).
- The dashboard mirror labels `planner_skipped` "Skipped by the planner". The regex at `lib/slot-plan.ts:120` stays for the two material codes.
- New `repo/editor-plans.073.pg.test.ts`:
  - `replacePlan` supersedes future `planner_skipped:` and `series_in_quiet_hours:` placeholders;
  - `insertEmptyDay` twice writes one row.
- `isPlaceholderPlan` (:194) reads the rationale and is unaffected.

**A43 (check 43: accepted).**
- Seed only when the key is absent from `plannerTries`, and parse defensively (A11).
- `editor.scheduler.test.ts` is not changed. The new `editor.scheduler.073.test.ts` has its own fake pool that answers the `plannerRunsOn` SQL.

**A44 (check 44: accepted; the list widened).** After the mode-off task, run with `EDITOR_PG_TEST_URL` every PG test that calls `claimDue` or a scheduler tick:
- `editor.e2e.pg.test.ts`, `reliability.040.pg.test.ts`, `chat/editor-chat.e2e.pg.test.ts`;
- `network/repurpose.e2e.pg.test.ts`, `network/derived-slots.e2e.pg.test.ts`, `live/live-slots.e2e.pg.test.ts`;
- `approval/approval.e2e.pg.test.ts`, `pauses/resource-pauses.pg.test.ts`, `audit/post-audit.pg.test.ts`;
- `repo/editor-repos.pg.test.ts`, `repo/round-similarity.071.pg.test.ts`, `sysadmin/audit-schedule.055.pg.test.ts`.

If one of them inserts slots for a key that has no `editor_channels` row, add the row (mode not `off`) to its setup. A deleted channel's slots have no row; they stay planned until `skipStale` writes «stale: …». That is accepted (Deltas).

**A45 (check 45: accepted).** The poll-cap task updates three tests and keeps a fourth green:
- `post/polls/polls.test.ts:147-150`: drop `playbookSeries`. A slot's `series` alone exempts it, :150's agent series is now exempt, and an improvised case is still capped.
- `roles/poll-cap.test.ts:55-60`: no `exemptSeries`. An agent series is exempt, and a slot with no series is counted.
- `roles/poll-cap.pg.test.ts:76-95`: `validatePlan` without the series list, plus the `pin` column.
- `post/polls/poll-cap-guard.pg.test.ts` stays green. Its slots have neither a series nor a pin, and it never passed `playbookSeries` (the code map was wrong).

**A46 (check 46: accepted; the line corrected).**
- `rules/owner-style-overlay.test.ts:31` ("the stored style wins over the default") now expects `'off'`. Its title becomes "a stored vocabulary style with a known empty vocabulary reads as off".
- Lines :28-30 and the lint assertions (:32-36) stay.
- Add a case: `effectiveStyle({ hashtags: 'vocabulary' }, { vocabulary: null }).hashtags === 'vocabulary'`, because a platform ref is not judged.

**A47 (check 47: accepted, and extended to the composer).**
- `inlineSkills` (`roles/prompts.ts:35-52`) returns `overflow: string[]`: the skills skipped for the budget, never the voice skills.
- `buildSystemPrompt` (:87-89) and the composer prompt (:163-166) add each of them, once, to «Інші скіли» after the filter, with the description from `skills.get(name)`. It is the same bug in the same helper, so the composer is fixed too.
- `agentInlineSkills` (:57-70) also returns `overflow`. Its runner callers (:784 and :856) add one line «Ще скіли (load_skill): <names>» when the list is not empty. `load_skill` is available to every role (`tools/read-tools.ts:331-333`).
- Test `roles/prompts.073.test.ts`: an over-budget card skill appears exactly once, in the listed section, for the executor and for the composer.

**A48 (check 48: accepted; the test list corrected).**
- `SkillStore`'s constructor (`agents/skill-store.ts:113`) gains an optional second argument `ports?: { seriesSources?(agentId: string): Promise<…> }`. All 23 `new SkillStore(` sites keep compiling.
- `sourceRefusal` and `originRefusal` run on every write. The series check runs only when the port is present.
- `agents/skill-store*.test.ts` and `agents/builder-tools*.test.ts` do not exist. Re-run and fix every test that builds a `SkillStore` or calls `writeAgentSkill` (grep `SkillStore\|writeAgentSkill` in `*.test.ts`), for example:
  - `agents/agents.pg.test.ts`;
  - `agents/agent-skill-tools.059.test.ts`;
  - `agents/skill-probe.059*.pg.test.ts`;
  - `artifacts/artifacts.048.pg.test.ts`;
  - `docs/import-bundle.069.pg.test.ts`.

**A49 (check 49: accepted).**
- The `poll_correct_index` task greps the tests under `apps/automation/src` for poll-format fixtures that carry `correct_index`, and changes the linted ones to `quiz`.
  - `post/render-telegram.test.ts:71` is a render test; check whether it lints.
- Runbook § 33 says that a chat or owner-rule poll with `correct_index` now fails lint (`poll_correct_index`).

**A50 (check 50: accepted).** The tool test in `roles/editor-runner.073.test.ts`.
- Build a registry from the real tool definitions. Cover a card with `toolsAllow` and one without, each with and without a loadout allow list.
- Assert that `executorToolNames` equals the names `run()` hands the fake loop, for a Telegram slot and for a platform slot.
- `tools: null` skips `config_tools_missing`.
- A library source passes with `query_data` or `search_library` alone, and a feed with `fetch_feed` or `web_fetch` alone.

### Found while verifying

**A51. The dashboard `NOT_A_MISS` mirror.**
- `apps/dashboard/src/lib/status-tone.ts:80` mirrors the server's `NOT_A_MISS`, and `lib/status-tone.test.ts:95-108` reads `silent/skip-reasons.ts` and compares the two.
- In the same commit in which `config_series_gone` joins the server list, add `/^config_series_gone\b/` to the dashboard list.
- Keep the server `NOT_A_MISS` a single array literal; the test parses it.

**A52. `checkPublishGuards` already passes `series: slotSeriesOf(slot)`** to the poll-cap guard (`tools/role-tools.ts:228`). FR-001 adds only `pin: !!slot.scheduleRuleId` there and removes `playbookSeries` (:229).

**A53. `ConfigProblem.detail` is English, on one line.**
- 072 shows it in the dashboard, and the slot dialog shows the slot error `<code>: <detail>`.
- Ukrainian texts come from the catalogue. The planner block line for an excluded series is «не плануй «<series>»: <reasonFor(code).uk>».

**A54. Excluded series on both planner paths.**
- `PlanScheduleCtx` gains `excluded?: Array<{ series: string; resourceRef: string; at: Date; code: string; detail: string }>`.
- `matchDue` and `dueInstances` (`schedule/plan-schedule-rules.ts:123-144`) leave these instances out.
- The network validator builds its own due map (`network/network-plan.ts:110`) and drops them there too.
- `validatePlan` and `validateNetworkPlan` refuse a slot that names an excluded instance: «серія «X» <date> виключена: <reasonFor(code).uk>».
- The new `excludedPlaceholders(ctx, anchorRef)` in `schedule/empty-day.ts` turns each excluded instance into a placeholder with error `<code>: <detail>`. Both validators add these placeholders to `empty`.

### Open for the lead

1. **`plannerRunsOn` returns `{ n, failed, lastFailedAt }`, not a number** (A11). The seed needs the failed runs and the time of the last one, while 074's ceiling reads `.n`. Recommendation: accept, and change "one count" in 074's text to `.n`.
2. **Who creates `config_series_gone`.** The contract lists it under "074 adds"; 074's own spec calls it 073's code (074 spec :76). Recommendation: 073 creates the code, its `NOT_A_MISS` entry, its catalogue entry and its dashboard mirror entry, and 074 adds only `config_series_changed` and `config_replan_capped`.

## Lead decisions after the integration review (2026-10-29)

These override everything above, including the Amendments. They come from a cross-spec review of all six specs (the item numbers I1… are that review's).

- **I1 (blocker): the config context never writes.** `nextInRound(…, o?: { roll?: boolean })` and the `nextRow` dependency's option move into 073 (they were planned for 077). `seriesMaterial` and `ScheduleService.slotConfigContext` always pass `{ roll: false }` and count unposted rows with a read-only count, never through `buildCatalog`'s roll. Add a PG test: `slotConfigContext` leaves `data_reuse_rounds` unchanged.
- **I5:** export `isRepairable(code)`, true only for `config_format_mismatch` and `config_source_mismatch`, next to `CONFIG_FAILURE_CODES`. At the 072 merge the lead also exposes it as `AUTO_SAFE_RUN_REPAIRS` in `readiness/auto-fix.ts`; the runner reads that list.
- **I6:** export `skeletonResourcesOf(card, resources, env?)` → `SkeletonResource[]` (producible `formats`, `tz`). 072's facts loader calls it at the merge.
- **I12:** `reasonLink` accepts `?tab=<tab>`, validated against `lib/agent-tabs.ts` and the data route's `TABS`; an unknown tab falls back to the bare route. Add a test that every catalogue `link` resolves to a non-null link.
- **I13:** export one `SOURCE_READ_TOOLS` map (source kind → read tool names). `config_tools_missing` uses it; 072 and 077 import it.
- **I14:** 073 owns the series/source judge `seriesSourceConflict` in `agents/skill-warnings.ts`. Keep it pure and exported; 072's doctor calls it after the merge.
- `config_series_gone` is 073's code: `CONFIG_FAILURE_CODES`, `NOT_A_MISS`, the catalogue and the dashboard mirror (`status-tone.ts`, `lib/reasons.ts`). 074 only reuses it.
- `plannerRunsOn` returns `{ n, failed, lastFailedAt }` (accepted); 074 reads `.n`.
- `ReasonEntry.kind` is a display group, not the skip class. A code may be kind `dataset` and still be in `CONFIG_FAILURE_CODES`.
