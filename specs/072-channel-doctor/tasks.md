# 072 tasks

Base: `feat/editor-agent` at the commit your prompt names. One commit per task, everything green before each (common rules: `npm test`, `npm run build`, `npm run lint` in apps/automation; `tsc --noEmit`, `npm test`, `npm run build` in apps/dashboard when touched; PG tests of touched files with `EDITOR_PG_TEST_URL`). Code map: scratchpad `w7/map-072.md`. Read the spec's «Amendments after the builder check» first; `A<n>` and `L<n>` below point there.

- [x] **T1 Shared fix runner, the `channel` area, new fix kinds** (FR-001 first half, FR-004, A6, A7, A18, A32)
  - What:
    - `FINDING_AREAS`/`FindingArea`, `Finding.link?`, `Finding.firstSeenAt?`.
    - The `Fix` union: `conflicts_resolve` gains `codes?` and `channel?`; four new kinds (`tools_allow_add`, `hashtag_min_zero`, `series_resume`, `series_source_require`). `FIX_KINDS` lists exactly eight.
    - Move `runFix`/`describe` out of `AuditService` into `sysadmin/fix-runner.ts`: `runFix(ports, fix): Promise<FixResult>` (refusals still throw the `{ response: { error, details } }` shape), `tryFix(ports, fix): Promise<FixResult>` (never throws), `describeFix`, `fixLabel`, `FixPorts`, `FixResult`. No `default` in the three switches.
    - `FixPorts extends AuditFixPorts`; `applyConflicts(orch, o?: { codes?; ref? })`; the optional new ports `addCardTools`, `setHashtagMin`, `resumeSeriesPause`, `requireSeriesSource`. A missing port throws `fix_unavailable`. `series_resume` refuses cause `owner` (`owner_pause`). `addCardTools` never writes a list when `card.toolsAllow` is null.
    - `AuditService.apply` stores `(await runFix(...)).applied ?? ''`.
    - `readiness/auto-fix.ts`: `AUTO_SAFE_FIX_KINDS` (two kinds) and `FIX_ALL_EXCLUDED_KINDS` (empty).
    - `editor.module.ts`: the AuditService factory's `applyConflicts` line only (A18).
  - Files: `sysadmin/audit.types.ts`, `sysadmin/fix-runner.ts` (new), `sysadmin/audit.service.ts`, `readiness/auto-fix.ts` (new), `editor.module.ts` (one line).
  - Tests:
    - `sysadmin/fix-runner.072.test.ts`: the exact eight kinds; each kind calls its port with the right arguments; a missing port → `fix_unavailable`; `series_resume` refuses an owner pause; `conflicts_resolve` passes `codes` and `ref`, and without them applies everything as before; `tryFix` turns a throw into `{ ok: false, error: '<code>: <details>' }`; labels and descriptions have no Cyrillic.
    - The same file, A32: the real `applySeriesOp` on a fixture playbook, with `{ name, source_mode: 'required' }`, gives the series before except `source_mode: 'required'` and `locked: true` (`origin` kept); a `series_invalid` refusal of the port reaches `tryFix` as `ok: false`.
    - `readiness/auto-fix.072.test.ts`: exactly the two auto-safe kinds; `FIX_ALL_EXCLUDED_KINDS` is empty.
    - `audit.055.test.ts`, `audit.055.pg.test.ts` and `auditor-input.055.test.ts` unchanged and green.
  - Done when: the weekly audit applies fixes exactly as before, and every new kind has a label, a description and a port.

- [x] **T2 Migration 097 and the scratch-database helper** (FR-005, A14, A28)
  - What: `database/migrations/097_channel_readiness.sql` and `down/097_channel_readiness.down.sql`, both idempotent; `readiness/testing/pg-db.ts` with `scratchDb(url, tag, o?)` (own database: `schema_migrations`, `init.sql`, every migration sorted; `drop()`), copied from `data/prompts-rule.095.migration.pg.test.ts:46-60`.
  - Files: the two SQL files, `readiness/testing/pg-db.ts` (new).
  - Tests: `readiness/readiness-migration.072.pg.test.ts` (own database through `scratchDb`): apply all, apply 097 again, down twice, up again; columns and defaults; `applied_hash` nullable.
  - Done when: the A28 command passes on a throwaway database of the scratch server (`/tmp/pgs046`, port 55446), and that database is dropped. If `psql` is missing, say so in Deltas.

- [x] **T3 Codes, facts types and the facts loader** (FR-001 second half, FR-002, A15, A16, A19, A21, A27, A29, L5)
  - What:
    - `readiness/codes.ts`: `ReasonEntry` copied verbatim from the contract, `DOCTOR_REASONS` (every FR-001 code plus `auto_fixed`; no `source_unreachable` entry), `doctorReason`, `resolveLink`.
    - `readiness/facts.types.ts`: `ChannelFacts`, `SkillFact`, `DatasetFact`, `SourceFact` (with `lastSuccessAt?`, `required?`, `probe?`), `PlannedSlotFact`, exactly as A16.
    - `readiness/facts.ts`: `loadChannelFacts(pool, key, o?)`, which builds its own repositories from the pool (A30) and resolves the key to the card's spelling (A27); `countPostable(pool, schemaIds, resourceRef)` (the `countRows` SQL of `data/data-catalog.ts:177-187`, never `buildCatalog`); the pure `deriveFacts`, `configHash` and `applyOverlay`.
    - One `listActive(key, 60)` read feeds both `conflictInput.rules` (`createdBy === 'owner'`) and `facts.rules` (`ownerRulesOf`) (A19).
    - Slots of the last 24 h select `critic->>'verdict' AS verdict`, windowed by `scheduled_at` (A15).
    - Series sources map to `SourceFact` as A16 says; `free`, `network_highlights` and absent sources add none (A29).
  - Files: `readiness/codes.ts`, `readiness/facts.types.ts`, `readiness/facts.ts` (all new).
  - Tests:
    - `readiness/codes.072.test.ts`: unique codes; English without Cyrillic; Ukrainian not empty; link placeholders known; no `source_unreachable` code.
    - `readiness/config-hash.072.test.ts`: the hash changes with a skill toggle, card formats, `post_requires` and `format_prefs`; not with mode, pauses, counts or slots.
    - `readiness/apply-overlay.072.test.ts`: a deep-frozen input is not changed; a replaced card changes `effectiveTools`; a replaced playbook gives its `series` when `series` is not given; an added dataset gets `boundBy` and `seriesPerDay`.
    - `readiness/facts.072.pg.test.ts` (own database through `scratchDb`): a seeded channel (card, agent chain, playbook with series, skills, an owner rule and an approval-preference row, steering, a dataset with rows and `post_requires`, a pause, a launch, slots with `critic` JSON) gives the expected facts; the row counts of every table it reads are the same before and after; a `cycle` dataset with 0 unused rows is not rolled (`data_reuse_rounds` unchanged); an `after_days 30` row used 40 days ago counts in `unusedPostable` and one used 10 days ago does not (A21); `@X` resolves to the stored `@x`.
  - Done when: one call loads one channel in a fixed number of queries (no query per row), and the PG test passes.

- [x] **T4a The doctor, the source contradiction, series and material checks** (FR-003.1–2, A1, A2, A4, A8, A19, A21, A29)
  - What:
    - `agents/skill-warnings.ts`: add `export` to `sourceTokensIn` (`:151`) and `topicOf` (`:229`); no other change.
    - `readiness/doctor.ts`: `channelDoctor` runs `DOCTOR_CHECKS`, drops repeated keys, sorts error → warn → info, then code.
    - `readiness/source-contradiction.ts`: `seriesSourceContradictions(series, candidates)`, path 1 through `skillConflicts`, path 2 exactly as A2.
    - `readiness/checks/index.ts` (`DOCTOR_CHECKS`, `DoctorCheck`), `checks/source.ts`, `checks/series.ts` (`series_source_not_required`, `playbook_draft_waiting`), `checks/material.ts` (the six material codes, `requiresBody` as A4, `dataset_without_series` severity as A21).
    - Subjects as the A8 table.
  - Files: the new files above, `agents/skill-warnings.ts` (two keywords).
  - Tests:
    - `readiness/source-contradiction.072.test.ts`: path 1 hard and soft; path 2 with the real prompthero name, description and body against the series name `Prompt` and its brief; a hit with no tokens gives no contradiction; built-in and safety skills are never candidates; an approval-preference row is not a candidate (A19); a `free` series gets nothing (A29).
    - `readiness/checks/source.072.test.ts`, `checks/series.072.test.ts`, `checks/material.072.test.ts`: each code fires, each severity branch, each fix shape, links resolved; the 083 and 095 rules for `dataset_low_fill` (A4); two contradictions on one series give two findings (A8).
    - `readiness/doctor.072.test.ts`: dedupe by key, order.
  - Done when: `channelDoctor` is pure (no import of `pg`, no `Date.now()`; time comes from `facts.now`).

- [x] **T4b Tools, config, pauses and launch checks** (FR-003.3–5, FR-012 seams, A8, A12, A18, A29)
  - What:
    - `checks/tools.ts`: the A29 map; error for an active series, warn for a card-only source; `tools_allow_add` only when `card.toolsAllow` is not null and lacks the tool.
    - `checks/config.ts`: `configConflicts(f.conflictInput)` filtered to `ref === f.resourceRef` (A18) → `config_conflict` (`conflicts_resolve` with `codes: [code]` and `channel`; none for `poll_series_over_cap`); `hashtag_min_without_vocabulary` with `hashtag_min_zero`; `formats_diverge` for independent groups; `configSeam` and the local `ConfigProblem` copy with `series?` and `at?` (L8), both seam functions returning `[]`.
    - `checks/pauses.ts`: A12 exactly.
    - `checks/launch.ts`: `bot_not_admin`.
  - Files: the four check files, `checks/index.ts` (append).
  - Tests:
    - `readiness/checks/tools.072.test.ts`, `checks/config.072.test.ts`, `checks/pauses.072.test.ts`, `checks/launch.072.test.ts`: each code fires, each severity and fix branch; two resources in one group give only this channel's conflict (A18); two config conflicts of different codes give two findings; `pause_cause_gone` for `source_unreachable` needs both a passed block and a newer `lastSuccessAt`, and never fires with `lastSuccessAt: null`.
    - `readiness/codes.072.test.ts` gains: every code any check can emit (and `auto_fixed`) is in `DOCTOR_REASONS`.
  - Done when: all seven check files are in `DOCTOR_CHECKS` and the doctor stays pure.

- [x] **T5 Acceptance replays** (Tests, acceptance; A1, A2, A3, L10)
  - What: `readiness/fixtures/onboarding-1027.ts` builds `ChannelFacts` by hand for @ai0_prompts_dev (before the 10-27 fixes), @pdr_dev_channel (before 10-27) and @ai0_global. Its header lists which fields are real and which synthetic, as A3. Extract `tmp/agent-export-20261026-2054.tar.gz` into your scratchpad to copy the real field values only (no tokens, no other ids); never commit the export. Skill and rule texts are data. Bindings are declared only (card and series `library` sources); never derive one from the ledger.
  - Files: the fixture, `readiness/onboarding-1027.072.test.ts`.
  - Tests: the A3 expectations, asserted with "includes" (code and subject id): @ai0_prompts_dev has the two `series_source_contradicted`, `origin_original_with_source` (the synthetic skill) and `dataset_low_fill`, all errors; @pdr_dev_channel has `dataset_without_series` and `material_exhausted`, both errors; @ai0_global has 0 errors and a `series_paused` info for «AI-новини дня».
  - Done when: the replay fails if any of the six expected errors disappears or any error appears on @ai0_global. If @ai0_global shows a false error, tune the check, not the fixture.

- [ ] **T6 ReadinessService, repository, worker, API, setting** (FR-006, FR-007, A9, A10, A11, A13, A20, A27, A30, L2, L5, L8)
  - What:
    - `readiness/readiness.repository.ts`: `ReadinessRepository` (`get`, `upsert`, `setAppliedHash`; never writes `applied_hash` from `upsert`).
    - `readiness/readiness.service.ts`: `recheck(key, reason)` with the A10 matrix, the per-channel lock, auto-fix once then one reload, `firstSeenAt` kept, `auto_fixed` carried for 24 h (A20), the notify stamp and the immediate clear (A9); `RecheckReason`, `RecheckEvent` and `afterRecheck` (every recheck, returns an unsubscribe; a throwing hook is logged and skipped); `view(key)` from the stored row (A11); `sweep()`; `fix(key, { codes?, keys? }, via)` with the A13 scope through `tryFix`; key resolution (A27); `ReadinessView.mode` typed as `ChannelMode` (`card.ts:9`).
    - `readiness/readiness.worker.ts`: `@Cron('*/10 * * * *')`, try/catch, nothing when `EDITOR_ENABLED` is off.
    - `readiness/readiness.controller.ts`: `READINESS_SERVICE`; `GET :key/readiness` (stored row under 60 s, `?fresh=1` skips it), `POST :key/readiness/recheck` (reason `owner`), `POST :key/readiness/fix` (zod `{ codes?: string[]; keys?: string[] }`); no card → 404 `channel_not_found`.
    - `READINESS_AUTO_FIX` in `settings/catalog.ts` after `:135`.
    - Wiring: the `READINESS_SERVICE` factory with the A30 inject list (it builds the `FixPorts` and fills the `READINESS` holder), the worker after `AuditWorker` in the providers list, the controller in `controllers`.
  - Files: the four new files, `settings/catalog.ts` (one entry), `editor.module.ts` (one factory, one holder, two list entries).
  - Tests:
    - `readiness/readiness.service.072.test.ts` with fakes: each A10 row; `view` never fixes and never stamps; `owner`/`sweep`/`start` fix once and reload once; hooks get the full `RecheckEvent` with `reason` and `appliedHash`; a throwing hook does not stop the others; the stamp at most once per 24 h and the immediate clear at 0 blockers; `auto_fixed` kept after two rechecks and gone after 25 h; `fix()` without a selection never applies an info finding's fix or an excluded kind; `keys` applies one finding only; the per-channel lock; recheck never calls `setAppliedHash`.
    - `readiness/readiness.controller.072.test.ts`: 404; zod body; a row 30 s old without `fresh` → facts not loaded; with `fresh=1` → one recheck.
    - `readiness/readiness.072.pg.test.ts` (own database through `scratchDb`): recheck stores and updates the row; `firstSeenAt` kept; the sweep set (approve/live cards and open launches only); `applied_hash` untouched by `recheck` and written by `setAppliedHash`; `@X` and `@x` update one row.
    - `editor.module.test.ts` stays green.
  - Done when: `GET` never fixes and never stamps a notify; a sweep of the scratch database costs no model call.

- [ ] **T7 Owner bot, launch and graduation** (FR-009, FR-010 owner-bot and Start parts, FR-011, A9, A13, A22, A31, L8)
  - What:
    - `readiness/readiness-cards.ts`: `readinessSource` with the A9 refId, the blocker lines, the A13 «Виправлю в один дотик:» list (≤ 5) and the buttons.
    - `launch/launch-cards.ts`: `LaunchCardDeps.readiness?` (`blockers(channelKey)` from the stored row); the Start card body and confirm with blockers; `act('start')` adds «Відкритих блокерів: N» when N > 0 (A31).
    - `launch/launch.service.ts`: `LaunchDeps.readiness?.recheck(key, 'start')` in the background beside `planAhead` (the only `doStart` edit; the `setMode` call stays as found); `graduation.blockers?`; the A22 `heldBy`/`heldBlockers` writes in `checkGraduation` and the owner's Go live.
    - `launch/launch.types.ts`: `heldBy?`, `heldBlockers?`. `launch/launch-graduation.ts`: the `graduationStep` detail.
    - `editor.module.ts`: `READINESS_SERVICE` in the OWNER_BOT and LAUNCH_SERVICE inject lists; `readinessSource` after `launchSource`.
  - Files: `readiness/readiness-cards.ts` (new), `launch/launch-cards.ts`, `launch/launch.service.ts`, `launch/launch.types.ts`, `launch/launch-graduation.ts`, `editor.module.ts`.
  - Tests:
    - `readiness/readiness-cards.072.test.ts`: Ukrainian title with `plural`; ≤ 5 blocker lines and «…і ще N»; the fix list; buttons («Виправити все» only when K > 0); the refId changes with the set and with the stamp's day; `act` outcomes and refusals.
    - `launch/launch.052.test.ts` extended: the Start card with and without blockers; the `act('start')` outcome with N; auto graduation holds with blockers and stores `heldBy`, then switches once blockers are 0 and resets `heldBy`; propose unchanged; `graduationStep` shows the wait.
    - `owner-bot.012.test.ts` and `editor.module.test.ts` green.
  - Done when: nothing in this task changes a channel's mode by itself.

- [ ] **T8a Dashboard: the Readiness panel on the Overview** (FR-008, A5, A11, A13, A17, L3)
  - What:
    - `api/readiness.ts`: `getReadiness(key, { fresh? })`, `useReadiness` (plain GET, `fresh=1` inside the A11 window), `markReadinessStale()`, `useRecheckReadiness`, `useFixReadiness` (body `{ codes?, keys? }`; both `setQueryData` and carry `meta: { readiness: true }`).
    - `lib/readiness.ts`: badge, body line, 24 h line, Fix-all confirm text, deep link, `readinessPath`, `isFreshWindow`.
    - `components/readiness/ReadinessPanel.tsx` + `readiness.css` (CompactCard + dialog, area classes, no inline colour): rows with Badge, title, detail, "Since", "Open" link, a row "Fix" button sending `keys: [key]`; "Resolve in one card" on `config_conflict` rows (A5); "Fixed by code"; Recheck; Fix all (only when `fixable > 0`, `useConfirm` listing the labels). Server strings only; no `lib/reasons.ts` (A17).
    - `components/agents/AgentOverview.tsx`: the panel replaces `ConflictsLine` (`:94-109`, rendered `:157`) for resource orchestrators with a `channelKey`; remove `ConflictsLine` and its now-unused imports only.
    - `lib/align.test.ts`: the file list becomes `AgentMemoryHistory.tsx` and `components/readiness/ReadinessPanel.tsx`.
  - Files: as listed.
  - Tests: `lib/readiness.test.ts` (badge, body, 24 h line, confirm text, deep link, `readinessPath`, `isFreshWindow`); `lib/align.test.ts`; `lib/no-cyrillic-ui.test.ts`; `tsc`, `test`, `build`.
  - Done when: the Overview shows the panel and nothing on a 404.

- [ ] **T8b Dashboard: the editor page, the launch panel, the deep link, the after-save recheck** (FR-008, A11, A26)
  - What: the panel on `routes/app.editor_.$channel.tsx` (after the StatStrip `:70-77`, before `CardSummary` `:80`) and in `components/launch/LaunchBody.tsx` above the Checklist section (`:29-37`, `v.channelKey`; `EmptyState` "Readiness is not available" on 404 or error); `readiness` in `validateSearch` of `routes/app.agents_.$handle.tsx` (`:36-44`) and `focused` on the panel; in `router.ts` `MutationCache.onSuccess`, `markReadinessStale()` and the `['readiness']` invalidation unless `mutation.meta?.readiness`, both before the `skipNavBadges` return.
  - Files: as listed.
  - Tests: `lib/readiness.test.ts` (deep link parsing); `tsc`, `test`, `build`. Browser check with the A26 mock on port 3172 in all three modes (blockers, none, 404), at 1280 px and 375 px.
  - Done when: the panel shows in the three places, Fix all and Recheck work against the mock, a 404 shows no crash, and the mock is not committed.

- [ ] **T9 Dashboard: Start anyway** (FR-010 dashboard parts, A23, A24, L9)
  - What: the blocker confirm in `ModeSwitch` (`components/editor/EditorUi.tsx:96`) and `AgentModeSwitch` (`components/agents/AgentsUi.tsx:97`) when going from `off`/`shadow` to `approve`/`live`: `useQueryClient().fetchQuery` with `fresh=1` inside try/catch, then `confirm(startPhrase(...), { confirmLabel: 'Start anyway', danger: false, details })`; the live path then opens `AutonomyDialog` as today. The `launch:start` confirm in `components/artifacts/ArtifactPanel.tsx:281-283` adds `details` and "Start anyway" when there are blockers. `startPhrase` and `blockerLines` in `lib/readiness.ts`.
  - Files: as listed.
  - Tests: `lib/readiness.test.ts` (`startPhrase` singular and plural, up to 5 lines and "…and N more", label "Start anyway"); `tsc`, `build`.
  - Done when: with 0 blockers, or when the readiness fetch fails, both switches and Start behave exactly as before.

- [ ] **T10 Docs and close-out**
  - What: runbook § 32 "Channel readiness (spec 072)" in `docs/runbooks/agent-platform.md` (what it checks, the codes table in short, the two auto-safe fixes and `READINESS_AUTO_FIX`, Fix all's scope, the owner-bot card, Start anyway, the graduation wait, how to read `channel_readiness` with SQL); `specs/README.md` row 072; this spec's Status → done; fill «Status» and «Deltas from the spec» below (the `skill-warnings.ts` exports, the stale launch card, the lead's mirror switch, and anything else that differs).
  - Files: `docs/runbooks/agent-platform.md`, `specs/README.md`, `specs/072-channel-doctor/spec.md`, `specs/072-channel-doctor/tasks.md`.
  - Tests: none new; the full unit suite, the touched PG files, dashboard checks.
  - Done when: README row reads `| 072 | [Channel doctor and Readiness](072-channel-doctor/spec.md): … (AI0-250) | P1 | 055, 047, 052, 060, 068, 069, 071 | DONE (migration 097) |`.

## Status

## Deltas from the spec

Written task by task; the list is appended to as each task lands.

**T1**
- `runFix` and its ports moved to `sysadmin/fix-runner.ts`; `AuditService` re-exports `AuditFixPorts` and its `apply` stores `runFix(...).applied`. The `applyConflicts` port gained an optional filter (`{ codes?, ref? }`), wired in the `AuditService` factory of `editor.module.ts` as a predicate over the conflict (`code`, `ref`) passed to `conflicts.apply`; with no filter it behaves as before.
- A fix that the runner refuses throws `{ response: { error, details } }` (as the audit's own refusals did); `tryFix` wraps it and never throws. Refusal codes in use: `fix_unavailable`, `owner_pause`, `pause_not_found`, `already_resumed`, `nothing_to_apply`, `agent_not_found`, `nothing_to_retire`.
- The A32 check runs the real `applySeriesOp` (not a fake) for `series_source_require`.
- Correction made in T4a: T1 had left `FIX_ALL_EXCLUDED_KINDS` empty. Lead decision I3 and the contract name it `['bind_dataset', 'dataset_patch']` (strings; the two kinds are 075's and arrive in W2, so they are not in `FIX_KINDS` yet). `readiness/auto-fix.ts` now holds that list (typed `readonly string[]`) and `auto-fix.072.test.ts` asserts it and that every current `FIX_KINDS` entry is Fix-all eligible.

**T2**
- `database/ci-bootstrap-check.sh` cannot be started from this sandbox (the shell guard refuses `bash <script>`), so its steps were run by a node-pg script on a throwaway database of the scratch server: `init.sql` twice, every migration once in order (one transaction each, recorded in `schema_migrations`), every migration from 042 again, then 097 down twice and up again. All passed and the database was dropped. The same sequence is what `scratchDb` does for the PG tests.
- `scratchDb(url, tag, o?)` names its database `<base>_m097_<tag>_<pid>` and returns `{ pool, url, name, drop() }`; `readMigration`, `readDown` and `applySql` sit next to it.

**T3**
- `ChannelFacts.profile` carries `full` (the whole stored profile) and the facts carry `conflictBase` (`rules` created by the owner, the group's refs in `forAgent` order, the configs of the other refs). A16 lists neither; `applyOverlay` needs them to rebuild `conflictInput` after the card or the profile changed.
- `readiness/facts.ts` also exports the pure helpers `sourceRefsOf`, `blockOf`, `siblingConfig`, `seriesOn`, `canonical` and `resolveChannelKey`, and the `ChannelNotFound` error (`code: 'channel_not_found'`). `RawFacts` is what the loader reads; `deriveFacts(raw)` adds `series` (when not given), `datasets[].boundBy/seriesPerDay`, `sources[].required`, `effectiveTools` and `conflictInput`.
- The planned-slot and last-24 h queries take `kind = 'content'` only (a reserved slot is not a post). Closed means the statuses the streak counter uses (`published`, `shadowed`, `awaiting_approval`, `approved`, `skipped`, `failed`, `expired`), windowed by `scheduled_at`.
- `effectiveTools` for an empty intersection is `['(none)']` (`NO_TOOL`), never `[]`; the tools check (T4b) must read it with `includes`.
- A card source is `required` when it is the only card-origin source among the facts' sources (so a source added by an overlay counts). A series source is `required` when the series is active and `source_mode` is `required`.
- A stored profile that does not parse (the repository's tolerant parser) gives `profile: null`, as `ResourceProfilesRepository.list` returns it. An empty `post_requires` list is `null` in `DatasetFact`.
- `countPostable` is a copy of the `countRows` SQL; `buildCatalog` rolls the round of a used-up cycle dataset (a write). The PG test proves both halves: the loader leaves `data_reuse_rounds` empty and a control call of `buildCatalog` then creates the row.
- `readiness/testing/facts-fixture.ts` (new, test-only) builds small `ChannelFacts` through the real `deriveFacts`; the check, doctor and hash tests of later tasks use it.

**T4a**
- `agents/skill-warnings.ts` got only the two `export` keywords. The rest of the judgement is in `readiness/source-contradiction.ts`: `judgePair(series, candidate, feedUrl)` is the one per-pair function (I14), `seriesSourceContradictions` loops it. Path 1 calls `skillConflicts` with the series source as `keep`; path 2 is `sourceInSkill` plus a source token that is not the series' own, plus one topic word shared with the series name or brief. The series' own token is its library table, the host label of its feed (found through the card source the series names) or the api name; `sameSource` also accepts the first part of a key (length 4 or more) so `prompts` and `prompts_dev` count as the same source.
- A rule or a steering line has no name or description, so its body gives the topic words. A rule comes from `f.rules` (already filtered by `ownerRulesOf`, so an approval-preference row is never a candidate, A19), a steering line from `f.steering`; a skill is a candidate only when it is not built-in and not a safety skill.
- `series_source_contradicted` subject id is `<series>|skill:<id>`, `<series>|rule:<id>` or `<series>|steering:<set>/<n>`, so two texts against one series, and one text against two series, are separate findings (A8). The switch-off fix (`skill_disable` addressed to the orchestrator handle, as the audit does) is offered for skills only; rules and steering get the Memory tab link and no fix.
- `origin_original_with_source` looks at every enabled skill, not only the candidates: the probe of the three built-in skills showed none trips `originWithSource`, and the real nanobanana v4 text does not either (test). It is an error when an active library or feed series exists, a warning otherwise.
- `series_source_not_required` is limited to series on a library dataset (A29's table; a feed or api source has no «require» fix to offer). A series with no `source_mode` is `suggested` by schema default and is reported.
- `dataset_order_random` also flags `after_days` datasets (they are not read in order either). `material_exhausted` ends the checks for that dataset (no `material_low` or order note on a dataset with nothing to post). Cycle datasets count their postable rows (`rows - notPostable`), not their unused ones (L7, A21).
- `dataset_without_series` and the other dataset codes link to different places: the series-less card source to the agent's Schedule tab (the fix is to make a series), the rest to `/app/data/:dataset`.
- Real texts of the two skills of @ai0_prompts_dev (prompthero-image-prompt-post, nanobanana-github-prompt-post) are in `readiness/fixtures/real-skills-1027.ts`, copied as JSON string literals from the export; T5 reuses them. `testing/facts-fixture.ts` gained `PROMPT_BRIEF` and `promptSeries` (real name and brief, synthetic library source and `required`, A2).
- `doctor.072.test.ts` checks the purity rule by reading the sources of the doctor, `finding.ts`, `source-contradiction.ts` and every `checks/*.ts`: no `pg`, `.query(`, `Date.now()`, `new Date()`, `fetch(` or `Pool`. The content-table lint reads test titles too, so no title says «from <word>».

**T4b**
- `checks/tools.ts` keeps `SOURCE_TOOLS` (the A29 table) as a local map, marked for replacement by 073's `SOURCE_READ_TOOLS` at merge (I13). An allowlist with nothing in it is no limit, as in `intersectAllow`. One finding per missing tool, keyed by the main tool of the "any of" (`query_data`, `fetch_feed`, `web_fetch`, `fetch_api`); error when an active series needs it, warn for card sources alone.
- The fix is `tools_allow_add` only when the card list is a cause and the loadout is not: with both lists lacking the tool, adding it to the card cannot help, so the finding has no fix and the link is the Loadout tab (the card finding then shows its fix once the loadout is right). When the loadout holds `search_library` but not `query_data`, the fix adds the one the intersection keeps. Without an agent the loadout link falls back to the card editor.
- `checks/config.ts`: `ConfigSeam` has a third function, `isRepairable(p)`, so I5 is one call at merge. `makeConfigCheck(seam)` builds the check and `configCheck` uses the default (empty) seam. A seam problem has a code of 073's, which is not in `DOCTOR_REASONS`, so its finding is built directly (`findingKey`, the Schedule link, title = catalogue text if there is one, else the code in words); a repairable problem is `info` and its detail ends with «It will be repaired before the run.»
- `hashtag_min_without_vocabulary` is read from `configConflicts` (this channel's ref) so the doctor and the old audit use one definition. `config_conflict` is one finding per `(code, ref, rule_id)`: three `slang_in_tone` conflicts of one rule are one finding that keeps all details and fix targets in `evidence`, and one `conflicts_resolve` for the code resolves them all. A finding has a fix only when the channel has an agent.
- `formats_diverge` needs an independent group (`group.mode === 'independent'`) and a playbook section for this resource; a weight of 0 and a missing format are the same. The detail names the format and the side that enables it.
- `checks/pauses.ts`: `pause_cause_gone` for `no_material` needs the pause to name a series on a library dataset (`series:<name>`); a `rule:` or `resource:` pause, a feed or api series, or an unknown series stays `series_paused` (it keeps its resume button). A cycle dataset counts postable rows (`rows - notPostable`). For `source_unreachable` the source is the series' `SourceFact`; `hostBlock` in the facts is already only an active block, and `lastSuccessAt` is null until 076, so it never fires in W1.
- `checks/launch.ts` has its own `launchArtifactPath` (the same string as `launchPath` in `launch/launch-cards.ts`, which pulls in the owner bot; a test keeps the two equal).
- `codes.072.test.ts` reads the check sources for `code: '<name>'` literals: every one is in `DOCTOR_REASONS`, and every catalogue entry except `auto_fixed` (the service's, A20) is emitted by a check. The content-table lint reads test titles too, so titles avoid «from <word>».

**T5**
- The export was read from the scratchpad copy (never committed); `fixtures/real-skills-1027.ts` (generated) now also holds the two skills @ai0_global has enabled (`post-promises-and-terms`, inline, and `prompts-chat-source`) as `AI0_GLOBAL_SKILLS`. The header of `fixtures/onboarding-1027.ts` lists what is real and what is synthetic, as A3 asks; a test keeps both words in it and checks that no bot token is in the file.
- `makeFacts` takes `channelKey` and `agentHandle`, so the three replays use the real channel keys and agent handles (`ai0_prompts_dev`, `pdr_dev_channel`, `ai_global`; the orchestrator handle of @ai0_global is `ai_global`, not `ai0_global`).
- The real @pdr_dev_channel ledger has its 866 uses on 2026-05-19…2026-06-17, so `used28` is 0 there; the export's one `pdr_questions` row means the 866 rows are declared in the dataset fact (synthetic), as A3 says.
- Result of the replays, by the doctor alone: @ai0_prompts_dev has four errors (`series_source_contradicted` for the prompthero skill through path 2 and for the nanobanana skill through path 1, `origin_original_with_source`, `dataset_low_fill`); @pdr_dev_channel has `dataset_without_series` and `material_exhausted` as errors and `dataset_post_requires_missing` as a warning; @ai0_global has no error, one `skill_prescribes_source` warning (`prompts-chat-source` names prompts.chat, and no series contradicts it) and the `series_paused` info. A fourth test applies the fixes (both skills off, the 095 `post_requires` rule): @ai0_prompts_dev then has no error.
- The contradiction detail now reads «…, but skill «x»: it names "prompthero" as a source for the same …» (a colon replaces the broken «but skill «x» it names»).
