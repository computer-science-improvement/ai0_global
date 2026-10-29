# 074 — Changes take effect by themselves

Status: draft · Builds on 023 (owner pins), 034 (partial replan), 060 (series breaker), 068 (honest empty days), 071 (rows in order), 072 (doctor, `afterRecheck`, `channel_readiness.applied_hash`), 073 (`checkSlotConfig`, skip class `config`, reason catalogue), 076 (`probeSource`), 078 (pause banners) · Migration none · Linear AI0-252

> **Read the «Amendments after the builder check» section at the end first.** Where it differs from the body, the amendment wins.

Wave 7, W2 (built in parallel with 075, on W1 merged in the order 073 → 072 → 076). The binding contract is `<scratchpad>/w7/contract.md`. The authoritative design is `docs/reviews/2026-10-27-channel-onboarding.md` §6 "074" and §7. The code map with every anchor is `<scratchpad>/w7/map-074.md`.

Anchors are at `feat/editor-agent` 1ecb8160. W1 names follow the contract. Where the contract is silent they follow the 073 draft (`specs/073-config-is-not-content/spec.md`); see Lead calls and the contract issues in the map.

## Why

The owner asked on 10-27:

> «мені потрібно щоб коли я додаю новий канал то це було просто, швидко і зручно, щоб не доводилось 2 тижні дебажити його роботу»

On stage, each fix to a young channel took effect the next day at the earliest. Until then a hand-made replan was needed:
- **@ai0_prompts_dev, 10-27.** The Prompt series moved from PromptHero rows to `nanobanana_prompts`. Today's planned slots kept the old hints, and the series stayed paused after its 10-22…26 skips. Resume did not replan. The owner rule, the import, the series source, the skill detach and the replan were all done by hand.
- **@pdr_dev_channel, 10-27.** A series added after the day's plan got no slot today, because the day is planned once. The channel's own plain-slot pause (068 empty days) stopped all planning, its future series included.

This spec closes three failure classes:
- **F07 (sev 4): planned slots, pins and drafts keep the old config.**
  - `maybePlan` returns once the day has an active, non-placeholder plan (`editor.scheduler.ts:344-354`); `maybePlanAhead` does the same (:311-321).
  - `commitSeriesChange` only inserts a playbook version (`schedule/schedule.service.ts:630-644`).
  - A pin is materialised once per (rule, date) with `ON CONFLICT DO NOTHING` (`schedule/schedule.repository.ts:95`). Only `updateRule` drops future pins (`schedule.service.ts:591`).
  - `materialiseAgent` finds the pin's series by name and ignores `active` (:264).
- **F10 (sev 4): pauses never lift by themselves, and Resume does not replan.**
  - `SeriesPauseActions.resume` only updates the row and logs a line (`series-pause/pause-actions.ts:58-66`).
  - The change_source Apply only upserts the card (`sources/source-tools.ts:105-116`).
  - A plain-slot pause gates all planning of the channel, series and pins included (`editor.scheduler.ts:181`).
- **F27, part 3 (sev 2): the slots of a removed or switched-off series run as unbound posts.**
  - `seriesForSlot` returns null for them (`schedule.service.ts:291-306`).
  - 073 FR-009 skips them when they run (`config_series_gone`). 074 skips them when the change is seen and replans the new instance when it has no slot.
  - Parts 1–2 of F27 are 073 FR-007.

What already follows a change, and stays:
- Series slots read the current brief, required source and next row at run time (`schedule.service.ts:312-327`).
- 073's runtime config pre-flight repairs format and source hints before the writer. It stays as the backstop.
- 074 makes the plan right when the change is made. The plan the owner sees, the approval write-ahead (36 h ahead) and the doctor then agree, and the slots that do not exist yet (a new series, a moved time) are made.

## What

### FR-001 The repair hook (F07)

There is a new folder `apps/automation/src/editor/config-repair/`, and `ConfigRepairService` runs one channel's repair:
```ts
export type RepairTrigger = 'config' | 'resume' | 'source_change' | 'auto_resume';
export interface RepairOutcome { repaired: number; skipped: number; pins: number; replan: 'none' | 'started' | 'capped' | 'busy' | 'off' | 'error' }
run(channelKey: string, trigger: RepairTrigger, o?: { hash?: string; baseline?: boolean; since?: Date }): Promise<RepairOutcome | null>;
```
- **Registration.** It registers once with `ReadinessService.afterRecheck` (072). The payload is `{ channelKey, prevHash, hash, facts, findings }`. The hook reads `channel_readiness.applied_hash` itself and acts only when `hash !== applied_hash`. When `applied_hash` is null, it runs a baseline: repair, no replan. That happens on the first sweep after the deploy and on a new channel's first check.
- **Never awaited.** The hook starts `run` and returns, so a slow repair never holds the doctor sweep.
- **Single-flight per channel.** A call while a run is going marks the channel dirty, and one more run follows with the latest hash.
- **Order of a run:**
  1. Read the card. A missing card, or mode `off`, ends the run with `replan: 'off'`.
  2. Slots (FR-002).
  3. Pins (FR-003).
  4. Replan decision (FR-004), skipped on a baseline.
  5. `UPDATE channel_readiness SET applied_hash = $2 WHERE channel_key = $1`, only when `o.hash` was given, no step threw, and the replan was not `busy`.
- **Runs without a hash.** A run for `resume`, `source_change` or `auto_resume` (FR-005, FR-006) never writes `applied_hash`.
- **No loop.** A run writes only `editor_slots` rows (status, format, hints, a note) and pin slots. It never writes a config column, so the next sweep sees the same hash.
- **Logging.** One log line per run, e.g. `config repair @x (config): 3 repaired, 1 skipped, 2 pins, replan none`.

### FR-002 Planned slots follow the config at $0 (F07, F27)

**Which slots.**
- A slot qualifies when all of these hold:
  - `kind = 'content'`, `status = 'planned'`;
  - `scheduled_at > now + 10 min` (`REPAIR_LEAD_MS`);
  - `plan_date` is today or tomorrow in the card zone;
  - `schedule_rule_id IS NULL` (pins are FR-003);
  - `derived_from_slot_id IS NULL`;
  - not a repurpose slot and not news-watch (the `REPLACEABLE` filters, `repo/editor-plans.repository.ts:182-183`);
  - no running preview (`preview_draft->>'status' <> 'running'`).
- A pure `repairable(slot, now)` states the same filter for the unit tests.

**What happens to each slot.** A pure `planSlotRepair(slot, ctx)` returns `keep`, `patch {format?, sourceHints?, note}` or `skip {error}`. The rules apply in this order:
1. **The series is missing or `active: false`.** Skip `config_series_gone: series "<name>" was removed or switched off` (073's code, in `NOT_A_MISS` per 073 FR-010).
2. **The series is paused.** Keep. The breaker skips its slots (`series-pause/series-breaker.ts:85-91`).
3. **The series moved.**
   - The slot is outside ±`SERIES_WINDOW_MIN` (90, `schedule/plan-schedule-rules.ts:21`) of every instance of its series that day (`dueInstances`, :91-103).
   - Or the slot's topic mode no longer matches `seriesTopicMode(series.source)` (`schedule.service.ts:29`): fixed against live, either way.
   - Then skip `config_series_changed: series "<name>" now runs at HH:MM` (or `… now reads a feed`). FR-004 decides whether the new instance needs a replan.
4. **Otherwise.** Run `checkSlotConfig(slot, ctx)` (073). Problems marked repairable go through `repairSlotConfig` (073): `config_format_mismatch` becomes `series.format`, and `config_source_mismatch` becomes `series:<name>` plus the next row. Then the hints are cleaned by the pure `rehint(hints, series)`:
   - drop `library:`, `feed:`, `api:` and `network_highlights:` hints that `sourceHints(series.source)` (`schedule/series-guard.ts:10-19`) does not produce;
   - drop `data://` rows of another dataset;
   - add the series' own source hint and keep `series:<name>`;
   - keep at most 5 hints, as `materialiseAgent` does.

   Other problems (`config_source_missing`, `config_tools_missing`, `preflight_no_material`) are left to the runtime pre-flight and the doctor.
5. **A plain slot on the channel's own resource** whose format is missing from `card.formats` or has weight 0 takes the card's highest-weight format.

**Writes.**
- A patch goes through `ConfigRepairRepository.patchPlanned(id, patch)`: `UPDATE … WHERE id = $1 AND status = 'planned'`, with the note appended to `lint_warnings` as `retopicSlot` does (:727). The note reads like `config_repair: format quiz → text (series "Тест дня" changed)`.
- A skip goes through the existing guarded `skipPlannedSlot` (:615).
- A slot claimed meanwhile is not written.

**Invariant.** After a patch, `checkSlotConfig` on the patched slot returns no repairable problem. A unit test checks this on every fixture slot.

### FR-003 Pins follow their series (F07)

- **Extract `pinSlotSpec`.** The pure `pinSlotSpec(rule, series, at: { anchorRef, tz, date, cardTz })` moves to `schedule/pin-slot-spec.ts` and returns the `PinSlotInput` or null. Its body is the loop body of `materialiseAgent` (`schedule.service.ts:265-281`).
  - `materialiseAgent` calls it. Behaviour is the same except one thing: a series with `active === false` counts as missing (:264).
  - So a pin of a switched-off series becomes a plain owner pin when it has its own format, and is not materialised when it has none.
- **The repair.**
  - Take each active pin of the channel's orchestrator (`ScheduleRepository.activePins`, `schedule/schedule.repository.ts:45`) that has planned pin slots after `now + 10 min`, today or tomorrow.
  - Compare each such slot's format, topic, hints, `series_name` and topic mode with `pinSlotSpec` for its date.
  - On any difference, call `dropFuturePins(rule.id, now + 10 min)` (:84; it deletes only `planned` pin slots after that time). Then call `materialiseAgent(orch, card, now)` once per channel.
- Written and running pin slots are never touched.

### FR-004 A capped replan, only when a due owner series has no slot (F07, F10)

**Which instances count.** A pure `uncoveredInstances(ctx, daySlots, now)` returns the instances that meet all of these:
- the instance comes from `dueInstances(ctx)` and belongs to a **locked** (owner) series on the channel's own resource;
- it is at least 30 min ahead;
- 073's skeleton check did not leave it out (see the map's contract issue);
- no slot of that series lies within ±90 min. A slot counts unless it is `skipped` or `failed`, and a planner placeholder (`planner_*`) counts too;
- no pin of that series is in `ctx.pins`.

`ctx` comes from `ScheduleService.planContext(card, net, date, now, 'single')` (`schedule.service.ts:168-198`), which already leaves out paused series.

**When it replans.** All of these must hold:
- the run is not a baseline;
- at least one instance is uncovered;
- the date has an active plan that is not a placeholder (`isPlaceholderPlan`, `editor-plans.repository.ts:194`). Without one, `maybePlan` plans the day anyway;
- that plan's `created_at` is before `changeAt`. `changeAt` is the latest of: the active playbook's `COALESCE(decided_at, created_at)`, the channel's latest `series_pauses.resumed_at`, and `o.since` (set to now by the owner triggers).

**How it replans.**
- Today first: `EditorOpsService.replan(key, { wait: false })` (`api/editor-ops.service.ts:186-198`). It is a partial replan: `REPLACEABLE` and `KEPT` (:182-188) keep everything written, running, pinned or due within 5 min.
- Tomorrow is replanned (`date: 'tomorrow'`) only when all of these hold:
  - the channel is in approve mode;
  - tomorrow has a non-placeholder plan;
  - this is a later run than today's replan, because `replan_in_progress` allows one replan per channel at a time.

**The cap.**
- New setting `CONFIG_REPLANS_PER_DAY` (default 2, 0 = never) limits these replans per channel and plan date. The count is kept in memory.
- There is also a durable ceiling, `CONFIG_REPLAN_RUN_CEILING` = 6. There is no replan when the channel already has that many `role = 'planner'` rows in `editor_runs` on that local date. The query has the same shape as the one in `maybeOrchestrate` (`editor.scheduler.ts:337-340`).

**Over the cap.**
- One Inbox note per channel and day: kind `config_replan_capped`, severity `action`, subject `config_replan:<channel>`, parts `day:<date>`.
- English body: `Series "<name>" has no slot today at HH:MM. Its setup changed after today's plan, and today's automatic replans are used up (2 of 2). Replan the rest of today on the channel page, or wait for tomorrow's plan.`
- Ukrainian alert: «Серія «<name>» сьогодні без слота о HH:MM: налаштування змінилися після плану, а автоматичні переплани на сьогодні вичерпано (2 з 2). Переплануй решту дня на сторінці каналу або дочекайся завтрашнього плану.»

**What each outcome does.**

| Outcome | When | `applied_hash` | Next sweep |
|---|---|---|---|
| `busy` | `replan_in_progress` (a ConflictException) | not written | retries |
| `off` | the editor is disabled or the channel is in mode off | written | — |
| `capped` | over the cap | written | — |
| `started` | the replan started | written | — |

### FR-005 A pause whose cause is gone lifts by itself (F10)

**When it runs.**
- `AutoResume.tick(now)` lives in `config-repair/auto-resume.ts` and runs after the breaker check, throttled to 10 minutes.
- It is wired by changing the scheduler's breaker hook at `editor.module.ts:1783` to `check: async (now) => { await breaker.check(now); await configRepairPort.tick(now); }`.
- It does not depend on the readiness hook, because a pause must lift with no config change: rows imported, or a site back up.

**What it looks at.**
- Open pauses (`SeriesPausesRepository.open`, `series-pause/series-pauses.repository.ts:59`) with cause `no_material` or `source_unreachable` and a `series:` or `rule:` key.
- `resource:` pauses stay with the owner.

**Never lifted:**
- A pause with cause `owner`.
- A pause the owner kept. Its note carries the `keep()` trace (`pause-actions.ts:72`). The trace text becomes the exported constant `KEPT_TRACE`, and both sides use it.
- **Flapping.** The same channel and key was resumed with `resumed_by = 'code'` less than 24 h before this pause opened. The pause note then gets one line: "Resumed automatically at HH:MM and paused again; it now waits for you."

**Lifted at once:**
- A `series:` pause whose series is gone from the playbook or is `active: false`. The reason is `series removed`.

**Lifted after two clear checks.** The pure `causeCleared(pause, ev)` returns `{ cleared, why }`, and a pause lifts after two clear checks at least 5 min apart (an in-memory map, reset by a check that is not clear or by a restart). What counts as clear:
- **`no_material`, library source:** `ev.unposted(ref, table) > 0`. This is the `unposted` port (`editor.module.ts:1201`, `buildCatalog` in `data/data-catalog.ts:156`), and the seam for 075's `postableCount`.
- **`no_material`, either kind:** the series source differs from the one it had when paused, i.e. an active playbook decided after `paused_at` carries another source.
- **`no_material`, feed source:** some `probeSource(url)` result (076) has `newest_at > paused_at`.
- **`no_material`, api and network_highlights sources:** not judged.
- **`source_unreachable`:** every URL of the source (`seriesLiveSources(series.source)`, the rule's own source for a `rule:` key) probes ok, and `PgHostFailures.blocked(host, use)` (`net/host-failures.ts:194`) is null.
  - 076 caches probes for 6 h, so the hosts of open pauses are re-probed at most every 6 h, whatever the channel's age.
  - No URL known means not judged.

**On lift:**
1. `repo.resume(id, 'code')` (:81).
2. A line is added to the pause's notes and they are marked read. The SQL of `log()` (`pause-actions.ts:46-55`) is extracted as `logOnPauseNotes(pool, pauseId, line)`. The line reads "Resumed automatically: <why> (YYYY-MM-DD HH:MM UTC)".
3. `OwnerCardsRepository.presetOutcome('inbox', noteIds, '▶️ Відновлено автоматично: <причина>')` sets the outcome of the live cards. The minute sweep then closes those cards with that text: `owner-bot/owner-bot.service.ts:164` becomes `expired.has(c.refId) ? 'Минув термін' : c.outcome ?? 'Вирішено в дашборді'`.
4. `ConfigRepairService.run(channelKey, 'auto_resume', { since: now })`.

The Ukrainian reasons:
- «у датасеті знову є непоказані рядки (N)»;
- «у фіді з'явилися нові записи»;
- «джерело серії змінено»;
- «джерело знову відповідає з сервера»;
- «серію прибрано».

**Setting.** `SERIES_AUTO_RESUME` (bool, default on, applies live). Off means nothing is lifted by code.

### FR-006 The owner's Resume and change_source Apply run the same repair (F07, F10)

- **The port.** `config-repair/config-repair.port.ts` exports the singleton `configRepairPort = new ConfigRepairPort()`.
  - It is late-bound like `PlaybookBuildPort` (`editor.module.ts:1600`).
  - `run(channelKey, trigger)` and `tick(now)` are no-ops with a log line until it is bound.
- **The provider.** A new provider `CONFIG_REPAIR` builds `ConfigRepairService` and `AutoResume`, binds the port and registers the `afterRecheck` hook. It injects:
  - `DB_POOL`, `ConfigService`, `EDITOR_REPOS`;
  - `EDITOR_OPS`, `SCHEDULE_INFRA`, `AGENT_INFRA`;
  - 072's readiness token.
- **Resume.** `PauseActionsDeps` (`pause-actions.ts:17-22`) gains `afterResume?: (p: SeriesPause) => void`.
  - It is called after a resume that changed something (:64-65). It is not awaited, and its errors are logged.
  - The three instances (`editor.module.ts:1207`, :1949, :2429) pass `afterResume: (p) => configRepairPort.run(p.channelKey, 'resume')`.
  - That covers the dashboard (`agents/agents.service.ts:403-420`), the Telegram card and the bundle item (`series-pause/pause-resume-action.ts:44-56`).
- **change_source Apply.** `applySourceChangeAction` gains `after?: (channelKey: string) => void`, called after the upsert. Its registration (`editor.module.ts:942-945`) passes `after: (k) => configRepairPort.run(k, 'source_change')`.
- **The `since` value.** Both triggers pass `since = now`. A due owner series without a slot is then replanned within the cap (FR-004).

### FR-007 A plain-slot pause no longer stops series and pins (F10)

- **The new dependency.** `EditorSchedulerDeps.seriesPauses` (`editor.scheduler.ts:81`) gains an optional `seriesDue?(card, date, now): Promise<boolean>`.
  - It is true when the date has a due instance of an active, unpaused series on the channel's own resource, or a pin slot.
  - It is implemented in `config-repair/series-due.ts` over `planContext`, `dueInstances` and `pinsOn` (`schedule.repository.ts:155`).
- **The scheduler.**
  - At :181, a plain-paused channel still calls `maybePlan` and `maybePlanAhead`, with a gate `(date) => seriesDue(card, date, now)`.
  - Each method returns when the gate says no. The check goes right after its date and active-plan checks (:346-348, :313-315) and is one line each.
  - `newsWatch` stays gated, because its slots are plain live slots.
  - Without `seriesDue` the behaviour is unchanged (`series-pause/series-pause.060.test.ts:253`).
- **What the planner already gets.**
  - `planContext` passes the resource pause (`schedule.service.ts:190-196`).
  - `planScheduleErrors` refuses plain slots there (`plan-schedule-rules.ts:187-191`).
  - The day minimum is 0 (`minAfterPauses`, :244).
- **The prompt line.** The resource-pause line in `scheduleBlock` (:288) wrongly says «не плануй слотів цієї серії … обери іншу серію чи формат». For a `resource:` pause it becomes «звичайні слоти <ref> на паузі (<n> пропусків поспіль) — плануй лише серії та закріплені пости цього ресурсу».

### FR-008 What the owner reads (F10, F11 part)

**Dashboard (English):**
- `lib/agent-overview.ts:43-47`: `pauseEffect(key, cause?)`. `PauseBanners.tsx:74` passes `p.cause`. The texts:

  | Pause | Text |
  |---|---|
  | series, not the owner's | "The planner skips it and its planned slots are skipped at no cost. It resumes by itself once its source has material again; Resume does it now." |
  | series, the owner's | "The planner skips it until you resume it." |
  | rule | "This fixed slot is skipped until its source has material again or you resume it." |
  | rule, the owner's | ends "until you resume it." |
  | resource | "Plain slots are not planned. Series and fixed slots still are." |

- `PauseBanners.tsx:60-65`: the Resume toast becomes "Resumed. Today's plan picks it up within a few minutes." Before the plan hour, the existing `nextPlanLine` stays.
- `components/agents/AgentSchedule.tsx:526`: the series save toast gains "Planned slots follow it within a few minutes."
- `lib/inbox-kinds.ts:196-202`: the `series_paused` why becomes "A paused series is no longer planned, so readers stop getting it. It resumes by itself once its source has material again on two checks in a row; Resume does it now."
- `lib/inbox-kinds.ts`, new `config_replan_capped`:
  - why: "The setup changed after today's plan and today's automatic replans are used up, so a series has no slot today.";
  - one step, the link "Open the plan" to `/app/editor/$channel`, where "Replan the rest of today" is (`routes/app.editor_.$channel.tsx:50-60`).
- `lib/status-tone.ts:80` `NOT_A_MISS` gains `/^config_series_changed\b/`, and `lib/reasons.ts` (073's mirror) gains the two new codes.

**Server:**
- `silent/skip-reasons.ts:21` `NOT_A_MISS` gains `/^config_series_changed\b/`. The skip is the system's own bookkeeping; if no replan follows, the capped note tells the owner.
- `reasons/catalogue.ts` (073) gains `config_series_changed` and `config_replan_capped` (kind `config`, en, uk, fix, link `/app/editor/:channel`).
  - 074 exports `CONFIG_REPAIR_CODES`, and the catalogue coverage test reads it.
- **Stale "Overview → Paused series" texts.** At HEAD the pauses are banners on every agent tab (`routes/app.agents_.$handle.tsx:94`, spec 078 D6), not an Overview section. These texts change:
  - `series-breaker.ts:35` becomes "It resumes by itself once its source has material again on two checks in a row. To resume it now, press Resume on this note, on the agent page banner or on the Telegram card." The Ukrainian alert gains «Відновиться сама, щойно в джерела знову буде матеріал.»
  - `pause-resume-action.ts:54` and `docs/import-bundle.ts:163` now name "the pause banner on the agent page". In the Ukrainian line it is «банер паузи на сторінці агента».
- `settings/catalog.ts`: `SERIES_AUTO_RESUME` and `CONFIG_REPLANS_PER_DAY` go after :129. Their help says what lifts by itself, the 24 h flap guard, the cap and the note.

## Not doing

- **From §7, binding:**
  - no stale-drafts card or badge: in approve mode the owner rejects a draft that looks wrong;
  - no code path that changes a mode;
  - no event bus or DB triggers;
  - no paid rehearsal;
  - no rewriting of skill, rule or brief prose. Slot topics are not rewritten either: the writer gets the current brief at run time.
- **Network sections.** Plain slots on another resource keep their format, because section weights belong to the network planner. Their series slots are repaired like the channel's own.
- **Plain-slot hints** are not rewritten; the writer chooses its sources.
- **`resource:` pauses** are not lifted by code. With FR-007 they no longer stop series.
- **The streak's minimum span** (F10 part 1) is unchanged.
- **No new column.** The repair's result is visible in the slot notes, the log and the capped note (Lead call 7).

## Tests

**Unit tests** (no DB, fakes only, `*.074.test.ts`):
- `repair-plan.074`: `repairable` (running, written, claimed, derived, repurpose, news-watch, a running preview, ≤ 10 min, the day after tomorrow); each `planSlotRepair` rule; `rehint`; the invariant against `checkSlotConfig` on every fixture slot.
- `pin-slot-spec.074`: equals what `materialiseAgent` wrote before the extraction, as a golden fixture; an inactive series counts as missing.
- `uncovered.074`: covered by a slot within ±90 min, by a pin, by a placeholder; < 30 min ahead; an unlocked series; a paused series.
- `cause-cleared.074`:
  - each cause and source kind;
  - owner and kept pauses are never lifted, a flap is not lifted, a removed series is lifted;
  - two clear checks 5 min apart, and a reset in between.
- `config-repair.074`, with fake repos and ops:
  - single-flight with a dirty rerun; the hook is not awaited;
  - a baseline does not replan; equal hashes do nothing;
  - `replan_in_progress` leaves the hash unwritten and the next call retries; capped writes it and sends one note per day;
  - the in-memory cap and the durable ceiling; mode off; `changeAt` ordering.
- `editor.scheduler.test.ts`, extended: a plain-paused channel with a due series is planned; one with nothing due is not; `newsWatch` stays gated; without `seriesDue` the 060 test passes unchanged.
- `plan-schedule-rules`: the resource-pause line.
- `pause-actions` / `source-tools`: `afterResume` runs once on `resumed` and never on `already_resumed`; `after` runs after the upsert.
- `owner-bot`: the sweep closes a card with its preset outcome.
- The catalogue covers `CONFIG_REPAIR_CODES`; the `NOT_A_MISS` mirror test passes.

**PG tests** on the scratch database (`EDITOR_PG_TEST_URL`; each file creates and drops its own `t074_*` database):
- `config-repair.074.pg.test.ts`:
  - a series format change patches today's and tomorrow's planned slots and leaves running, awaiting-approval and pin rows;
  - a slot set to `running` between the select and the write is not written;
  - a removed series is skipped `config_series_gone`; a moved cadence is skipped `config_series_changed`;
  - pins come back with the new brief and format;
  - `applied_hash` is written; a second run writes nothing;
  - the planner-run ceiling query and `changeAt` from `playbooks.decided_at`.
- `auto-resume.074.pg.test.ts`:
  - a `no_material` pause lifts on the second tick once rows are imported; `resumed_by = 'code'`;
  - the note gets its line and is read, and the owner card has the outcome;
  - an owner pause and a kept pause stay;
  - a flap stays and gets its line once.
- These existing tests must stay green: `pause-actions.060.pg.test.ts`, `inbox-actions.078.pg.test.ts`, `schedule.pg.test.ts`, `empty-day.068.pg.test.ts`, `import-bundle.069.pg.test.ts` (text updated).

**Dashboard:**
- `lib/agent-overview.test.ts` (pauseEffect with a cause), `lib/inbox-kinds` tests, the `reasons` drift test, `no-cyrillic-ui.test.ts`, `tsc`, build.
- A visual check of the banner and the toasts on the mock API at port 3174.

**Acceptance replays** (`config-repair/replay.074.test.ts`, fakes, no LLM):
- **@ai0_prompts_dev, 10-27.**
  - The Prompt series switches to `library:nanobanana_prompts` (required, in order) after the plan. Today's two Prompt slots become `series:Prompt` plus the next row, format `photo`, and no replan runs.
  - The open `no_material` pause lifts on the second tick, with unposted > 0.
- **@pdr_dev_channel, 10-27.**
  - «Тест дня» (quiz, 12:00, locked) is added after the plan, and one `replan(today)` starts. A second change the same day starts a second one. A third sends `config_replan_capped`.
  - With its plain-slot pause open, the scheduler still plans the series.
- **No false work on @ai0_global.** Its fixture (073's `readiness/fixtures/ai0-global.json`) gives zero slot writes, zero pin drops, zero replans and zero resumes, both on a baseline and on an unchanged hash.

## Lead calls (answered — see Amendments)

1. **"Required series" in the replan trigger means owner-locked series.** Agent series wait for the next plan. Recommendation: yes. Locked series are the only ones the planner may not skip without a material cause (`plan-schedule-rules.ts:204-209`).
2. **The port is a module singleton, not a DI token.** That avoids new inject entries in three large factories (`editor.module.ts:1207`, :1949, :2429). Recommendation: yes.
3. **Auto-resume runs from the breaker tick, not from `afterRecheck`.** Recommendation: yes, because a cause clears without a config change.
4. **A plain slot whose format lost its weight is repaired to the top-weight format,** not skipped. Recommendation: repair, on the channel's own resource only.
5. **A pin of a switched-off series without its own format stops materialising.** Recommendation: yes; the doctor flags the pin.
6. **Over the cap, the note links to the plan page** rather than adding a fix kind to 072's runner. Recommendation: yes; the Replan button exists.
7. **A "changes applied" line in the Readiness panel** would need `applied_at` and `applied_summary` in 097. Recommendation: not now; take it as a follow-up if the owner asks.
8. **Cap numbers.** Recommendation: `CONFIG_REPLANS_PER_DAY` 2 and a ceiling of 6 planner runs a day: 3 scheduler tries, 2 config replans and 1 manual.
9. **`no_material` evidence uses `buildCatalog.unposted_here`** until 075's `postableCount` is merged. Recommendation: yes; the lead swaps the seam at W2 merge.

## Amendments after the builder check

The builder check (2026-10-29) was verified item by item against the code at 1ecb8160 and the W1 specs (072, 073, 076). The lead's «Decisions after the drafts» (contract, 2026-10-29) is binding. These rules override the body. **A<n> answers check item n**; A30 is a gap found while checking.

### Lead decisions

**L1. Lead calls 1–9 are accepted.** Build them as written:
- "Required series" in FR-004 means an owner-locked series (`locked: true`). Agent series wait for the next plan.
- `configRepairPort` is a module singleton, not a DI token.
- Auto-resume runs from the breaker tick, never from `afterRecheck`.
- A plain slot on the channel's own resource whose format lost its weight takes the card's top-weight format.
- A pin of a switched-off series without its own format stops materialising; 072's doctor flags the pin.
- Over the cap, the note offers the existing Replan step (A24). 074 adds no fix kind to 072's runner and nothing to `AUTO_SAFE_FIX_KINDS`.
- No `applied_at` / `applied_summary`. 074 adds no column and no migration.
- `CONFIG_REPLANS_PER_DAY` = 2; `CONFIG_REPLAN_RUN_CEILING` = 6 planner runs per channel and local day.
- The `no_material` library evidence is the seam `unposted(ref, table)` until the W2 merge. The lead then swaps it for 075's `postableCount(pool, { key: table }, ref)` (075 takes an id or a key, which closes map contract issue 10).

**L2. The hook and the hash are 072's (map contract issues 1–4 closed).**
- Inject `READINESS_SERVICE` and register with `afterRecheck(fn)`. The payload is 072's exported `RecheckEvent = { channelKey, reason, prevHash, hash, appliedHash, facts, findings }`.
- Hooks run on every recheck and sweep, so a run that left `applied_hash` unwritten is retried by the next sweep.
- `applied_hash` is written only through 072's `ReadinessRepository.setAppliedHash(channelKey, hash)`. 074 never reads or writes `channel_readiness` with its own SQL.
- `series_pauses` is not part of the config hash, so a lift does not re-fire the hook.
- `reason` is one of `'sweep' | 'view' | 'owner' | 'start' | 'config_skip' | 'fix'`. A12 says which ones act.

**L3. The 073 names 074 uses (map contract issues 5, 6 and 9 closed).**
- `checkSlotConfig`, and `repairSlotConfig(slot, problems, ctx)`, which returns `{ format?, sourceHints?, note }`. Its `note` is the patch note of FR-002.
- The types `SlotConfigSlot`, `SlotConfigCtx` and `ConfigProblem` (with `series?` and `at?`).
- `ScheduleService.slotConfigContext(card, slot)` is the only loader of `SlotConfigCtx`. It has no side effects.
- `EditorPlansRepository.patchSlotConfig` is for a claimed slot at run time. 074 never calls it; it writes planned slots only through `ConfigRepairRepository.patchPlanned`.
- `plannerRunsOn(pool, channelKey, tz, day)` is the ceiling's count in FR-004. There is no 074 query on `editor_runs`.
- `CONFIG_FAILURE_CODES` and `isConfigCode` are the single list of config codes (A28).
- `preflight_no_material` is material, not config. FR-002 rule 4 leaves it to the runtime pre-flight and the breaker.
- `reasonOfError(text)` parses a stored slot error to its code. The dashboard reads every label of a 074 code from the mirror `apps/dashboard/src/lib/reasons.ts` (code, en, fix.en, link) and its drift test.
- **Skeleton exclusions.** `uncoveredInstances` drops an instance for which `checkPlanSkeleton(card, playbook, series, resources)` returns `series_format_unavailable` or `series_in_quiet_hours` with the same `series` and `at`. Test: such an instance never starts a replan.
- 073's launch `setMode` passes `{ replan: false }`. 074 keeps that (A12).
- Edit order in `schedule.service.ts`: 073, then 074 and 075, then 077. 074 touches only the `materialiseAgent` body.

**L4. The 076 names (map contract issue 8 closed).**
- `sourceProberOf(pool)` is the prober, bound to the probe cache and `PgHostFailures`.
- Its options include `maxAgeMs` (contract: `{ store?, hosts?, force?, maxAgeMs?, cacheOnly? }`). If the merged bound prober's option type lacks `maxAgeMs`, widen that `Pick` in `sources/probe.ts` (one line, noted in Deltas).
- A result with `failure_class: 'invalid'` is never cached and never counted. For 074 it means "not judged" for that URL.
- `source_unreachable` stays the skip class and pause cause. The doctor code `source_probe_failed` is 076's; 074 does not read it.

**L5. Names 074 owns** (contract «074 adds»):
- The codes `config_series_gone`, `config_series_changed` and `config_replan_capped`. `CONFIG_REPAIR_CODES` lists all three.
  - 073's `checkSlotConfig` also emits `config_series_gone` and 073 FR-010 already puts it in the catalogue and `NOT_A_MISS`.
  - 074 adds a catalogue entry, a `NOT_A_MISS` pattern or a mirror line only where the merged tree lacks one.
- The settings `CONFIG_REPLANS_PER_DAY` and `SERIES_AUTO_RESUME` (A23).
- `resumed_by = 'code'`, the singleton `configRepairPort`, and the Inbox kind `config_replan_capped`.

**L6. Where pauses show (map contract issue 11 closed).** At HEAD the pauses are `PauseBanners` on every agent tab (`routes/app.agents_.$handle.tsx:94`). 072's Readiness panel replaced only ConflictsLine on the Overview; it shows pauses as info rows that link to the banner. `pauseEffect` and the Resume toast stay in `PauseBanners.tsx`.

**L7. Binding rules, restated for 074.**
- No code path changes a channel's mode.
- No event bus and no DB trigger. The triggers are the 10-minute readiness sweep, owner rechecks, Resume, change_source and the breaker tick.
- A change is a hash, never `updated_at`.
- Owner pauses (cause `owner`) and kept pauses are never lifted by code.
- Tests use fakes. Nothing starts the service, publishes or calls a model.

**L8. Numbers.** No migration. Runbook § 34. Mock port 3174. Linear AI0-252. Built in W2 next to 075, on W1 merged in the order 073 → 072 → 076.

### Builder check

**A1. Which URLs a source has (item 1, accepted).**
- `seriesLiveSources` (`live/live-slot.ts:61-66`) returns `feed:<ref>` / `api:<name>` strings, not URLs.
- New pure `sourceUrlsOf(src: SeriesSource | null, card: Pick<EditorCard, 'sources'>): string[]` in `config-repair/source-urls.ts`:
  - a `feed` whose `ref` is an http(s) URL gives `[ref]` (a playbook feed, `sources/playbook-feeds.ts:24`);
  - a `feed` whose `ref` is a card source id gives the `ref` of the card source with that `id` and kind `rss` or `url` (`CardSource.ref` is the URL, `card.ts:31-36`); an unknown id gives `[]`;
  - `api`, `library`, `network_highlights`, free and null give `[]`.
- **The source of a key.**
  - `series:<name>`: the active playbook series, matched by name and resource as `seriesForSlot` does (`schedule/schedule.service.ts:291-306`).
  - `rule:<id>`: `ScheduleRepository.get(id)` (`schedule/schedule.repository.ts:51`), then `rule.source`, else the source of the series `rule.seriesName` names.
  - A `rule:` pause whose rule is gone or `active: false` lifts at once, like a removed series. Its Ukrainian reason is «закріплений слот прибрано».
- `[]` means not judged. Such a pause lifts only when its series or rule is removed or its source changed.
- Test `source-urls.074.test.ts`: each source kind, a card id, an unknown id, a raw URL.

**A2. When `source_unreachable` is clear (item 2, accepted as the contract rule).**
- The contract rule stays: `blocked_until` has passed and `source_host_failures.last_success_at` is newer than the pause. 074 evaluates it through the probe and adds no HostFailures reader.
- For every URL of `sourceUrlsOf`:
  - `r = await prober(url, { maxAgeMs: Math.min(PROBE_CACHE_HOURS * 3_600_000, now - pausedAt) })`;
  - the URL is clear when `r.ok`, `Date.parse(r.checked_at) > pausedAt`, and `PgHostFailures.blocked(hostOf(url), r.kind === 'rss' ? 'feed' : 'page')` (`net/host-failures.ts:194`) is null.
- **Why this is the same rule.**
  - An ok live probe calls `hosts.succeeded`. After 076 FR-002 that sets `last_success_at = now()` and ends a timeout or unreachable block.
  - A cached ok row checked after the pause came from such a read.
  - `blocked()` null means `blocked_until` has passed.
  - `maxAgeMs` makes a row cached before the pause stale. That costs at most one extra live request per URL per pause; an active block answers without a request.
- The item's premise is partly wrong. 076 FR-004 force-probes, every 6 h, the blocked or struck hosts of open `source_unreachable` pauses, so their results reach the cache without 074.
- The pause is clear only when every URL is clear. No URL, or an `invalid` result, means not judged.

**A3. When `no_material` on a feed is clear (item 3, accepted except the 30-minute probe).**
- Take the prober's result for each URL of `sourceUrlsOf`, with the default 6 h cache and no `maxAgeMs`.
- A result is judged only when `r.ok` and its items came from a feed (`r.kind === 'rss'`, or `r.feed_url` is set).
- It is clear when all of these hold:
  - `newest_at > pausedAt`;
  - `now - newest_at` is at most `LIVE_DEFAULT_MAX_AGE_HOURS` (6 h, `live/live-slot.ts:16`; series carry no max age, and pins use the default, `schedule.service.ts:279`);
  - `newest_at <= now + 1 h`.
- A page result without a feed is not judged: its `newest_at` is the page's `published_at`.
- **Rejected part:** `maxAgeMs: 30 min`. It would make a live request every 30 minutes per paused feed, against 076's one live request per URL per 6 h. A stale cached row fails the 6 h age test until the next live read, which is the intended wait.
- Tests: an item 7 h old (after the pause) is not clear; one 5 h old is clear; a page's date is not used; a date 2 h in the future is not clear.

**A4. A started replan with tomorrow pending leaves the hash open (item 4, accepted).**
- Today's outcome is `started`, and tomorrow qualifies: approve mode, a non-placeholder tomorrow plan created before `changeAt`, an uncovered tomorrow instance, and cap left for tomorrow's date. Then `run` returns `started` and does not write `applied_hash`, as for `busy`.
- The next sweep repeats the run. Today's repair writes nothing and today is covered; tomorrow is replanned against its own date's cap; then the hash is written.
- The FR-004 outcome table gains a row: `started` with tomorrow pending → hash not written → the next sweep replans tomorrow.
- T3 test: two sweeps give one replan per date, and the hash is written after the second.

**A5. A busy replan is retried for every trigger (item 5, accepted).**
- `ConfigRepairService` keeps `pending: Map<channelKey, { trigger, since, resumedKeys, tries }>`. A `busy` outcome of any trigger sets or refreshes the entry.
- The port's tick (A17) calls `retryPending(now)`. Each entry runs `run(channelKey, trigger, { since, resumedKeys })` again, at most 3 tries; then it is dropped with a log line. Any outcome other than `busy` clears it.
- `AutoResume` lifts every due pause of a channel first, then calls `run(channelKey, 'auto_resume', { since: now, resumedKeys })` once per channel.
- Test: busy, then the retry on the next tick starts the replan; a third retry that is still busy drops the entry.

**A6. The flap guard covers 14 days (item 6, accepted).**
- `SERIES_SKIP_STREAK` defaults to 3 (`series-pause/series-breaker.ts:8`), and only skips after the last resume count (`lastResumes`, `series-pauses.repository.ts:88-93`). A daily series therefore re-pauses about three days after a code resume, and a 24 h guard never fires.
- New `SeriesPausesRepository.codeResumedSince(channelKey, key, since): Promise<boolean>`: a row of the same channel (case-insensitive) and key with `resumed_by = 'code'` and `resumed_at >= since`. `FLAP_WINDOW_DAYS = 14`.
- A pause whose key was resumed by code in the last 14 days is held for the owner.
  - Its note gets this line once (checked on the note body): "Resumed automatically on <YYYY-MM-DD HH:MM> UTC and paused again; it now waits for you."
  - The line leaves the note unread (A16), because it asks the owner to act.
- PG test: a code resume, a new pause three days later stays, and the line is written once over two ticks.

**A7. An owner's move is kept (item 7, accepted).**
- `ScheduleRepository.moveSlot` (`schedule/schedule.repository.ts:162-168`, called by `applySlotChange`, `schedule.service.ts:710-715`) also appends `owner_moved: <from> -> <to>` to `lint_warnings`. Times are ISO minutes in UTC. The append is the one `retopicSlot` uses (`repo/editor-plans.repository.ts:727-732`).
- `planSlotRepair` rule 3 keeps a slot with a `lintWarnings` entry that starts `owner_moved:`. Rule 1 (series gone) and rule 4 (patches) still apply to it.
- Tests: `schedule.pg.test.ts` (the marker) and `repair-plan.074` (a moved slot is kept).

**A8. Rule 3 applies on the channel's own resource only (item 8, accepted).**
- `planContext(…, 'single')` (`schedule.service.ts:168-198`) has a clock for the anchor only, so `dueInstances` (`plan-schedule-rules.ts:91-103`) gives no instance on another resource.
- Rule 3 applies only when both the slot's resource (`resourceRef ?? telegram:<channel>`) and `series.resource_ref` are `telegram:<channel>`. A series slot on another resource keeps its time; rules 1, 2 and 4 still apply to it.
- Fixture: a network series on another platform is not touched by rule 3.

**A9. A baseline never skips for a moved series (item 9, accepted).**
- On a baseline (`appliedHash` null, or reason `start`, A12), rules 1, 2, 4 and 5 apply and rule 3 keeps the slot. Rule 3 needs a replan to make the new slot, and a baseline never replans.
- T2 test: a baseline with a moved series keeps the slot and writes the hash.

**A10. A slot that already ran is not repaired (item 10, accepted).**
- `repairable` requires `attempts === 0 && !retryAt` (`attempts`, `repo/editor-plans.repository.ts:27`; `retryAt`, :151). `plannedForRepair` adds `attempts = 0 AND retry_at IS NULL`.
- The approval write-ahead claims slots up to 36 h ahead (`WRITE_AHEAD_WINDOW_MS`, `editor.scheduler.ts:92`), so a future planned slot can carry a retry.
- `REPLACEABLE` is not changed.
- Unit and PG tests.

**A11. The hook reads the hash from the event (item 11, accepted).**
- `onRecheck(e: RecheckEvent)` compares `e.hash` with `e.appliedHash`. It does not read `channel_readiness`.
- FR-001 step 5 becomes `ReadinessRepository.setAppliedHash(channelKey, hash)` (072). The provider uses 072's instance, or `new ReadinessRepository(pool)` if 072 does not expose one.
- `ConfigRepairRepository` has no `appliedHash` and no `setAppliedHash`. The fakes follow.
- Verify the exact names after the W1 merge and note any difference in Deltas.

**A12. Views never act; Start never replans (item 12, accepted).**
- `onRecheck` returns at once for `reason === 'view'`. That is the dashboard's GET, and a view recheck never applies anything (contract, 072 Q1–Q9).
- It returns when `e.hash === e.appliedHash`.
- `baseline` is `e.appliedHash == null || e.reason === 'start'`. Start thereby keeps 073's `{ replan: false }`.
- Otherwise it starts `run(e.channelKey, 'config', { hash: e.hash, baseline })` and does not await it. Reasons `sweep`, `owner`, `fix` and `config_skip` act this way.
- Tests: a `view` event with a different hash starts nothing; a `start` event repairs and never replans.

**A13. Every Resume runs the repair (item 13, accepted).**
- T5 starts with `grep -rn "new SeriesPauseActions" apps/automation/src` on the merged tree. At HEAD there are three sites (`editor.module.ts:1207`, :1949, :2429). 072's fix port `resumeSeriesPause` (072 FR-004) may add more.
- New `pauseActionsOf(pool, profiles?)` in `config-repair/pause-actions-of.ts` builds `SeriesPauseActions` with `afterResume: (p) => configRepairPort.run(p.channelKey, 'resume', { since: new Date(), resumedKeys: [p.key] })`. Every site uses it, 072's fix port included.
- Test `config-repair/pause-actions-of.074.test.ts` reads the non-test `.ts` files under `apps/automation/src/editor` and finds no `new SeriesPauseActions(` outside `pause-actions-of.ts`.

**A14. One answer to "does this pause lift by itself" (item 14, accepted in the smaller form).**
- New pure `autoResumeEligible(p, x: { settingOn, source, urls, kept, flapHeld })` in `config-repair/cause-cleared.ts`. It is true when all of these hold:
  - the setting is on;
  - the cause is `no_material` or `source_unreachable`, and the key starts `series:` or `rule:`;
  - the pause is not kept (A16) and not flap-held (A6);
  - the source is judged: `no_material` on a `library` source or on a feed with URLs, or `source_unreachable` with URLs.
- The port exposes `configRepairPort.autoResumable(channelKey, pauses): Promise<Set<string>>` (pause ids; an empty set before `bind`). It is read by 072's facts, the dashboard pause row and the breaker note (A19).
- **072's `pause_cause_gone`.**
  - The pauses in `ChannelFacts` gain `autoResume?: boolean`, filled read-only in `readiness/facts.ts` from the port.
  - `readiness/checks/pauses.ts` does not raise `pause_cause_gone` for a pause with `autoResume: true`; the pause stays the info finding `series_paused`.
  - With the setting off, or for a pause auto-resume holds (flap, kept, not judged), 072's check is unchanged.
- Test `readiness/checks/pauses.074.test.ts`: eligible → no `pause_cause_gone`; flap-held or kept → `pause_cause_gone` as before.

**A15. The capped note is posted once and carries a Replan step (item 15, accepted).**
```ts
await inbox.postOnce({
  agentId: orchId, kind: 'config_replan_capped', severity: 'action',
  ...dailyRef(`telegram:${channelKey}`, date),          // agents/owner-inbox.ts:43-45
  title: `Series "${name}" on ${channelKey} has no slot today`,
  body,                                                 // FR-004's English body (A21 has the plain-slot variant)
  alert: { title: `Серія «${name}» на ${channelKey} сьогодні без слота`, body: alertUk },
  gate: { subject: `config_replan:${channelKey}`, parts: [`day:${date}`] },
});
```
- `dailyRef` gives `refType: 'resource_day'` and `refId: 'telegram:<channel>|<date>'`. Migration 076's unique index `agent_inbox (kind, ref_id) WHERE ref_type = 'resource_day'` makes the note one per channel and day, across restarts too. The in-memory cap does not survive a restart, but this dedupe and the durable ceiling do.
- `parts` is an array (`NoteGate`, `agents/note-gate.ts:14-16`).
- The dashboard's `replanChannel` (`lib/inbox-ref.ts:177-181`) reads the channel from a `resource_day` ref (`resourceRefOf`, :140-142), so its parser needs no change.
- Test: two capped runs on one day → one note.

**A16. The kept trace is matched by its prefix (item 16, accepted).**
- The trace at `series-pause/pause-actions.ts:72` carries the label, channel and place, so there is no `KEPT_TRACE` constant. `pause-actions.ts` exports instead:
  - `KEPT_PREFIX = 'kept '`;
  - `keptLine(p, via)`, today's text `kept "<label>" on <channel> paused (Telegram card|dashboard)`, which `keep()` uses;
  - `isKept(body)`, true when the body has a line `Owner action: kept `.
- `logOnPauseNotes(pool, pauseId, text, o?: { read?: boolean })` is extracted from `log()` (:46-55); `read` defaults to true.
  - `log()` passes `Owner action: <line> (<when> UTC)`.
  - The lift passes its own line (FR-005).
  - The flap line (A6) passes `read: false`.
- AutoResume reads the pause's notes (`kind = 'series_paused' AND ref_type = 'series_pause' AND ref_id = <pause id>`) and holds the pause when any body `isKept`.
- T4's enumerating test covers every cause plus a kept line.

**A17. The tick never holds the scheduler (item 17, accepted).**
- `ConfigRepairPort.tick(now)` is synchronous. It returns at once when unbound, within 10 minutes of the last start, or while a tick is in flight. Otherwise it sets the flag and starts `void this.runTick(now).catch(log).finally(clear)`.
- `runTick` runs `AutoResume.tick(now)` and then `retryPending(now)` (A5).
- The breaker hook (`editor.module.ts:1783`) becomes `check: async (now) => { await breaker.check(now); configRepairPort.tick(now); }`.
- Port test: `tick` returns before a never-resolving probe, and a second tick during it does nothing.

**A18. The library evidence keeps the contract seam (item 18, rejected).**
- The contract fixes the seam `unposted(ref, table)` until the W2 merge.
- The lambda at `editor.module.ts:1201` (`buildCatalog`) rolls a round only on a cycle dataset whose round is finished: none left here and postable rows exist, under the DB lock (`data/data-catalog.ts:186-196`). That is spec 071's lazy roll, which every reader does.
- Without the roll, a paused series on a finished cycle dataset would read zero forever and never lift: its slots are skipped, so nothing else reads the dataset.
- Wire `ev.unposted` to the same lambda. Test: a tick on a cycle dataset whose round is not finished writes nothing (no roll, no change to `data_reuse_rounds`).

**A19. The texts say only what the code does (item 19, accepted).**
- **Server.** `pauseView` (`agents/agents.service.ts:80-86`) gains `autoResume: boolean`. `seriesPauses(handle)` (:388-397) fills it from `configRepairPort.autoResumable(key, open)`. The dashboard `SeriesPause` (`api/agents.ts:324`) gains `autoResume?: boolean`; absent means false.
- **`pauseEffect(key, cause?, autoResume?)`** (`lib/agent-overview.ts:43-47`), called at `PauseBanners.tsx:74` with `p.cause` and `p.autoResume`. This table replaces FR-008's:

  | Pause | Text |
  |---|---|
  | series, `autoResume` | "The planner skips it and its planned slots are skipped at no cost. It resumes by itself once its source has material again on two checks in a row; Resume does it now." |
  | series, cause `owner` | "The planner skips it until you resume it." |
  | series, otherwise | "The planner skips it, and its planned slots are skipped at no cost, until you resume it." |
  | rule, `autoResume` | "This fixed slot is skipped until its source has material again on two checks in a row, or until you resume it." |
  | rule, otherwise | "This fixed slot is skipped until you resume it." |
  | resource | "Plain slots are not planned here until you resume it. Series and fixed slots still are." |

- **The Resume toast** (`PauseBanners.tsx:60-65`) comes from a new pure `resumeToast(key)` in `lib/agent-overview.ts`. The existing `nextPlanLine` follows it when the schedule is known.
  - series: "Resumed. A locked series due later today gets its slot back by an automatic replan, within the daily limit."
  - rule: "Resumed. Its fixed slots for today and tomorrow are back on the plan." (A30)
  - resource: "Resumed. If today's plan has no plain slots left, it is redone automatically, within the daily limit." (A21)
- **The series save toast** (`AgentSchedule.tsx:526`) gains "Planned slots follow it within 10 minutes." That is the sweep interval.
- **The breaker note.** `pausedNote(p, o?: { autoResume?: boolean })` (`series-breaker.ts:27-45`):
  - with `autoResume`, the last line is "It resumes by itself once its library or feed source has material again on two checks in a row. To resume it now, press Resume on this note, on the agent page banner or on the Telegram card." The Ukrainian alert gains «Відновиться сама, щойно в джерела знову буде матеріал.»;
  - without it, the last line is "Resume it on this note, on the agent page banner or on the Telegram card.";
  - `SeriesBreakerDeps` (:47) gains the optional `autoResumes?: (p: SeriesPause) => Promise<boolean>`, wired to the port. Absent means false.
- **The `series_paused` why** (`lib/inbox-kinds.ts:196-202`): "A paused series is no longer planned, so readers stop getting it. A library or feed source is checked by itself and the series resumes once it has material again; Resume does it now."

**A20. "A paused channel plans nothing" is no longer true (item 20, accepted).** Each text keeps its language.
- **LLM-facing texts.** In `agents/agent-prompts.ts:43` (`SOURCE_CHANGE_ROUTE`), `docs/import-list-tools.ts:20` (`IMPORT_ROUTING`) and `apps/automation/editor-skills/editor-composer-workflow.md:19` (step 9), the clause «канал на паузі не планується зовсім, …» becomes «на паузі каналу не плануються лише його звичайні слоти; серії й закріплені пости плануються далі, тож пункт відновлення каналу повертає саме звичайні слоти». The instruction to tell the owner to tick the item stays.
- **The import bundle.** `docs/import-bundle.ts:221` becomes `'suggest resuming the channel (unticked: plain slots of the channel are not planned until it is ticked; its series still are)'`. In :163, «канал на паузі не планується» becomes «звичайні слоти каналу на паузі не плануються». The comment at :182 follows.
- **The runbook** :859, :898, :984 and :988 (T8): plain slots of a paused channel are not planned; its series and pins are.
- **Tests that assert the old text:** `docs/import-list-tools.069.test.ts:252`, :254, :256, :375 and :552, and `docs/import-bundle.069.pg.test.ts` where it asserts the item summary.

**A21. Resuming plain slots replans today (item 21, accepted, the first option).**
- FR-004 gains a second reason to replan today. All of these must hold:
  - the run carries a resumed `resource:telegram:<channel>` key (trigger `resume`);
  - it is not a baseline;
  - today's active non-placeholder plan was created before the resume;
  - that plan has no `planned` plain slot (no series, no rule) of the channel's own resource after now + 30 min.
- The cap, the ceiling and the capped note are the same.
  - The capped note's English title is `Plain slots of <channel> have no slot left today`, and its body is "Plain slots were resumed after today's plan, and today's automatic replans are used up (2 of 2). Replan the rest of today on the channel page, or wait for tomorrow's plan."
  - Ukrainian alert: «Звичайні слоти <channel> відновлено після плану, а автоматичні переплани на сьогодні вичерпано (2 з 2). Переплануй решту дня на сторінці каналу або дочекайся завтрашнього плану.»
- Tests: a resource resume with no plain slot left starts one replan; with plain slots left, none starts.

**A22. The plain-pause gate is cached (item 22, accepted).**
- `config-repair/series-due.ts` exports a `SeriesDueGate` class:
  - `due(card, date, now)` caches both answers per `<channelKey>|<date>` for 10 minutes;
  - `drop(channelKey)` clears a channel's entries.
- `ConfigRepairService.run` calls `drop(channelKey)` when it starts, through the gate instance the port holds.
- Test with a counting fake: ten ticks within 10 minutes make one `planContext` call; a `run` in between makes a second.

**A23. The settings entries (item 23, accepted).** Both go after `SERIES_SKIP_STREAK` (`settings/catalog.ts:129`):
```ts
{ key: 'SERIES_AUTO_RESUME', group: 'editor', label: 'Auto-resume paused series', help: 'A series or fixed slot paused for no material or an unreadable source resumes by itself after two clear checks at least 5 minutes apart: its library has unposted rows again, its feed has a fresh item, its site answers again, or it got another source. Pauses you made or kept, plain-slot pauses and api sources wait for you, and so does a series that paused again within 14 days of an automatic resume. Off = only you resume.', type: 'bool', bool: OFF, default: 'on', apply: 'live' },
{ key: 'CONFIG_REPLANS_PER_DAY', group: 'editor', label: 'Automatic replans per day', help: 'When a change leaves a series you locked, or resumed plain slots, without a slot later today, the rest of the day is replanned by itself, at most this many times per channel and day. Over the limit you get one note with a Replan button. 0 = never.', type: 'int', default: '2', apply: 'live', min: 0, max: 6 },
```
- `bool: OFF` means the values are `'on'`/`'off'` (`settings/catalog.ts:52-53`).
- Read at each use: `(cfg.get<string>('SERIES_AUTO_RESUME') ?? 'on') !== 'off'`, and `Math.max(0, Math.round(envNum((k) => cfg.get<string>(k) ?? undefined, 'CONFIG_REPLANS_PER_DAY', 2)))` as at `editor.module.ts:1770`.
- The `SERIES_SKIP_STREAK` help (:129) changes "and you get one note with a Resume button" to "and you get one note with a Resume button; a series or fixed slot on a library or feed source resumes by itself once the source has material again (Auto-resume paused series)".
- `settings/catalog.test.ts` must pass.

**A24. The Inbox kind uses the existing Replan step (item 24, accepted).**
- In `lib/inbox-kinds.ts`, the `replan` NoteStep (:49) already gives one tap; `event_not_covered` (:318) and `missedSteps` (:431) use it:
```ts
config_replan_capped: {
  why: 'The setup changed after today\'s plan and today\'s automatic replans are used up, so something due today has no slot.',
  steps: (c) => {
    const ch = replanChannel(c.it, c.tree);
    return ch
      ? [{ type: 'replan', label: 'Replan the rest of today', channel: ch, date: 'today' } as NoteStep, read('Got it')]
      : [read(), agentLink(c, 'Open agent')];
  },
},
```
- `INBOX_KINDS` is `Object.keys(RULES)` (:414), so `lib/inbox-kinds.test.ts` needs the kind in `BRIEF_KINDS` (:86) and in `FIXTURES` (:34): `{ refType: 'resource_day', refId: 'telegram:@pdr_dev_channel|2026-10-29#ab12cd34', severity: 'action', title: 'Series "Quiz of the day" on @pdr_dev_channel has no slot today' }`.
- Add a case with no channel, which ends in "Got it". T7's 375 px check covers the note.

**A25. Runbook § 34 stays (item 25, rejected).** The contract's Numbers table fixes § 34, and the wave's working rules take the § number from the contract. After W1 the runbook has § 32 (072), § 33 (073) and § 36 (076). § 34 goes after § 33 and before § 36; 075 adds § 35 in parallel. Every cross-reference says § 34.

**A26. The builder runs its own mock on port 3174 (item 26, accepted).**
- Copy the lead's mock `/private/tmp/claude-501/-Users-tupotavalentyn-CS-20-ai0-ai0-global/2132be12-8cfd-462d-b944-db7830138061/scratchpad/rdmock/server.mjs` into your own scratchpad. Never edit the lead's copy.
  - It is dependency-free and serves a dashboard `dist` plus the API, including `GET`/`POST /api/agents/:handle/series-pauses` (:1679-1680).
- In your copy, add four open pauses to the pauses fixture: `no_material` with `autoResume: true`, `source_unreachable` with `autoResume: false`, cause `owner`, and a `resource:telegram:<channel>` key. Add one `config_replan_capped` Inbox note.
- Build the dashboard and run `node server.mjs <your dist> 3174 --midday --quiet` on Node 20.
- Check the banners, the three toasts and the Inbox note at 375 px and on desktop. Never use 3178, 5173 or 5174.

**A27. Fixtures follow the contract (item 27, accepted).**
- No file named `readiness/fixtures/ai0-global.json` exists.
- **The hard gate** for "no false work on @ai0_global" is synthetic. Build it from 072's `readiness/fixtures/onboarding-1027.ts` @ai0_global facts: the card, the active playbook, no open pause. Run it once with `appliedHash === hash` and once as a baseline.
- **A second test** replays the lead's `readiness/fixtures/stage-<channel>.json` for @ai0_global (find it with `ls apps/automation/src/editor/readiness/fixtures/stage-*.json`). Its shape is raw API responses: `{ channel_key, captured_at, channel, schedule, skills, rules, series_pauses, datasets }`. Use `test.skip('stage fixture absent')` when the file is missing.

**A28. The repair's skip code is classed as config (item 28, accepted in part).**
- `config_series_changed` joins 073's `CONFIG_FAILURE_CODES`, so `isConfigCode` knows it. It also joins both `NOT_A_MISS` lists.
- `config_replan_capped` is never a slot error, so it lives only in the catalogue and the Inbox. `config_series_gone` is 073's (L5).
- After the merge, verify:
  - `skipGroupOf('config_series_changed: …')` returns `'config'` (073's `config_\w+` rule, `silent/skip-reasons.ts:49` at HEAD);
  - `reasonOfError` returns `config_series_changed`;
  - `classifyClose` returns `ignore` (`series-pause/skip-cause.ts:74-102`).
- Tests: extend the skip-reasons and `reasonOfError` tests. New `series-pause/streak.074.test.ts`: no_material, config_series_changed, no_material, no_material pauses at 3, because the config skip neither counts nor ends the run.

**A29. What the provider builds (item 29, accepted).**
- The `CONFIG_REPAIR` factory builds these itself, since none is a provider token:
  - `new OwnerCardsRepository(pool)` (pool only, `owner-bot/owner-cards.repository.ts:57`);
  - `new PgHostFailures(pool)` (`net/host-failures.ts:191`);
  - `sourceProberOf(pool)`;
  - `new SeriesPausesRepository(pool)`;
  - 072's `ReadinessRepository` (A11).
- It injects `DB_POOL`, `ConfigService`, `EDITOR_REPOS`, `EDITOR_OPS`, `SCHEDULE_INFRA`, `AGENT_INFRA` and `READINESS_SERVICE`.
- It is listed in `EDITOR_PROVIDERS` (`editor.module.ts:969`). `editor.module.test.ts`, which boots every provider, asserts that the port is bound and that the hook is registered once.

**A30. Resumed pin slots come back (found while checking).**
- **The gap.**
  - The breaker skips every planned slot of an open pause, pins included (`series-pauses.repository.ts:95-104`).
  - A pin is materialised once per (rule, date) with `ON CONFLICT DO NOTHING` (`schedule.repository.ts:95-124`).
  - So after a Resume, today's and tomorrow's pin slots stay skipped, and the rule texts of A19 would be false.
- **The fix.** New `SeriesPausesRepository.restorePausedPins(p: { channelKey, key }, after, until): Promise<number>`. It sets `status = 'planned'` and `error = NULL` on the slots that match all of these:
  - `kind = 'content'`, `status = 'skipped'`, `error LIKE 'series_paused:%'`;
  - `schedule_rule_id IS NOT NULL` and `attempts = 0`;
  - `scheduled_at` within `(after, until)`;
  - the slot's plan is active;
  - the pause's `slotMatch(key)` holds (:30-37). Only `series:` and `rule:` keys qualify.
- `run` calls it first for each of `o.resumedKeys` (A5, A13), with `after = now + REPAIR_LEAD_MS` and `until` = the end of tomorrow in the card zone. FR-003 then compares the restored slots with `pinSlotSpec`.
- Plain and series slots are not restored; FR-004 and A21 cover them.
- PG test: a `rule:` pause skips today's pin; Resume brings it back to `planned`; a pin slot in a superseded plan stays skipped.

### Open for the lead

Nothing blocks the build. Two confirmations, each with the call taken:
1. **A2** evaluates the contract's `source_unreachable` rule through 076's probe, not by reading `last_success_at`. Recommendation: keep it. It is the same test and needs no new reader.
2. **A30** restores pin slots that a pause skipped, which goes beyond the check list. Recommendation: keep it. Without it, a resumed pin returns only on the day after tomorrow.

## Lead decisions after the integration review (2026-10-29)

These override everything above, including the Amendments. They come from a cross-spec review of all six specs (the item numbers I1… are that review's).

- **I2:** `no_material` is clean when 075's `materialAvailable` predicate holds (`unposted > 0 || (reuse is cycle && postable > 0)`). Until the W2 merge, use the seam; the lead connects 075's predicate. Drop the requirement for `buildCatalog`'s roll.
- **I15:** read probes through `sourceProberOf(pool)` with `cacheOnly: true` (the latest `source_probes` row) and never force one. `source_unreachable` is clean when the latest probe of every source URL is ok, was checked after `pausedAt`, and the host is not blocked.
- **I9:** auto-resume and flap lines go into the existing `series_paused` thread (edit or follow-up of that note), never a separate note.
- **I19:** count both `CONFIG_REPLANS_PER_DAY` and the 6-run ceiling by plan date in the card's timezone, using `plannerRunsOn(…).n`.
- **I10:** 074 merges before 075 in W2. Append to shared arrays (`CONFIG_FAILURE_CODES`, `NOT_A_MISS`, the catalogue) only at the end, and add every catalogue entry to the backend catalogue and `lib/reasons.ts` in the same commit.
- `config_series_gone` is 073's code; 074 adds only `config_series_changed` and `config_replan_capped`.
- A30 (restore pin slots a pause skipped) is kept.
