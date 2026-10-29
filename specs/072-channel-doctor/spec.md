# 072 — Channel doctor and Readiness

Status: done · Builds on 055 (sysadmin audit: `Finding`, closed-list fixes), 047 (config conflicts), 052 (launch), 060/068 (series pauses), 069 (skill source/origin guards), 071 (rounds), 078 (dashboard) · Migration 097
Linear AI0-250 · Wave 7, W1: built in parallel with 073 and 076, merged 073 → 072 → 076. Runbook § 32. Mock port 3172.

> **Read the «Amendments after the builder check» section at the end first.** Where it differs from the body, the amendment wins.

## Why

The owner, 2026-10-27:

> «мені потрібно щоб коли я додаю новий канал то це було просто, швидко і зручно, щоб не доводилось 2 тижні дебажити його роботу»

Two young channels on stage took about 3.5 weeks each (review `docs/reviews/2026-10-27-channel-onboarding.md` §1):
- **@ai0_prompts_dev.** The Prompt series was bound to text-less PromptHero rows. The prompthero skill still said `provider=prompthero`, and the nanobanana skill said `origin=original` for library rows. 8 of 9 Prompt slots skipped on 10-22…10-26. Every layer was found by a 4–6 day export-and-review cycle.
- **@pdr_dev_channel.** All 866 `pdr_questions` rows were used under reuse `never`. No series was bound to the dataset. The channel was dark about 10 days with no warning.

Every one of these was visible in the config on day 0, at $0. Nothing looked at the channel as a whole.

**Closes:** F02 (no readiness view), F06 (config errors found only in a paid run), F08 (dataset channel without a bound, required series), F11 (owner messages report symptoms, not "misconfigured because X, fix Y"), F28 (the card's tools allowlist hides read tools).
**Doctor side of:** F01 (skill/rule/steering contradicts a required source), F03 (format divergence in independent groups), F04 (unpostable rows), F05 (reuse `never`, runway), F10 (pause whose cause is gone), F13 (facts for 076's source check), F16 (hashtag and style conflicts), F21 (card vs playbook formats).

## Words

- **Finding.** One problem the doctor found: a code, a severity, English text, a subject, a dashboard link and maybe a fix.
- **Blocker / warning / info.** Severity `error` / `warn` / `info` of the sysadmin `Finding`. A blocker means slots will be skipped or will publish wrong.
- **One-tap fix.** A `Fix` from the closed list. The owner applies it with one button.
- **Auto-safe fix.** A fix code applies by itself. Only `tools_allow_add` and `hashtag_min_zero` (FR-004).
- **Facts.** Everything the checks read, loaded once per check by one read-only module.
- **Config hash.** A hash of the config parts of the facts only.
- **Sweep set.** Channels whose card is in `approve` or `live`, plus channels with an open launch (`ready` or `running`).

## What

### FR-001 Findings and reason codes

- Reuse the sysadmin `Finding` (`apps/automation/src/editor/sysadmin/audit.types.ts:33-45`). Extend it, do not fork it:
  - add `export const FINDING_AREAS = [...AUDIT_AREAS, 'channel'] as const` and `FindingArea`; `Finding.area` becomes `FindingArea`;
  - `AUDIT_AREAS` (`:7`) stays as is, so the weekly audit's model pass cannot emit `channel` findings (`auditor-input.ts:124`);
  - add optional `link?: string` (a resolved dashboard path) and `firstSeenAt?: string` (ISO).
- A doctor finding has `area: 'channel'`, `check` = its reason code, `key = findingKey('channel', code, subject)` (`sysadmin/audit-text.ts:36`).
- `apps/automation/src/editor/readiness/codes.ts` copies the contract's `ReasonEntry` type verbatim and exports `DOCTOR_REASONS: ReasonEntry[]` and `doctorReason(code)`. At merge the lead swaps the type for 073's import and appends the entries to `REASONS`.
- `link` templates use `:channel :agent :dataset :series`. `resolveLink(template, subject)` URL-encodes each value.

The codes 072 owns (`kind` `doctor` unless marked `dataset`):

| Code | Sev | When | One-tap fix | Link |
|---|---|---|---|---|
| `series_source_contradicted` | error (required series) / warn (suggested) | an enabled skill, an owner rule or a steering line sends the writer to another source (FR-003.1) | `skill_disable` for a skill; none for a rule or steering | `/app/agents/:agent?tab=skills` or `?tab=memory` |
| `origin_original_with_source` | error if the channel has a library or feed series, else warn | `originWithSource(body)` on an enabled skill | `skill_disable` | `?tab=skills` |
| `skill_prescribes_source` | warn | `sourceInSkill(body)` hit with no series it contradicts | none | `?tab=skills` |
| `dataset_without_series` | error when library sources are the card's only sources, else warn | a card `library` source with no active series of this resource on it | none (075 adds one in W2) | `/app/agents/:agent?tab=schedule` |
| `series_source_not_required` | warn | a series on a dataset with `source_mode` `suggested` | `series_source_require` | `?tab=schedule` |
| `dataset_post_requires_missing` (dataset) | warn | a bound dataset with no `post_requires` | none | `/app/data/:dataset` |
| `dataset_low_fill` (dataset) | error for a required series, else warn | the `body` role field fills < 50 % and `post_requires` does not name it | none | `/app/data/:dataset` |
| `material_exhausted` (dataset) | error | reuse `never`/`after_days`, 0 postable rows unused here; or `cycle` with 0 postable rows at all | none | `/app/data/:dataset` |
| `material_low` (dataset) | warn | runway < 14 days (`RUNWAY_ALERT_DAYS`) | none | `/app/data/:dataset` |
| `dataset_order_random` (dataset) | info | random order (or `never`) and the series name or brief asks for order (білет, ticket, розділ, chapter, по черзі, in order, урок, lesson) | none | `/app/data/:dataset` |
| `tools_missing_for_source` | error | a series or card source needs a read tool the run will not have (FR-003.3) | `tools_allow_add` when the card list is the cause | `/app/editor/:channel` or `?tab=loadout` |
| `hashtag_min_without_vocabulary` | error | `card.hashtagMin > 0` and `card.hashtags` empty | `hashtag_min_zero` | `/app/editor/:channel` |
| `config_conflict` | warn | any other `configConflicts` code (`rules/config-conflicts.ts:60-61`); `evidence.conflict` keeps the code | `conflicts_resolve` with `codes: [code]`, none for `poll_series_over_cap` | `?tab=memory` |
| `formats_diverge` | warn | independent group only: a card format with weight > 0 is missing or 0 in the resource's playbook section, or the reverse | none | `?tab=playbook` |
| `series_paused` | info | an open pause with cause `no_material` or `source_unreachable` | `series_resume` | `?tab=overview` |
| `series_paused_by_owner` | info | an open pause with cause `owner` | none | `?tab=overview` |
| `pause_cause_gone` | warn | a `no_material` pause whose dataset has postable unused rows again, or a `source_unreachable` pause whose host has no open block | `series_resume` | `?tab=overview` |
| `playbook_draft_waiting` | warn | a `pending_owner` playbook older than 24 h | none | `?tab=playbook` |
| `bot_not_admin` | error | the open launch's `bot_state.state` is `no_access` or `token_invalid` | none | the launch artifact |
| `auto_fixed` | info | code applied an auto-safe fix in the last 24 h | none | — |

Text examples (English, no Cyrillic; Ukrainian for the bot):
- `series_source_contradicted`: en "A skill, rule or steering line sends the writer to a different source than the series requires." uk «Скіл, правило чи настанова велить брати матеріал не з того джерела, яке вимагає серія.» fix en "Switch the skill off, or change the rule so it names the series source."
- `material_exhausted`: en "No unused rows are left for this channel." uk «Для цього каналу не лишилось невикористаних рядків.» fix en "Add rows, or set Reuse to repeat in rounds."

### FR-002 Facts and the config hash

`apps/automation/src/editor/readiness/facts.ts` exports `loadChannelFacts(pool, channelKey, o?: { now?: Date }): Promise<ChannelFacts>` and the pure `configHash(facts): string`. It is the only module that reads; checks never query.

It reads, for `telegram:<key>`:
- the card (`EditorChannelsRepository.get`, `repo/editor-channels.repository.ts:107`) and its mode;
- the orchestrator (`agents.findTop('orchestrator', 'resource', 'telegram:<key>')`, as `editor.module.ts:612-624`) and its role children (the chain);
- the profile (`resource_profiles.profile`: topic, language, `format_prefs`);
- the group and its mode (`NetworkRepository.groupOfChannel`, `network/network.repository.ts:487`; resources `:552`);
- the active and pending playbook (`:137`, `:142`), its series on this resource, and the owner pins (schedule rules) of the channel;
- the chain's skills with toggles (`SkillStore.listForAgent(chain)`, `agents/skill-store.ts:184`), enabled only;
- owner rules (memory rows of the channel created by the owner, as `rules/config-conflicts.service.ts:48-66`) and active steering (`steering/steering.repository.ts:53`);
- the bound datasets: card `library` sources and series `library` sources. Per dataset: key, entity, version, `roles`, `reuse_policy`, `post_requires`, `fill_rate` from `data_schema_stats`, active rows, not-postable rows, postable rows unused here. The count copies the `countRows` SQL of `buildCatalog` (`apps/automation/src/data/data-catalog.ts:177-187`, with `usedRefsCte`, `data/data-refs.ts:103`). It never calls `buildCatalog`: that rolls rounds (`:188-196`), a write. The count lives in one local function `countPostable(pool, schemaIds, resourceRef)` that 075 replaces with `postableCount`;
- series per day per dataset (`parseCadence`/`instancesPerDay`, as `editor/tools/catalog-context.ts:47-60`) and the 28-day ledger use (`ledgerUsage`, `:63-70`);
- open series pauses (`series_pauses`, migration 093) and host blocks of the hosts the card and series sources name (`source_host_failures`);
- effective executor tools: `intersectAllow(card.toolsAllow, executor loadout)` (`loadout/loadout.service.ts:18`, `:44-49`);
- the config-conflict input (`rules`, `playbook`, `resources`) built as `ConfigConflictsService.forAgent` does, so the check calls the pure `configConflicts`;
- the open launch (`channel_launches`, status `ready`/`running`) with `bot_state`;
- planned slots of today and tomorrow (for the 073 seam), and the last 24 h of closed slots: status, error, critic verdict.

`configHash` is sha256 over canonical JSON of: the card without mode, models, budgets and timestamps; profile topic, language and `format_prefs`; the active playbook version and body and the pending playbook id; pins; skills (id, version, enabled, inline); owner rules (id, text); steering (id, text); datasets (key, version, `reuse_policy`, `post_requires`); the executor loadout; the group mode. It never covers counts, pauses, host blocks, slots, launch state or `updated_at`.

### FR-003 The doctor

`readiness/doctor.ts`: `channelDoctor(facts: ChannelFacts): Finding[]` runs `DOCTOR_CHECKS` (`readiness/checks/index.ts`, `DoctorCheck = { code: string; run(f: ChannelFacts): Finding[] }`), drops repeated keys and sorts error → warn → info, then code. No I/O, no model call. Check files: `source.ts`, `series.ts`, `material.ts`, `tools.ts`, `config.ts`, `pauses.ts`, `launch.ts`.

1. **Source contradictions** (`checks/source.ts`, pure helper `seriesSourceContradictions(series, candidates)` in `readiness/source-contradiction.ts`). For each active series with a `library`, `feed` or `api` source, the candidates are enabled chain skills, owner rules and steering lines. A candidate contradicts when:
   - `skillConflicts(seriesBody, [candidate], { name: series.name, description: series.brief, keep: [sourceToken] })` returns a hard or soft conflict (`agents/skill-warnings.ts:243`), where `seriesBody` is «Бери матеріал лише з <label>.» with `seriesSourceLabel` (`network/series.ts:82`); or
   - `sourceInSkill(candidate.body)` (`:97`) names a source and none of its words is the series source token, and the candidate's name or description shares a topic word with the series.
   Built-in and safety skills are not candidates. A `sourceInSkill` hit that contradicts no series is `skill_prescribes_source`. `originWithSource` (`:311`) on an enabled skill is `origin_original_with_source`.
2. **Series and datasets** (`checks/series.ts`, `checks/material.ts`). Rules as in the FR-001 table. Runway uses `runwayDays(unused, seriesPerDay, used28)` (`catalog-context.ts:72`). A `cycle` dataset rolls its round, so its runway counts postable rows, not unused ones.
3. **Read tools** (`checks/tools.ts`). A `library` source needs `query_data`; a `feed` source or a card `rss` source needs `fetch_feed`; a card `url` source needs `web_fetch`; an `api` source needs `fetch_api`. Missing from the effective list → error. If `card.toolsAllow` is non-null and lacks the tool, the fix is `tools_allow_add`. If the loadout lacks it, there is no fix and the link is the loadout tab.
4. **Config** (`checks/config.ts`). `configConflicts(f.conflictInput)` maps each code to `config_conflict`, except `hashtag_min_without_vocabulary`, which is its own check. `formats_diverge` for independent groups. The 073 seam (FR-011).
5. **Pauses** (`checks/pauses.ts`) and **launch** (`checks/launch.ts`), as in the table.

### FR-004 One fix runner, more fixes

- Move `AuditService.runFix` and `describe` (`sysadmin/audit.service.ts:145-166`, `:48-55`) into `sysadmin/fix-runner.ts`: `runFix(ports: FixPorts, fix: Fix): Promise<string>`, `describeFix(fix, extra?)`, `fixLabel(fix)` (English button text). `AuditService` calls it; its behaviour does not change.
- `FixPorts extends AuditFixPorts` (`:20-28`). `applyConflicts(orch, codes?: string[])`. New optional ports: `addCardTools(channelKey, tools)` (`EditorOpsService.upsertChannel`, `api/editor-ops.service.ts:149`), `setHashtagMin(channelKey, 0)` (`editor-channels.repository.ts:157`), `resumeSeriesPause(pauseId)` (`SeriesPauseActions.resume(id, 'dashboard')`, `series-pause/pause-actions.ts:57-65`), `requireSeriesSource(channelKey, series)` (`ScheduleService.scopeByChannel` + `commitSeriesChange(sc, 'update', { name, source_mode: 'required' }, { source: 'dashboard' })`, `schedule/schedule.service.ts:107`, `:630`). A missing port throws `fix_unavailable`.
- `Fix` (`audit.types.ts:25-31`) gains:
  ```ts
  | { kind: 'conflicts_resolve';     agent: string; codes?: string[] }
  | { kind: 'tools_allow_add';       channel: string; tools: string[] }
  | { kind: 'hashtag_min_zero';      channel: string }
  | { kind: 'series_resume';         channel: string; pauseId: string }
  | { kind: 'series_source_require'; channel: string; series: string }
  ```
  `FIX_KINDS` lists all nine. `series_resume` refuses a pause with cause `owner` (`owner_pause`). `series_source_require` says in its label that the series becomes the owner's (locked).
- `readiness/auto-fix.ts`: `export const AUTO_SAFE_FIX_KINDS = ['tools_allow_add', 'hashtag_min_zero'] as const`. A test fails if the list changes or if code applies any other kind without an owner action.

### FR-005 Storage: migration 097

```sql
-- database/migrations/097_channel_readiness.sql
CREATE TABLE IF NOT EXISTS channel_readiness (
  channel_key       TEXT PRIMARY KEY,
  findings          JSONB NOT NULL DEFAULT '[]'::jsonb,
  blockers          INT   NOT NULL DEFAULT 0,
  warnings          INT   NOT NULL DEFAULT 0,
  config_hash       TEXT  NOT NULL DEFAULT '',
  applied_hash      TEXT,                         -- 074 writes it; 072 never does
  checked_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified_at       TIMESTAMPTZ,
  notified_blockers JSONB NOT NULL DEFAULT '[]'::jsonb   -- sorted finding keys the last card named
);
CREATE INDEX IF NOT EXISTS idx_channel_readiness_open ON channel_readiness (checked_at) WHERE blockers > 0;
INSERT INTO schema_migrations (version) VALUES ('097_channel_readiness') ON CONFLICT DO NOTHING;
```
Down (`database/migrations/down/097_channel_readiness.down.sql`): `DROP TABLE IF EXISTS channel_readiness; DELETE FROM schema_migrations WHERE version = '097_channel_readiness';`. `channel_key` is the card's key; reads compare `lower(channel_key)`.

### FR-006 ReadinessService

`readiness/readiness.service.ts`, `recheck(channelKey, reason: 'view' | 'owner' | 'sweep' | 'start' | 'fix')`:
1. Under a per-channel in-process lock, load facts and run the doctor.
2. For `owner`, `sweep` and `start`, when `READINESS_AUTO_FIX` is on and the channel is in the sweep set: apply each auto-safe fix once, log one line, reload facts, run the doctor again (once). Each applied fix adds an `auto_fixed` info finding kept for 24 h.
3. Keep `firstSeenAt` of keys that were already open.
4. Upsert the row: findings, counts, `config_hash`, `checked_at`. Never touch `applied_hash`.
5. Notify stamp: when the set of blocker keys differs from `notified_blockers`, the channel is in the sweep set and `notified_at` is null or older than 24 h, write `notified_blockers` = the new set (empty when 0 blockers) and `notified_at = now`.
6. Call each `afterRecheck` hook with `{ channelKey, prevHash, hash, facts, findings, reason }`. A hook that throws is logged and skipped.

`view` never auto-fixes. `sweep()` runs `recheck(key, 'sweep')` for the sweep set, one channel at a time. `fix(channelKey, codes?, via)` applies the one-tap fixes of the open findings (all, or those whose code is listed), then `recheck(key, 'fix')`, and returns `{ applied: string[], failed: { code, error }[], view }`. `ReadinessWorker` (`readiness/readiness.worker.ts`) is `@Cron('*/10 * * * *')` with try/catch, like `AuditWorker` (`editor.module.ts:744-760`). It runs nothing when `EDITOR_ENABLED` is off.

Setting (`settings/catalog.ts`, after `LAUNCH_GRADUATE_MIN_CRITIC_PCT` `:135`): `READINESS_AUTO_FIX`, bool, default `on`, live. Help: "Readiness may apply two safe fixes by itself: allow a read tool a series source needs, and set minimum hashtags to 0 when the hashtag list is empty. Each fix is shown in the Readiness panel. Off = it only reports."

### FR-007 API

`readiness/readiness.controller.ts`, `@Controller('api/editor/channels')`, `@UseGuards(TrackingAuthGuard)`:
- `GET :key/readiness` → `recheck(key, 'view')` → `ReadinessView`;
- `POST :key/readiness/recheck` → `recheck(key, 'owner')`;
- `POST :key/readiness/fix`, body `{ codes?: string[] }` (zod) → `fix(key, codes, 'dashboard')`.
No card → 404 `channel_not_found`.

```ts
export interface ReadinessView {
  channelKey: string; agent: string | null; mode: EditorMode; checkedAt: string; configHash: string;
  blockers: number; warnings: number; infos: number; fixable: number;
  findings: ReadinessFinding[];
  last24h: { planned: number; published: number; awaiting: number; skipped: number; byGroup: Record<string, number> };
  topFix: { key: string; title: string; link: string | null } | null;
}
export interface ReadinessFinding {
  key: string; code: string; severity: 'error' | 'warn' | 'info'; title: string; detail: string;
  subject: FindingSubject; link: string | null; firstSeenAt: string | null;
  fix: { label: string; auto: boolean } | null;   // the Fix itself stays on the server
}
```
`byGroup` uses `skipGroupOf` (`silent/skip-reasons.ts:49`), so 073's `config` group appears by itself. `topFix` is the first blocker with a fix, else the first blocker.

### FR-008 Dashboard: the Readiness panel

- `api/readiness.ts`: `useReadiness(channelKey)` (key `['readiness', channelKey]`, `staleTime` 30 s), `useRecheckReadiness`, `useFixReadiness`; both mutations carry `meta: { readiness: true }`.
- `router.ts:30-35`: the `MutationCache` `onSuccess` first invalidates `['readiness']` unless `mutation.meta?.readiness`. This is the recheck after owner saves.
- `components/readiness/ReadinessPanel.tsx` (+ `readiness.css`; logic in `lib/readiness.ts`) is one `CompactCard`:
  - `top`: Badge `danger` "2 blockers", `warning` "3 warnings", or `success` "Ready";
  - `title` "Readiness"; `body`: the first blocker's title, or "Nothing blocks this channel.";
  - `extra`: "Last 24 h: 6 planned · 2 published · 1 waiting · 3 skipped (2 lint, 1 config)";
  - `note` (warning tone): "Fix all can resolve 2" when some blockers have a fix.
- The dialog: sections Blockers, Warnings, Info as rows in a flush panel (`.panel-row`), each with a `Badge`, title, detail, "Since" date (en-GB), an "Open" link and a "Fix" button when a fix exists. Then "Fixed by code" (`auto_fixed`). Actions: "Recheck" (`.btn-secondary`), "Fix all" (`.btn-primary`, only when `fixable > 0`, with a `useConfirm` listing the fix labels).
- Placement:
  - agent Overview: replaces `ConflictsLine` (`components/agents/AgentOverview.tsx:93-109`, rendered `:157`) for resource orchestrators with a `channelKey`;
  - `/app/editor/$channel`: right after the StatStrip (`routes/app.editor_.$channel.tsx:70-77`), before `CardSummary` (`:80`);
  - launch panel: `components/launch/LaunchBody.tsx` above the Checklist section (`:28-37`), using `v.channelKey`.
- `PauseBanners` (`routes/app.agents_.$handle.tsx:94`) and `SourcesSection` (Settings tab) stay where 078 put them. Pauses also appear as info rows that link to the banner.
- Deep link `?tab=overview&readiness=1`: `validateSearch` (`app.agents_.$handle.tsx:36-44`) keeps `readiness`, and the panel gets `focused`.
- A 404 or error shows nothing on Overview and an `EmptyState` "Readiness is not available" in the launch panel. Works at 375 px. English only.

### FR-009 Owner bot: the readiness card

`readiness/readiness-cards.ts`: `readinessSource(d): CardSource` (`owner-bot/card-sources.ts:23-33`), registered after `launchSource` (`editor.module.ts:2432`).
- `waiting()`: rows with `blockers > 0` and a non-empty `notified_blockers`, channel in the sweep set. `refId` = `<channelKey>|<sha1 of notified_blockers, 8 chars>`, so a new set makes a new card and the old one closes.
- Title: `@x: 2 блокери готовності` (`plural`, `owner-bot/owner-text.ts:18`). Body: up to 5 lines `• <uk> — <subject label>`, then `…і ще N`, then «Виправлень в один дотик: K. Решта — у панелі Readiness.»
- Buttons: «Виправити все» (confirm «Так, виправити»; only when K > 0), «Перевірити», «Відкрити» (path `/app/agents/<handle>?tab=overview&readiness=1`, or `/app/editor/<key>` without an agent).
- `act('fix')` → `fix(key, undefined, 'telegram')` → «✅ Виправлено: N. Блокерів лишилось: M». Nothing fixable → throws «Тут немає виправлень в один дотик — відкрийте панель». `act('recheck')` → «Блокерів: M» or «✅ Блокерів немає».
- At most one new card per channel per day (FR-006.5). Blockers at 0 → the card stops waiting and closes.

### FR-010 Start anyway

No hard gate. Start and the mode switch show open blockers and ask.
- `components/editor/EditorUi.tsx:96` `ModeSwitch` and `components/agents/AgentsUi.tsx:97` `AgentModeSwitch`: going from `off`/`shadow` to `approve`/`live`, fetch readiness (`queryClient.fetchQuery`). With blockers, a `useConfirm` "Start with 2 open blockers?" lists up to 5 titles, `confirmLabel` "Start anyway". The live path then opens `AutonomyDialog` as today. A failed fetch asks nothing.
- `components/artifacts/ArtifactPanel.tsx:266-284`: for `launch:start` the confirm adds the blocker list and the label "Start anyway".
- Owner bot launch card (`launch/launch-cards.ts:68-78`): `LaunchCardDeps.readiness?.blockers(channelKey)` reads the stored row. With blockers, the body adds «Готовність: N блокер(и) — <first uk>. Старт можливий, але ці слоти пропустяться.» and the Start confirm becomes «Так, запустити попри блокери».
- `LaunchDeps.readiness?.recheck(channelKey, reason)` (`launch/launch.service.ts:75-123`): `doStart` calls it with `'start'` in the background, beside `planAhead` (`:549-551`).

### FR-011 Graduation waits

`LaunchDeps.graduation.blockers?(channelKey): Promise<number>`. In `checkGraduation` (`launch.service.ts:275-300`), when `due && settings.mode === 'auto'` and blockers > 0, it does not call `goLive`. It stores `graduation.heldBy = 'readiness'` with the stats and returns. The next hourly check switches once blockers are 0. `propose` and `off` do not change.

### FR-012 Seams for the other wave-7 specs

- **073:** `readiness/checks/config.ts` exports `type ConfigProblem = { code: string; detail: string }` (copy) and `configSeam = { planSkeleton(f): ConfigProblem[]; slotConfig(f): Array<{ slotId: string; problems: ConfigProblem[] }> }`, both returning `[]`. At merge the lead points them at `checkPlanSkeleton(f.card, f.playbook, f.series, f.resources)` and `checkSlotConfig(slot, ctx)` over `f.planned`. Problems map to `error` findings with `check = problem.code`, `detail = problem.detail`, link `?tab=schedule`.
- **075:** appends `checks/datasets.ts` to `DOCTOR_CHECKS`; replaces `countPostable` in `facts.ts` with `postableCount`.
- **076:** facts expose `sources: SourceFact[]` (`url`, `kind`, `origin: 'card' | 'series:<name>'`, `host`, `hostBlock`). The lead wraps `sourceFindings` into a `checks/sources.ts` entry at merge.
- **074:** `ReadinessService.afterRecheck(fn)` and the `applied_hash` column.

## Not doing

- No hard gate, no `READINESS_GATE`, no 409 on Start. No code path changes a channel's mode.
- No event bus and no DB triggers. The 10-minute sweep and the dashboard's recheck cover every write path, SQL included.
- No paid rehearsal and no model call in the doctor.
- No rewriting of skill, rule or brief prose. The doctor offers disable and links to the text.
- No mirroring of the card into the playbook. `formats_diverge` only warns.
- No source probing (076), no dataset publish profile (075), no slot repair or pause lifting (074).
- No readiness line in the daily summary and no weekly `channel.ts` audit area.
- No confirmation in the chat's mode tools. The chat already shows a card.

## Tests

- **Unit** (`readiness/*.test.ts`, `sysadmin/fix-runner.test.ts`): each check on small fixtures, both severities; `configHash` changes with a skill toggle, card formats, `post_requires` and `format_prefs`, and not with mode, pauses, counts or slots; `channelDoctor` dedupe and order; codes catalogue (every code a check emits has an entry, English has no Cyrillic, Ukrainian is not empty); the auto-safe list is exactly two kinds; `runFix` for each kind with fake ports, and `AuditService` behaves as before; `ReadinessService` with fakes: `view` never fixes, `owner`/`sweep` fix once and recheck, hooks get `reason`, the notify stamp at most once a day, the per-channel lock; `readinessSource` texts, buttons and refId change; launch card confirm with blockers; `checkGraduation` auto waits with blockers.
- **PG** (`readiness/readiness.072.pg.test.ts`, own scratch DB): 097 applies twice, the down file runs twice, and up again; `loadChannelFacts` on a seeded channel (card, agent chain, playbook with series, skills, owner rule, steering, dataset with rows and `post_requires`, a pause, a launch) returns the expected facts; it writes nothing (row counts of every table before and after); `recheck` stores and updates the row; the sweep picks approve/live and open launches only.
- **Dashboard**: `lib/readiness.test.ts` (badge, body, 24 h line, confirm text, deep link); `lib/no-cyrillic-ui.test.ts` passes; `tsc`, `test`, `build`.
- **Acceptance replays** (`readiness/fixtures/onboarding-1027.ts`, facts copied from `tmp/agent-export-20261026-2054.tar.gz` and review §1, field values only):
  - @ai0_prompts_dev before the 10-27 fixes → `series_source_contradicted` (prompthero skill vs `library:` source), `origin_original_with_source` (nanobanana v4), `dataset_low_fill` (prompts, `prompt_text`);
  - @pdr_dev_channel before 10-27 → `dataset_without_series` (pdr_questions) and `material_exhausted` (866 of 866 used, reuse `never`);
  - @ai0_global → **0 blockers**: its healthy series and news skills give no false blocker; the paused «AI-новини дня» is `series_paused` info.

## Lead calls (answered — see Amendments)

1. **Auto-fix switch.** A `READINESS_AUTO_FIX` setting, or always on? Recommend the setting, default on.
2. **The owner-bot "note".** A dedicated `CardSource`, or an `agent_inbox` note with a new note action? Recommend the card source: it touches no 060 note-action code and closes by itself when blockers clear.
3. **`LAUNCH_GRADUATION=auto` with blockers.** Wait silently (`heldBy: 'readiness'`), or fall back to a propose card? Recommend wait: the readiness card already asks the owner.
4. **GET side effects.** `GET /readiness` rechecks and stores (and runs 074's hooks), but never fixes or notifies. Recommend yes, as the contract says.
5. **The `channel` area.** A `FINDING_AREAS` superset instead of adding to `AUDIT_AREAS`. Recommend the superset.
6. **`series_source_require` locks the series** (an owner version). Recommend accepting it and saying so in the label.
7. **`dataset_without_series` severity.** Error only when library sources are the card's only sources. Recommend yes.
8. **`poll_series_over_cap`.** Shown as `config_conflict` with no fix until 073 removes the code. Recommend yes.
9. **Paused series and Sources on Overview.** They moved in 078 (banners on every tab; Settings). Recommend leaving them and listing pauses in the panel.

## Amendments after the builder check

The lead's decisions after the drafts (contract, 2026-10-29) and the builder check (2026-10-29) change this spec. These rules override the body. Anchors are at `feat/editor-agent` 1ecb8160; paths are under `apps/automation/src/` unless they start with `apps/dashboard/` or `database/`.

### Lead decisions

**L1. Lead calls 1–9 are accepted as recommended.**
- `READINESS_AUTO_FIX` is a live setting, default on.
- The owner-bot note is a dedicated `CardSource` (`readinessSource`).
- `LAUNCH_GRADUATION=auto` waits silently with `heldBy: 'readiness'` (details in A22).
- `GET /readiness` may recheck and store, but never fixes and never notifies (L2).
- The `channel` area is the `FINDING_AREAS` superset; `AUDIT_AREAS` stays as is.
- `series_source_require` locks the series, and its label says so.
- `dataset_without_series` severity: A21.
- `poll_series_over_cap` shows as `config_conflict` with no fix.
- Pause banners and the Sources section stay where 078 put them (L3).

**L2. GET reads the stored row first.**
- `GET :key/readiness` returns the stored row when its `checked_at` is less than 60 s old. Otherwise it runs `recheck(key, 'view')`.
- A `view` recheck never applies a fix and never writes `notified_at` or `notified_blockers`.
- `?fresh=1` skips the 60 s window (A11).

**L3. Placement.** The Readiness panel replaces only `ConflictsLine` on the agent Overview (and is mounted on `/app/editor/$channel` and in the launch panel, as FR-008). `PauseBanners` (every agent tab, `routes/app.agents_.$handle.tsx:94`) and `SourcesSection` (Settings tab) stay. Paused series appear as info rows whose link opens the Overview tab, where the banner is. Nothing else moves.

**L4. The data store is `apps/automation/src/data/`**, not `editor/data/`. The count SQL to copy is in `data/data-catalog.ts`; 075's publish-profile code also lives under `data/`.

**L5. Names 072 creates. Other specs import them exactly.**
- `readiness/doctor.ts`: `channelDoctor(facts: ChannelFacts): Finding[]`.
- `readiness/facts.ts`: `loadChannelFacts(pool, channelKey, o?)`, `configHash(facts)`, `applyOverlay(facts, overlay)` (A16).
- `readiness/facts.types.ts`: `ChannelFacts`, `DatasetFact`, `SourceFact`, `SkillFact`, `PlannedSlotFact` (A16).
- `readiness/checks/index.ts`: `DOCTOR_CHECKS`, `DoctorCheck = { code: string; run(f: ChannelFacts): Finding[] }`. 075 and 076 append their own files.
- `readiness/readiness.controller.ts`: the DI token `export const READINESS_SERVICE = 'READINESS_SERVICE'` (tokens live in controller files, as `AUDIT_SERVICE`, `sysadmin/audit.controller.ts:6`).
- `readiness/readiness.service.ts`: `ReadinessService` with `recheck`, `sweep`, `fix`, `view`, `afterRecheck`, and the exported types `RecheckReason = 'sweep' | 'view' | 'owner' | 'start' | 'config_skip' | 'fix'` and `RecheckEvent = { channelKey, reason, prevHash, hash, appliedHash, facts, findings }`.
- `afterRecheck(fn)` hooks run after **every** recheck (all six reasons, every sweep), not only when the hash changes. A served stored row (L2) is not a recheck and runs no hooks. `afterRecheck` returns an unsubscribe function. A hook that throws is logged and skipped.
- `readiness/readiness.repository.ts`: `ReadinessRepository` with `get`, `upsert` and `setAppliedHash(channelKey, hash)`. 074 calls `setAppliedHash`; 072 code never does.
- `series_pauses` are not part of the config hash (FR-002 already leaves them out).
- `sysadmin/fix-runner.ts`: `runFix`, `tryFix`, `describeFix`, `fixLabel`, `FixPorts`, `FixResult` (A7). The `Fix` union stays in `sysadmin/audit.types.ts`.
- `FixResult = { ok: boolean; applied?: string; proposal?: { actionId: string }; error?: string }`. A fix that proposes a card instead of writing returns `proposal` (075's `bind_dataset`).
- `readiness/auto-fix.ts`: `AUTO_SAFE_FIX_KINDS` (exactly `tools_allow_add`, `hashtag_min_zero`) and `FIX_ALL_EXCLUDED_KINDS` (empty in W1; 075 appends `bind_dataset`).
- `SourceFact` has the optional fields `required?: boolean` and `probe?` (a subset of 076's `ProbeResult`: `ok`, `failure_class`, `items`, `newest_at`, `checked_at`). 072 sets `required` itself (A16); the lead fills `probe` at the 076 merge.
- `seriesSourceContradictions` (`readiness/source-contradiction.ts`) is built on the existing `skillConflicts`, `sourceInSkill` and `originWithSource` of `agents/skill-warnings.ts`. It does not re-implement them. 072 exports what it needs from that file (A2).

**L6. Fix kinds of the other specs.** 075 adds `dataset_patch` and `bind_dataset` in W2. The lead adds 076's `source_drop` and `host_proxy_add` at the 076 merge. None of these four is auto-safe. `bind_dataset` is the fix for `dataset_without_series`: a proposal, one owner tap, outside Fix all (it is listed in `FIX_ALL_EXCLUDED_KINDS`).

**L7. Doctor codes: one owner each.**
- 072 owns the material and runway checks, all in `checks/material.ts`: `dataset_without_series`, `dataset_post_requires_missing`, `dataset_low_fill`, `material_exhausted`, `material_low`, `dataset_order_random`. 072 also owns `config_conflict` and every other code of the FR-001 table.
- 075 owns only the publish-profile checks in `checks/datasets.ts`. It feeds 072's material codes through `postableCount`, which replaces 072's `countPostable` seam. 072 does not build any 075 code.
- 073 owns `series_format_unavailable`, `series_in_quiet_hours` and `series_rate_over_card_max`. 072 does not check the per-day maximum; it arrives through `configSeam` at merge.
- 076 owns `source_probe_failed`. `source_unreachable` is a skip class and a pause cause, never a doctor code: 072 must not add a catalogue entry named `source_unreachable`.

**L8. 073 names that reach 072 at merge.** 072 must not import them in W1. It keeps the seams named below, and the lead connects them:
- `ConfigProblem` gains `series?: string` and `at?: string` (ISO). The local copy in `checks/config.ts` is `type ConfigProblem = { code: string; detail: string; series?: string; at?: string }`.
- `CONFIG_FAILURE_CODES` and `isConfigCode` are the single source of config codes. 072 defines no list of its own.
- `ScheduleService.slotConfigContext(card, slot)` is the one loader of `SlotConfigCtx`. At merge, `loadChannelFacts` calls it per planned slot and stores the result on `PlannedSlotFact.configCtx`. The checks stay pure.
- `executorToolNames(card, ctx)` replaces 072's `intersectAllow` call for `effectiveTools` at merge.
- `reasonOfError(text)` may refine the 24-hour line at merge. In W1 the line groups by `skipGroupOf` (`silent/skip-reasons.ts:49`).
- `onConfigSkip(channelKey, code)` is wired to `recheck(key, 'config_skip')` at merge, and 073's own per-day note is removed then. To make that wiring possible without a DI cycle (EDITOR_RUNNER ← EDITOR_OPS ← READINESS_SERVICE), the READINESS_SERVICE factory also fills a module holder `READINESS: { svc?: ReadinessService }` in `editor.module.ts`, as `AUDIT` (`:451`, filled at `:2105`).
- The dashboard mirror `apps/dashboard/src/lib/reasons.ts` belongs to 073. In W1, 072 neither imports nor creates it (A17).
- The launch `setMode` passes `{ replan: false }` (073). 072's only edit to `doStart` is the background `readiness.recheck(key, 'start')` beside `planAhead`; it keeps the `setMode` call as it finds it. Edit order of `doStart`/`planAhead`: 073, then 072, then 077.

**L9. Start anyway.**
- W1, 072: a client-side confirm on both mode switches and on `launch:start`, from the readiness view (A11, A23, A24). No server gate, no 409.
- W3, 077 adds the server-side `start(id, { force })`, `POST /api/launches/:id/start-anyway`, and switches the `launch:start` confirm and the owner-bot launch card to its would-be check. 072 builds both confirms in W1 anyway; 077 replaces their data source.
- Mode switches on existing channels keep 072's confirm.

**L10. Fixtures.**
- The 10-27 acceptance replays use synthetic fixtures built from the review's description (A3). They never wait for stage data.
- The stage fixture `readiness/fixtures/stage-<channel>.json` is the lead's. A test that reads it uses `test.skip` with a reason when the file is absent. 072 does not create it.

**L11. Code rules that stay binding.** `loadChannelFacts` is the only module that reads; checks never query. Nothing starts the service, publishes or calls a model in tests. PG tests use their own throwaway database (A14). No code path changes a channel's mode by itself.

### Builder check

**A1. The origin replay is synthetic.**
- The real nanobanana skill `d3ef5edb` v4 does not trip `originWithSource` (`agents/skill-warnings.ts:311`). Both of its origin sentences («…в spec ставлю origin=original і НЕ заповнюю source…», «spec: format=photo, origin=original, без source…») hold «не»/«без», which `RULES_OUT_RE` (`:305`) reads as ruling the pairing out, and neither names a read source. Probed with tsx on the export.
- T5 adds one synthetic skill `prompt-origin-synthetic` whose whole body is «Для рядків library став origin=original.». `originWithSource` returns that sentence (probed). The fixture header marks it synthetic.
- The real v4 text stays in the fixture as its own skill. Against the Prompt series on `library:prompts` it gives `series_source_contradicted` through `skillConflicts` (soft, shared words `prompt`/`photo`; probed).
- The replay asserts with "includes" (code + subject id), never equality of the whole list.
- 072 does not change `originWithSource` (073 edits that file too).

**A2. Path 2 of the source contradiction, and two exports.**
- The prompthero skill `7a054c4f` gives `skillConflicts = []` against «Бери матеріал лише з library:prompts.» (probed). Only `sourceInSkill` hits it (`provider=prompthero`).
- `agents/skill-warnings.ts`: add the `export` keyword to `sourceTokensIn` (`:151`) and `topicOf` (`:229`). No body edits. The map's "do not export" line is replaced (contract: export what `seriesSourceContradictions` needs). Note it in Deltas.
- Path 2, exactly. For a series S with source token `t` and a candidate C:
  - `hit = sourceInSkill(C.body)`; `tokens = sourceTokensIn(hit.sentence)`;
  - C contradicts S when `tokens` is not empty, no token equals `t`, and the topics share a word: `topicOf(S.name, S.brief, seriesBody)` against `topicOf(C.name, C.description ?? '', '')` for a skill, or `topicOf(C.name, '', C.body)` for a rule or a steering line (their names carry no topic).
  - `t` is the library `table` (lower-case), `sourceTokensIn(<feed URL>)[0]` for a feed source (the host label), or the api `source` name.
  - A hit with no tokens (a `url` hit such as «через API») never contradicts; it is `skill_prescribes_source` (warn).
- Probed with the two exports: prompthero tokens `['prompthero']`, series topic `prompt, photo`, skill name/description topic `prompt, image`: they share `prompt`, so path 2 fires.
- The T5 fixture gives the Prompt series `source: { kind: 'library', table: 'prompts' }` and `source_mode: 'required'`, both synthetic (the export's active playbook 14b879 v2 has no `source` key and `suggested` mode). The header says so.

**A3. The acceptance fixture is built by hand.**
- The export lacks the facts: all 5 cards have `sources: []` and `tools_allow: null`; `series_pauses.jsonl` and `schedule_rules.jsonl` are empty; `data_schemas.jsonl` has no `prompts` schema and every `post_requires` is `[]`; there is no `data_schema_stats`.
- `readiness/fixtures/onboarding-1027.ts` builds `ChannelFacts` by hand. Its header lists:
  - real (copied from the export as field values): skill names, descriptions and bodies of `7a054c4f` and `d3ef5edb`; @ai0_global's series names, briefs, cadences and `{ kind: 'free' }` sources, and its enabled skills; the 866 `data://pdr_questions` ledger uses;
  - synthetic: the Prompt series source and mode (A2), `prompt-origin-synthetic` (A1), the `prompts` dataset (roles `body: 'prompt_text'`, fill 0.3 for `prompt_text`, the 083 rule `[['page_url'], ['prompt_text', 'media_url']]`), the @pdr_dev_channel card source `{ kind: 'library', ref: 'pdr_questions' }` with 866 rows, 866 used, reuse `never`, and the open pause of «AI-новини дня» (cause `source_unreachable`).
- Bindings are declared only: card `library` sources and series `library` sources (FR-002). Never derive a binding from the ledger: @ai0_global has 83 `data://assets` uses and no series on them, and a ledger binding would put an error-level `dataset_without_series` on it.
- Expected:
  - @ai0_prompts_dev includes `series_source_contradicted` ×2 (subjects `Prompt|skill:7a054c4f…` and `Prompt|skill:d3ef5edb…`), `origin_original_with_source` (the synthetic skill), `dataset_low_fill` (`prompts`); all four are errors.
  - @pdr_dev_channel includes `dataset_without_series` (error, A21) and `material_exhausted` (error), both on `pdr_questions`.
  - @ai0_global has 0 errors, and includes `series_paused` (info, no fix) for «AI-новини дня».

**A4. "post_requires names the field" means a group that guarantees it.**
- `post_requires` is a list of groups; a row passes when every group has one filled field (`data/post-requires.ts:1-29`; a group may be a string or a string array).
- `bodyFields` = `roles.body` as a list. `requiresBody(postRequires, bodyFields)` is true when some group, normalised to an array, is not empty and every field in it is a body field.
- `dataset_low_fill` fires when `fillRate` exists, the best `fill_rate` over `bodyFields` is below 0.5, and `requiresBody` is false. With no stats, no finding.
- Test in `checks/material.072.test.ts`: the 083 rule `[['page_url'], ['prompt_text', 'media_url']]` does not guarantee `prompt_text` (finding); the 095 rule `[['prompt_text'], ['media_url']]` does (no finding).

**A5. `align.test.ts` and the "Resolve in one card" link.**
- `apps/dashboard/src/lib/align.test.ts:15-21` asserts that `AgentOverview.tsx` and `AgentMemoryHistory.tsx` contain `alignPrompt(`. Removing `ConflictsLine` breaks it.
- The readiness dialog renders a "Resolve in one card" link (`<Link to="/app/chat" search={{ q: alignPrompt(handle) } as any}>`, as `AgentOverview.tsx:105`) on every `config_conflict` row, when the agent handle is known. The link sits in the dialog, never inside the card button.
- `align.test.ts` changes its file list to `../components/agents/AgentMemoryHistory.tsx` and `../components/readiness/ReadinessPanel.tsx`.
- `useAgentConfigConflicts` stays (`AgentMemoryHistory.tsx:24` uses it).

**A6. Eight fix kinds, not nine.** `FIX_KINDS` has 4 kinds today (`sysadmin/audit.types.ts:31`). `conflicts_resolve` only gains optional fields; 4 kinds are new. `FIX_KINDS` lists 8. `fix-runner.072.test.ts` asserts the exact list. `describeFix`, `fixLabel` and `runFix` switch over `fix.kind` with no `default`, so tsc fails when a kind is missing (as `audit.service.ts:48-55`, `:146-167` today).

**A7. `runFix` returns a `FixResult`; refusals still throw.**
- `runFix(ports, fix): Promise<FixResult>` returns `{ ok: true, applied: describeFix(fix, extra) }` (`applied` is the old `describe` string), or `{ ok: true, proposal }` for a proposal kind (none in W1).
- A refusal still throws `Object.assign(new Error(code), { response: { error, details } })`, the shape the controllers and `audit.055` tests read.
- `tryFix(ports, fix): Promise<FixResult>` never throws: a throw becomes `{ ok: false, error }`, where `error` is the text `AuditService.apply` stores (`<code>: <details>`, clipped as `audit.service.ts:119-121`).
- `AuditService.apply` (`:108-127`) calls `runFix(this.d.fixes, f.fix)` and stores `r.applied ?? ''`. `ReadinessService.fix` calls `tryFix` and fills `failed`.
- `audit.055.test.ts` and `audit.055.pg.test.ts` stay unchanged and green.

**A8. Subjects, so `findingKey` never collides.** `findingKey` hashes area, check, subject type, id, agent and channel (`sysadmin/audit-text.ts:36-38`); `channelDoctor` drops repeated keys. Every subject sets `agent` (handle without "@", when known) and `channel` (`@key`).

| Code | File | `subject.type` | `subject.id` |
|---|---|---|---|
| `series_source_contradicted` | `checks/source.ts` | `skill` / `rule` / `steering` | `<series>\|skill:<skillId>`, `<series>\|rule:<id>`, `<series>\|steering:<setId>/<n>` |
| `origin_original_with_source`, `skill_prescribes_source` | `checks/source.ts` | `skill` | skill id |
| `series_source_not_required`, `playbook_draft_waiting` | `checks/series.ts` | `playbook` | series name / pending playbook id |
| `dataset_without_series`, `dataset_post_requires_missing`, `dataset_low_fill`, `material_exhausted`, `material_low` | `checks/material.ts` | `channel` | dataset key |
| `dataset_order_random` | `checks/material.ts` | `channel` | `<dataset>\|<series>` |
| `tools_missing_for_source` | `checks/tools.ts` | `tool` | tool name (one finding per missing tool) |
| `hashtag_min_without_vocabulary` | `checks/config.ts` | `channel` | channel key |
| `config_conflict` | `checks/config.ts` | `rule` when `rule_id`, else `channel` | `<conflictCode>:<ref>:<rule_id or ''>` |
| `formats_diverge` | `checks/config.ts` | `playbook` | format name |
| 073 seam problems | `checks/config.ts` | `channel` | `<problem.code>:<series or slot id>:<at or ''>` |
| `series_paused`, `series_paused_by_owner`, `pause_cause_gone` | `checks/pauses.ts` | `channel` | pause id |
| `bot_not_admin` | `checks/launch.ts` | `channel` | launch id |
| `auto_fixed` | the service (A20) | `channel` | `<fixKind>:<target>:<epoch minute>` |

Tests: two skills contradicting one series give two findings; two config conflicts of different codes give two; one missing tool needed by two sources gives one.

**A9. The bot card refId carries the day; a cleared set is cleared at once.**
- `owner_cards` is unique on `(kind, ref_id)` (`database/migrations/085_owner_cards.sql:30`) and the insert is `ON CONFLICT DO NOTHING` (`owner-bot/owner-cards.repository.ts:62-63`). The same blocker set coming back would reuse the old refId and never be shown.
- `refId` = `<channelKey>|<first 8 hex of sha1(notified_blockers)>|<yyyymmdd of notified_at, UTC>`.
- When a non-`view` recheck finds 0 blockers, it writes `notified_blockers = []` at once, outside the 24 h gate. Clearing is not a notification and leaves `notified_at` as it is.
- A new non-empty set is stamped only under the FR-006.5 gate (`notified_at` null or older than 24 h).
- Tests (`readiness.service.072.test.ts`, `readiness-cards.072.test.ts`): set {A}, cleared, {A} again after the gate → a new refId; at most one stamp per 24 h; a clear inside 24 h empties `notified_blockers`.

**A10. What each recheck reason does.** This replaces FR-006 steps 2 and 5 where they differ.

| Reason | Auto-fix (`AUTO_SAFE_FIX_KINDS` only, `READINESS_AUTO_FIX` on, sweep set) | Notify stamp / clear (sweep set) | Hooks |
|---|---|---|---|
| `owner` | yes | yes | yes |
| `sweep` | yes | yes | yes |
| `start` | yes | yes | yes |
| `config_skip` | no | yes | yes |
| `fix` | no | yes | yes |
| `view` | no | no | yes |

Test each row in `readiness.service.072.test.ts`.

**A11. `?fresh=1`, and how the view is built.**
- `GET :key/readiness?fresh=1` skips the 60 s window and runs `recheck(key, 'view')` (no fix, no stamp).
- `ReadinessService.view(key)` builds a `ReadinessView` from the stored row plus the card and agent lookup plus one `editor_slots` query for `last24h`. It never loads facts. `recheck` returns the same `view`.
- Dashboard (`api/readiness.ts`):
  - `useReadiness(key)` sends plain GET, except inside a 5 s window after any successful mutation. `markReadinessStale()` (exported there) opens the window; `router.ts` calls it in `MutationCache.onSuccess` before it invalidates `['readiness']`, and before the `skipNavBadges` early return.
  - The pure `readinessPath(key, fresh)` and `isFreshWindow(now, staleAt)` live in `lib/readiness.ts`, with tests.
  - The mode-switch and `launch:start` confirms always send `fresh=1` (A24).
  - `useRecheckReadiness` and `useFixReadiness` put their response into the `['readiness', key]` cache (`setQueryData`); they carry `meta: { readiness: true }`, so the global handler does not open the window for them.
- T6 test: a row 30 s old without `fresh` → facts not loaded, the stored findings returned; with `fresh=1` → one recheck.

**A12. `pause_cause_gone` needs proof the cause is gone.**
- `source_host_failures` has no `last_success_at` today (`database/migrations/079_agent_reliability.sql:43-51`). A timeout block lasts 1 h with no strike (`editor/net/host-failures.ts:24`, `:68-72`), and a breaker pause outlives `blocked_until`.
- `SourceFact.lastSuccessAt?: string | null`: `null` in W1. 076's migration 100 adds the column; the lead fills the field at the 076 merge.
- `pause_cause_gone` (warn, fix `series_resume`) fires:
  - for a `no_material` pause, when its dataset has postable unused rows again (`unusedPostable > 0`);
  - for a `source_unreachable` pause, only when the series source's host has no active block **and** `lastSuccessAt` is later than the pause's `pausedAt` (`series-pause/series-pauses.repository.ts:15`). In W1 that never happens.
- Otherwise the pause is `series_paused` (info). `series_paused` has a `series_resume` button for a `no_material` pause, and no fix for a `source_unreachable` pause (the banner keeps its own Resume).
- `series_paused_by_owner` never has a fix; `series_resume` refuses cause `owner` (`owner_pause`).
- Tests in `checks/pauses.072.test.ts` cover each branch.

**A13. Fix all and the one-tap buttons.**
- `fixable`, Fix all on the dashboard and «Виправити все» in the bot cover open **error and warn** findings with a fix whose kind is not in `FIX_ALL_EXCLUDED_KINDS`. Info rows keep an individual button.
- The fix endpoint body is `{ codes?: string[]; keys?: string[] }` (zod). It is the contract's `{ codes? }` with one optional field added:
  - no field → Fix all as above;
  - `codes` → the open findings with those codes (any severity);
  - `keys` → those findings only. Each row's button sends `keys: [finding.key]`, so one row's Fix never resumes every paused series.
- `ReadinessService.fix(channelKey, sel: { codes?: string[]; keys?: string[] }, via)`.
- The bot card body lists, after the blocker lines, «Виправлю в один дотик:» and up to 5 lines `• <ReasonEntry.fix.uk>` of the fixable findings, before the «Виправити все» confirm.
- Test which kinds `fix()` without a selection applies: never an info finding's fix, never an excluded kind.

**A14. PG tests build their own database.**
- `launch/launch.052.pg.test.ts` does not create one: it runs migration 086 on the shared `EDITOR_PG_TEST_URL` database. The common rule's "copy launch.052" is wrong for 072.
- Copy `data/prompts-rule.095.migration.pg.test.ts:46-60`: `pgDbName`/`pgWithDb` from `common/testing/pg-test-url.ts`, `CREATE DATABASE <name>_m097_<tag>_${process.pid}`, `schema_migrations`, `init.sql`, then every migration sorted; `DROP DATABASE` in `after`; skip when the URL is unset.
- One shared helper, `readiness/testing/pg-db.ts`: `scratchDb(url, tag, o?: { skip?: (file) => boolean }): Promise<{ pool: Pool; url: string; drop(): Promise<void> }>`.
- Three PG files, as the tasks say: `readiness-migration.072.pg.test.ts` (T2), `facts.072.pg.test.ts` (T3), `readiness.072.pg.test.ts` (T6).

**A15. The critic verdict is JSON.** `editor_slots` has no `critic_verdict` column; it has `critic` JSONB (`database/migrations/068_critic.sql:17`). The 24 h query selects `critic->>'verdict' AS verdict` (as `silent/silent-days.ts:281`, `launch/launch-queries.ts:26`), windows by `scheduled_at`, passes `skipGroupOf(error, verdict)`, and does not count `isNotAMiss` skips (`silent/skip-reasons.ts:34`) as skipped.

**A16. `ChannelFacts`, exactly.** `readiness/facts.types.ts`:

```ts
export interface ChannelFacts {
  now:             Date;
  channelKey:      string;                       // the card's stored spelling (A27)
  resourceRef:     string;                       // `telegram:<channelKey>`
  card:            EditorCard & { createdAt: Date };
  agent:           { id: string; handle: string; mode: string } | null;          // the resource orchestrator
  chain:           { orchestratorId: string; executorId: string | null } | null;
  profile:         { topic: string | null; language: string | null; formatPrefs: Record<string, unknown> } | null;
  group:           { id: string; name: string; mode: string } | null;
  resources:       Array<{ ref: string; platform: string }>;                     // the group's resources, or this channel alone
  playbook:        { id: string; version: number; body: Playbook } | null;      // active
  pendingPlaybook: { id: string; createdAt: string } | null;
  series:          Series[];                     // series of the active playbook on `resourceRef`, inactive ones included
  pins:            Array<{ id: string; format: string | null; source: string | null; active: boolean }>;
  skills:          SkillFact[];                  // enabled entries of the executor chain and the orchestrator chain
  rules:           Array<{ id: number; text: string }>;   // ownerRulesOf(listActive(key, 60)) (A19)
  steering:        Array<{ id: string; text: string }>;   // `<setId>/<n>`; enabled rules without a conflict of active sets
  datasets:        DatasetFact[];
  pauses:          SeriesPause[];                // open
  sources:         SourceFact[];
  loadoutTools:    string[] | null;              // the executor's loadout allowlist; null = role default
  effectiveTools:  string[] | null;              // intersectAllow(card.toolsAllow, loadoutTools); null = no limit
  conflictInput:   ConflictInput;                // as ConfigConflictsService.forAgent builds it (A19)
  launch:          { id: string; status: 'ready' | 'running'; botState: LaunchBotState | null; graduation: LaunchGraduation | null } | null;
  planned:         PlannedSlotFact[];            // status planned, today and tomorrow in the channel's zone
  slots24h:        Array<{ status: string; error: string | null; verdict: string | null; scheduledAt: string }>;
}
export interface SkillFact { id: string; name: string; description: string; body: string; version: number; inline: boolean;
  origin: AgentSkillEntry['origin']; scope: SkillScope; safety: boolean; agentId: string | null }
export interface DatasetFact {
  id: string; key: string; entity: string; version: number;
  roles: Record<string, string | string[]>; reusePolicy: ReusePolicy; postRequires: PostRequires | null;
  fillRate: Record<string, number> | null;                 // data_schema_stats; null = no stats
  rows: number; notPostable: number; unusedPostable: number;  // countPostable; 075 swaps in postableCount
  boundBy: Array<'card' | `series:${string}`>;
  seriesPerDay: number;                                    // instancesPerDay over the active series that read it
  used28: number;                                          // ledgerUsage
}
export interface SourceFact {
  url: string; kind: 'rss' | 'url' | 'library' | 'api'; origin: 'card' | `series:${string}`; host: string | null;
  hostBlock: { reason: string; until: string; strikes: number } | null;
  lastSuccessAt?: string | null;                           // A12; null in W1
  required?: boolean;                                      // a required series' source, or the card's only source
  probe?: { ok: boolean; failure_class: string | null; items: number | null; newest_at: string | null; checked_at: string } | null;
}
export interface PlannedSlotFact { id: string; scheduledAt: string; resourceRef: string | null; format: string;
  seriesName: string | null; sourceHints: string[]; scheduleRuleId: string | null; configCtx?: unknown }
```

- A series `feed` source resolves its `ref` against the card's source ids (or is a URL) and becomes a `SourceFact` with `kind: 'rss'` and `origin: 'series:<name>'`. A series `library` source is `kind: 'library'`, `url: 'library:<table>'`, `host: null`. A series `api` source is `kind: 'api'`, `url: 'api:<source>'`, `host: null`. `free`, `network_highlights` and an absent source add no `SourceFact`.
- Derived fields (`effectiveTools`, `conflictInput`, `series` from the playbook, each dataset's `boundBy` and `seriesPerDay`, `SourceFact.required`) come from one pure `deriveFacts(raw)` in `facts.ts`. `loadChannelFacts` and `applyOverlay` both call it.
- `applyOverlay(facts, overlay: { card?; profile?; playbook?; series?; datasets?: DatasetFact[]; sources?: SourceFact[] }): ChannelFacts` is pure. It replaces the given parts, appends `datasets` and `sources`, and recomputes the derived fields (with `series` from the overlay playbook when `series` is not given). It never changes its input. Test with a deep-frozen input.
- `configHash` is unchanged from FR-002 (counts, pauses, host blocks, slots and launch state stay out).
- 075 appends one field (`datasetPublish`) and one loader line at W2.

**A17. No `lib/reasons.ts` in 072.** It is 073's file and does not exist in 072's worktree. The panel renders only server strings (`title`, `detail`, `fix.label` come from `DOCTOR_REASONS` and `fixLabel` on the server). Note in Deltas that the lead may switch the panel to the mirror at merge; the drift test stays with 073.

**A18. Config conflicts of this channel only.**
- `ConfigConflictsService.forAgent` is group-wide: it builds resources for every resource of the group (`rules/config-conflicts.service.ts:52-64`), and every `ConfigConflict` has a `ref` (`rules/config-conflicts.ts:63`).
- `checks/config.ts` keeps only conflicts with `ref === f.resourceRef`. A sibling's conflict shows on the sibling's own panel.
- `conflicts_resolve` gains `channel?: string` (with `codes?`). `FixPorts.applyConflicts(orch, o?: { codes?: string[]; ref?: string })`. The `editor.module.ts` AuditService factory line (`:2102`) becomes `applyConflicts: (orch, o) => conflicts.apply(orch, o?.codes ? (c) => o.codes!.includes(c.code) && (!o.ref || c.ref === o.ref) : undefined)`. The readiness port passes `ref: 'telegram:' + fix.channel`.
- The weekly audit passes neither field, so its behaviour does not change.
- `fixLabel` for a `conflicts_resolve` with `channel` reads "Resolve for this channel".
- Test with two resources in one group: only this channel's conflict is a finding, and the fix applies only its `ref`.

**A19. Owner rules: two selections from one read.**
- `config-conflicts.service.ts:51` selects `createdBy === 'owner'`, which includes approval preferences (`evidence.source = 'approval'`). Those are not rules (`rules/owner-rules-prompt.ts:12-16`).
- `loadChannelFacts` reads `repos.memory.listActive(key, 60)` once. `conflictInput.rules` keeps the service's selection, so `configConflicts` matches `forAgent`. `facts.rules` (the contradiction candidates) is `ownerRulesOf(memory)`.
- Test: an approval-preference row that names another source gives no `series_source_contradicted`.

**A20. `auto_fixed` rows carry over for 24 h.**
- `recheck` reads the previous row. Each stored `auto_fixed` finding with `firstSeenAt` within the last 24 h is copied into the new list. Each fix applied in this recheck adds one with `firstSeenAt = now`.
- `subject.id` = `<fixKind>:<target>:<epoch minute>` (target = the channel for `hashtag_min_zero`, the tool list for `tools_allow_add`), so applying the same fix twice gives two rows.
- `auto_fixed` rows count toward none of `blockers`, `warnings` and `infos`, and the dialog shows them only under "Fixed by code".
- Test: fix, two rechecks, the row is kept; 25 h later it is gone.

**A21. Severity of `dataset_without_series`; `after_days` needs no change.**
- `dataset_without_series` is an error when the unbound dataset is the channel's only material: no card `rss`, `url` or `api` source, and no active series of this resource with a `library`, `feed` or `api` source. Otherwise it is a warn. A series on another dataset counts as material: the channel still posts.
- The `after_days` half of the item needs no change. The copied count uses `usedRefsCte` (`data/data-refs.ts:103`), which reads `content_ledger_used`. That function honours `after_days` through `content_ledger_blocks` (`database/migrations/096_data_reuse_rounds.sql:137`, `:163`), so a row used more than N days ago already counts as unused.
- `facts.072.pg.test.ts` proves it: an `after_days 30` row used 40 days ago counts in `unusedPostable`; one used 10 days ago does not.

**A22. `heldBy` is set and cleared every time.**
- `LaunchGraduation` (`launch/launch.types.ts:29-40`) gains `heldBy?: 'readiness' | null` and `heldBlockers?: number | null`.
- In `checkGraduation` (`launch/launch.service.ts:275-300`):
  - when `due && settings.mode === 'auto'` and blockers > 0, the held update stores `heldBy: 'readiness'`, `heldBlockers: n`, the stats and `checkedAt`, and returns without `goLive`;
  - the tail update (`:299`) sets `heldBy: null, heldBlockers: null`;
  - the graduation writes of both transitions (`:283`, `:293`) and of the owner's Go live (`:311`) set `heldBy: null, heldBlockers: null`.
- `graduation.blockers(channelKey)` reads the stored row (the sweep refreshes it every 10 minutes). With no row, it runs one `recheck(key, 'sweep')` and uses its count.
- `graduationStep` (`launch/launch-graduation.ts:111-121`) shows the detail "Waiting: N readiness blockers" while `heldBy === 'readiness'`, with N from `heldBlockers`.
- Tests in `launch.052.test.ts`: propose is unchanged; auto holds with blockers, then switches once they are 0; `heldBy` resets.

**A23. The confirm text is an action phrase.**
- `ConfirmDialog` renders `Are you sure you want to ${action}?` (`components/ui/ConfirmDialog.tsx:68`) and defaults to `danger: true` with the label "Delete" (`:44-49`).
- Mode switch: `confirm(startPhrase(target, n), { confirmLabel: 'Start anyway', danger: false, details: <ul> up to 5 titles, then "…and N more" </ul> })`. `startPhrase('@x', 2)` = `start @x with 2 open blockers`, and `start @x with 1 open blocker` for one.
- `launch:start` (`components/artifacts/ArtifactPanel.tsx:282-283`): the ask stays `CONFIRM['launch:start']`. With blockers, the call adds `details` (the same list) and `confirmLabel: 'Start anyway'`.
- `startPhrase` and `blockerLines(view, 5)` are pure helpers in `lib/readiness.ts`, with tests.

**A24. No `queryClient` import in components.**
- `queryClient` is exported from `router.ts:13`, which imports the route tree and so these components: importing it from `EditorUi.tsx` or `AgentsUi.tsx` makes a cycle.
- Use `const qc = useQueryClient()` (as `components/AppShell.tsx`) and, inside try/catch, `qc.fetchQuery({ queryKey: ['readiness', key], queryFn: () => getReadiness(key, { fresh: true }), staleTime: 0 })`. A failed fetch (404 included) asks nothing extra.
- The live path then opens `AutonomyDialog` as today.

**A25. Smaller tasks.** T4 splits into T4a (`doctor.ts`, `source-contradiction.ts`, `checks/index.ts`, `source.ts`, `series.ts`, `material.ts`) and T4b (`tools.ts`, `config.ts`, `pauses.ts`, `launch.ts`, the codes-completeness test). T8 splits into T8a (api, lib, panel, css, the Overview placement, `ConflictsLine` removal, `align.test.ts`) and T8b (editor page, launch panel, route search, router hook, the browser check). T9 follows T8b.

**A26. The browser check uses a throwaway mock on 3172.**
- Copy `/private/tmp/claude-501/-Users-tupotavalentyn-CS-20-ai0-ai0-global/2132be12-8cfd-462d-b944-db7830138061/scratchpad/rdmock/server.mjs` (078's dependency-free mock: built dist, SPA fallback, unknown `/api/*` → 404 JSON) into your own scratchpad.
- Add the three readiness routes (GET, POST recheck, POST fix) with a mode env `READINESS=blockers|none|404`.
- Run `node server.mjs <dashboard dist> 3172` after `npm run build` in `apps/dashboard`. Never commit it, never put it in `tmp/`, and never use 3000, 5173, 5174 or 3178.

**A27. One spelling of the channel key.** `EditorChannelsRepository.get` matches `channel_key` exactly (`repo/editor-channels.repository.ts:107-109`). `ReadinessService` resolves the given key once to the card's stored spelling (`SELECT channel_key FROM editor_channels WHERE lower(channel_key) = lower($1)`; no card → `channel_not_found`) and uses that spelling for every read, upsert and `setAppliedHash`. This replaces FR-005's "reads compare lower(channel_key)". Test: `@X` and `@x` update one row.

**A28. The CI bootstrap check, as a command.** `psql`, `createdb` and `dropdb` are in `/opt/homebrew/bin`. From the repo root, in one shell:

```bash
DB=ci072_$$
createdb -h /tmp/pgs046 -p 55446 -U postgres "$DB"
PGHOST=/tmp/pgs046 PGPORT=55446 PGUSER=postgres PGDATABASE="$DB" bash database/ci-bootstrap-check.sh
dropdb -h /tmp/pgs046 -p 55446 -U postgres "$DB"
```

Never point it at port 5432. If `psql` is missing, rely on `readiness-migration.072.pg.test.ts` and say so in Deltas.

**A29. Source kinds.**
- Series sources are `library` (`table`), `api` (`source`), `feed` (`ref`), `network_highlights`, `free`, or absent (`network/series.ts:66-78`). Card sources are `rss`, `url`, `library`, `api` with `ref` (`card.ts:31-37`).
- `free`, `network_highlights` and an absent source are sourceless: no contradiction, no tools finding, no `series_source_not_required`. 073's `config_tools_missing` covers `network_highlights` at merge.
- The tools map uses "any of", as 073 does:

| Source | Needs any of | Fix adds |
|---|---|---|
| series `library` / card `library` | `query_data`, `search_library` | `query_data` |
| series `feed` / card `rss` | `fetch_feed`, `web_fetch` | `fetch_feed` |
| card `url` | `web_fetch` | `web_fetch` |
| series `api` / card `api` | `fetch_api` | `fetch_api` |

- `tools_missing_for_source` is an error when an active series needs the tool, and a warn when only a card source does.
- `effectiveTools === null` means no limit: no finding.
- Test with a `free` series: no source findings.

**A30. Wiring without a cycle.**
- `loadChannelFacts(pool, key)` builds its own repositories from the pool: `EditorChannelsRepository`, `AgentsRepository`, `SkillStore`, `NetworkRepository`, `SteeringRepository`, `LoadoutRepository`, `SeriesPausesRepository`, `EditorMemoryRepository`, plus plain SELECTs for profiles, pins, datasets, ledger, host blocks, launch and slots. It never needs a Nest provider.
- The `READINESS_SERVICE` factory injects only `DB_POOL`, `ConfigService`, `EDITOR_REPOS`, `AGENT_INFRA` (for `configConflictsOf` and `profiles`, `editor.module.ts:436-441`), `EDITOR_OPS`, `SCHEDULE_INFRA` and `AGENTS_SERVICE`. The builder check's list missed `AGENT_INFRA`. None of these injects `LAUNCH_SERVICE` or `OWNER_BOT`, which inject `READINESS_SERVICE` in T7.
- The factory fills the `READINESS` holder (L8).
- `editor/editor.module.test.ts` stays green.

**A31. The owner-bot launch card can go stale. Accepted.**
- Its body and confirm label are fixed when the card row is inserted (`launch/launch-cards.ts:67-78`).
- `act('start')` (`:83-86`) reads the stored readiness row once after the start and adds the count to the outcome: «✅ Запущено: пости чекають вашого схвалення. Відкритих блокерів: N» (only when N > 0). There is no gate.
- Note the staleness in Deltas.
- Test in `launch.052.test.ts`.

**A32. `series_source_require` keeps the series.**
- `applySeriesOp` 'update' merges the patch into the current series (`schedule/series-change.ts:50-54`). It keeps `origin` (`cur.origin ?? 'agent'`, not `'owner'`) and sets `locked: true`.
- `prepareSeriesChange` may refuse with `series_invalid` when `seriesProblems` finds something else wrong (`schedule/schedule.service.ts:624-625`). The port throws that as the fix's error.
- T1 test with the real `applySeriesOp` on a fixture playbook: after the fix, the series equals the series before except `source_mode: 'required'` and `locked: true`.
- A second test: a refusal reaches `tryFix` as `{ ok: false, error: 'series_invalid: …' }`.

### Open for the lead

1. **073's run-time repairs and the auto-safe list.** 073's lead call 3 says its in-run repairs (`config_format_mismatch`, `config_source_mismatch`) "are on 072's closed auto-safe list". 072's `AUTO_SAFE_FIX_KINDS` lists `Fix` kinds of the runner, and those repairs are not `Fix` kinds. Recommendation: keep the two-kind list. At the 073 → 072 merge, add `AUTO_SAFE_RUN_REPAIRS = ['config_format_mismatch', 'config_source_mismatch'] as const` beside it in `readiness/auto-fix.ts`, make 073's runner read it, and pin both lists in `auto-fix.072.test.ts`.
2. **Two judges of the same contradiction.** 073 adds `seriesSourceConflict` to `agents/skill-warnings.ts` for skill writes. 072's `seriesSourceContradictions` judges the same thing for the doctor. Recommendation: at the 072 merge, make 073's helper call `seriesSourceContradictions`, so a skill the write path accepts never turns into a doctor blocker, and the reverse.

## Lead decisions after the integration review (2026-10-29)

These override everything above, including the Amendments. They come from a cross-spec review of all six specs (the item numbers I1… are that review's).

- **I3:** one constant `FIX_ALL_EXCLUDED_KINDS = ['bind_dataset', 'dataset_patch']` in `readiness/auto-fix.ts`, typed as strings (075 adds the kinds in W2). There is no second list anywhere.
- **I5:** in the config seam, repairable slot problems (073's `isRepairable`, wired at merge) become `info` findings ("will be repaired before the run"); only the others become `error`. Write the seam so this is one call.
- **I5, owner card:** the owner-bot readiness card lists only blockers that were present on two consecutive rechecks at least 5 minutes apart. A single recheck never sends a card.
- **I6:** `ChannelFacts.resources[]` get the optional `formats?: string[]` and `tz?: string`. W1 leaves them unset; at the merge the loader fills them through 073's `skeletonResourcesOf`, and the seam passes `f.playbook?.body ?? null`.
- **I8:** in `LaunchBody`, show the stored-row Readiness panel only after the launch has started. Before Start show nothing; 077 adds the panel of the would-be state.
- **I9:** `NOTED_ELSEWHERE` in `readiness/notify`: the readiness card leaves out `source_probe_failed` (076 sends its own host note), pause rows (060 sends `series_paused`), and `bot_not_admin` while a launch is open for the channel.
- **I14:** keep the per-pair judgement in one function (`judgePair`) in `source-contradiction.ts`, so the lead swaps it for 073's `seriesSourceConflict` in one line at the merge. Do not edit `skill-warnings.ts` beyond adding `export` keywords.
- **I13:** `checks/tools.ts` keeps a local source→tool map in W1, marked "replaced by 073's SOURCE_READ_TOOLS at merge".
- **I17:** `poll_series_over_cap` stays in the exclusion list in W1; the lead removes it at the 073 merge.
- `pause_cause_gone` for `no_material`: W1 uses the `countPostable` seam (unused > 0). At the W2 merge it switches to 075's `materialAvailable`.
