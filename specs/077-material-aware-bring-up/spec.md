# 077 — Bring-up: launch and setup that take the material

Status: draft · Builds on 052 (launch), 042 (setup), 031 (approval write-ahead), 072 (doctor, Readiness), 073 (config checks, reasons), 075 (dataset publish profile), 076 (source probe) · Migration 101

> **Read the «Amendments after the builder check» section at the end first.** Where it differs from the body, the amendment wins.

Linear AI0-255 · Runbook §37 · Mock port 3177 · Wave 3: built after 073 → 072 → 076 and 074 ∥ 075 are merged.

## Why

The owner asked on 2026-10-27:

> «мені потрібно щоб коли я додаю новий канал то це було просто, швидко і зручно, щоб не доводилось 2 тижні дебажити його роботу»

What happened on stage (review `docs/reviews/2026-10-27-channel-onboarding.md` §1):
- **@pdr_dev_channel.**
  - A poll went out with no correct answer.
  - `pdr_questions` was on reuse `never`. All 866 rows were used, and the channel was dark for about 10 days.
  - Every clause post was rejected, because the critic could not see `read_doc` (F22, fixed in 067).
  - On 10-27 four things were wrong at once. The card had quiz, but the playbook gave quiz weight 0. A rule said «poll з correct_index». There was no series. The brief and the guard read the 0-based `correct_answer_num` as 1-based (spec 079 fixed the guard: it matches by `num`).
  - The rules site is geoblocked from the server.
- **@ai0_prompts_dev.**
  - Migration 083 made 4 764 text-less PromptHero rows "postable".
  - «бери з nanobanana» became a skill, not a series source.
  - 8 of 9 Prompt slots were skipped (`series_source_mismatch`, `origin_mismatch`, empty `prompt_text`).
  - On 10-27 everything was fixed by hand on stage.
- Each layer was found by a 4–6 day export-and-review cycle, so the two channels took about 3.5 weeks.

The checks themselves come from 072–076. This spec makes `/launch` and `/setup` use them before anything is written, and show the owner what the writer will be told. It closes:
- **F09.** Launch and setup write a plan without checking it against the real channel, and never try a first post.
- **F17.** What the writer is told is invisible, and it differs from what the critic sees.
- **F22.** Runtime defects that only real slots reveal. The first drafts at Start and the instructions view surface them on day one, not after a review cycle.
- **F25.** Lifecycle gaps:
  - a half-done Start;
  - no drift check;
  - `/setup` never checks the bot or sets a mode;
  - launches never age;
  - nothing is said after 24 h of silence.

  (073 already fixes the `/app/approvals` link and planning tomorrow.)

The code map with every anchor is `<scratchpad>/w7/map-077.md`. Where it and this spec differ, this spec wins.

## What

### FR-001 `/launch` takes the material

Today `/launch` takes only a target, references and a brief:
- `chat/slash-commands.ts:81-96` `parseLaunchArgs`;
- `launch/launch-tool.ts:27`;
- `CreateBody` at `launch/launch.service.ts:135-139`.

The analysis sees no dataset and no source, and the system prompt forbids proposing sources (`launch/launch-analysis.ts:190`).

- **Grammar.** `/launch @new [@ref …] [from dataset <key>[,<key>]] [from <url> …] brief`.
  - A `from` clause counts only when `dataset <key>` or an `http(s)://` URL follows it. Otherwise it is part of the brief.
  - Keys must match `SCHEMA_KEY_RE` (`apps/automation/src/data/data.types.ts:24`). A t.me link is a reference, never a source.
  - At most `LAUNCH_MAX_DATASETS = 3` datasets and `LAUNCH_MAX_SOURCES = 10` URLs.
- **Input.** `parseLaunchArgs` returns `{ target, references, datasets, sources, brief }`. `SlashDeps.launch` (`chat/slash-commands.ts:47`), the `launch_channel` tool and `CreateBody` gain `datasets?: string[]` and `sources?: string[]`.
- **New errors** (`LAUNCH_ERRORS`, `chat/slash-commands.ts:123-128`; `createLaunch` returns them):
  - `unknown_dataset`: "no dataset `<key>` — see Data";
  - `dataset_not_active`: "dataset `<key>` is a draft or archived";
  - `invalid_source`: "`<url>` is not an http(s) address";
  - `too_many_datasets`, `too_many_sources`.
- **Reading the material.** It is read in `begin` (`launch.service.ts:357-377`), so "Make the plan again" reads it again. It is stored in `channel_launches.material` (migration 101).
  - **Per dataset:**
    - fields with roles;
    - 3 sample rows, each value clipped to 300 chars;
    - the row count;
    - `postableCount(pool, schemaId, 'telegram:<key>')` (075);
    - the publish profile (075);
    - the `DatasetBindPlan` returned by `bindDatasetPlan(d, channelKey, key)` (075 FR-009, `editor/datasets/bind-dataset.ts`). A `Fail` is stored as the dataset's error.
  - **Per URL:** `probeSource(url, {})` (076), $0, served from its 6 h cache. A failed probe is kept with its `failure_class`, and the launch goes on.
- **The «Матеріал» block.** `launchUserPrompt` (`launch-analysis.ts:196-213`) adds one block:
  - per dataset: the fields, the samples, rows/postable, the publish format and «запас: N днів при 1 на день»;
  - per source: «OK, 24 записи, найновіший 2 год тому» or «недоступне з сервера (timeout)», and up to 5 sample titles.
- **The system rule** at `:190` becomes: «Не пропонуй режим, бюджет, моделі чи інструменти. Джерела — лише з блоку «Матеріал»; серію на датасеті код привʼяже сам.»
- **An existing channel.** `/launch` on a channel with 20 or more posts adds one chat line: "This channel already has posts — /setup reads them." The launch still goes on.

### FR-002 Code binds the material after the model

New pure `bindMaterial(plan, material): { plan: LaunchPlan; set: string[] }` and `reconcilePlan(plan): { plan; set }` in `launch/bring-up/bind.ts`. `analyze` (`launch.service.ts:406-429`) applies both before it stores the plan, and the `extra` check validates the same result. So the model never sees an error that code fixes.

- **Dataset series.** A new channel has no playbook, so 075 returns `series` (source `library:<key>`, `source_mode: 'required'`, the profile's format) as a new series, with `card: null`.
  - `bindMaterial` applies 075's take-over rule to the plan. The plan series of the same format with no required source gets the source, `source_mode` and format; its name, brief and times stay. With none, 075's series is added.
  - At Start, `datasetPatch` is applied through `DataStore.updateSchema` with 075's stale check. It is additive: missing `post_requires` and an unset `publish.format`. `reuse` and `warnings` stay proposals on the panel, with a link to the dataset.
- **Sources.** Probe-OK sources go to `card.sources`: rss → kind `rss` with `feed_url`, page → kind `url`.
  - A failed probe is not added. It shows on the panel with 076's actions.
  - The read tools a source needs are added to `toolsAllow` (073 names them in `checkSlotConfig`).
- **`reconcilePlan`.** It holds the closed list of plan auto-fixes, and a test enforces the list:
  - `posts_per_day_max` is raised to the most series instances on one day (the result is never above `LAUNCH_MAX_PER_DAY = 6`; above that it is a plan error);
  - `posts_per_day_min` is lowered to the max when it is larger;
  - each series format missing from `format_mix` is added at weight 0.2.
- **Precedence.** Code wins on format, source, `source_mode` and caps. The model wins on names, briefs, voice, times and ideas.
- **`bringup.set`.** It lists in English what code set, for example: "Series «Тест дня»: source library:pdr_questions (required), format quiz" and "Posts per day max 1 → 2 (two daily series)".
- **Storing it.** `LaunchPlan` is `SubmitLaunchInput` with optional `source` and `source_mode` on each series. These two are code-only and are not in the model's tool schema.
  - `doStart` parses `LaunchPlan` (today it parses `SubmitLaunchInput` at `:494`).
  - `toSetupInput` (`:645-656`) passes both through.
- **First-week ideas.** An idea whose format equals a bound dataset's format gets the variant note «день N · матеріал: датасет <key> (query_data)».
- **`mergePlaybook`** (`setup/setup-apply.ts:133-173`; launch and setup both use it). Today `:151-163` drops every unlocked series of the resource, and new series get `source_mode: 'suggested'` with no source.
  - Unlocked series whose source is `library` or `feed` are kept, unless a new series has the same name.
  - A new series takes `source` and `source_mode` from its input. If the input has none, it takes them from the old series of the same name.

### FR-003 Checks before anything is written

Today:
- launch and setup validate the would-be playbook against the body's own sections, all treated as Telegram, and against the plan's own format keys (`launch.service.ts:435-444`, `setup/setup.service.ts:183-192`);
- there are no quiet hours, no source catalogue and no doctor;
- Start writes step by step and stops half-way on an error (`:497-547`).

- **Real context in `extra`.**
  - `resources` and `telegramFormats` come from `networkContext` (`network/network-context.ts:70`), with the would-be card formats.
  - Options are `{ quiet: plan quiet hours, sources: seriesSourceCatalog(pool, wouldBeCard) }` (`network/series-edit.ts:65`).
  - Before a channel has an agent, it falls back to today's resources.
  - `checkPlanSkeleton` (073) lines are added, as «план: …».
  - This applies to launch and setup.
- **The would-be doctor** (`bring-up/would-be.ts`): `wouldBeFacts(await loadChannelFacts(pool, key), overlay)` → `channelDoctor` (072). The overlay replaces the card, the profile, the playbook section and the series with what Start would write. It adds the bound datasets and the probe results.
  - At plan-ready the result is stored as `bringup.ready`.
  - At Start it is computed again as `bringup.start`.
  - It never writes.
- **Drift.** At ready, `bringup.baseline = sectionBaseline(state, targetRef)` (`setup-apply.ts:45`). At Start, `driftedSections` (`:72-75`) lists the sections the owner changed since. Drift counts like a blocker for the Start prompt; this is setup's "Replace" rule.
- **Start** (`start`, `:469-481`; `doStart`, `:493-556`):
  - it first parses the plan and runs `validatePlaybook` with the real context, the would-be doctor and drift, all before any write;
  - a plan error stops Start with no writes (`start_failed`, the reason names the error);
  - blockers or drift return `{ started: false, waitingFor: 'readiness', blockers: Finding[], drift: string[] }` and write nothing;
  - `POST /api/launches/:id/start-anyway` (the alias of `start(id, { force: true })`) and the artifact action `start_anyway` ("Start anyway") pass, and they store `bringup.forced`. 072 FR-010's "Start anyway" confirm in `ArtifactPanel` lists `bringup.ready` (not the empty channel's stored row) and calls this route;
  - steps stay idempotent, so a second Start continues where the first stopped.
- **When the bot is not ready.** A Start pressed while the bot is not an admin is remembered only when there are no blockers. The automatic start in `watch` (`:250-252`) runs the same check. On blockers it clears `startRequested`, and the reason reads "Start waits: N blockers".
- **The owner bot** (`launch/launch-cards.ts:40-95`).
  - 072 FR-010's blockers line and confirm «Так, запустити попри блокери» read `bringup.ready` before Start. When it has blockers, the Start button's key is `start_anyway`, which passes `force`.
  - When a plain Start is refused, `act('start')` returns «⚠️ Не запущено: N блокерів. Відкрийте запуск або натисніть «Старт» ще раз — він запустить попри блокери.» The refreshed card then carries `start_anyway`.

### FR-004 First drafts at Start

Today:
- Start plans today in the background (`launch.service.ts:552-554`);
- the first drafts wait for `writeAt` (`approval/approval-timing.ts:70-82`), which is 20:00 the day before, or up to 3 h ahead.

The first look at real output can therefore be the next evening.

- **What runs.** After the mode step, a background chain does the following:
  - it awaits `planAhead` (073 plans today and tomorrow);
  - it calls `firstDrafts(slots, series, now)` (pure, `bring-up/first-drafts.ts`). Per active series it picks the earliest planned content slot in the next `FIRST_DRAFTS_WINDOW_H = 48` hours. That slot must not be live (`topicMode: 'live'`), must not be time-sensitive (`isTimeSensitive`, `:50`), and must not be derived (`duplicate` / `adapt`). With no series, it picks the first plain slot. The cap is `FIRST_DRAFTS_MAX = 6`;
  - it runs each pick one after another through the new `writeNow` dep, which is `EditorOpsService.runSlot(id, { wait: true })` (`api/editor-ops.service.ts:276-288`). This is the same claim and executor as the write-ahead (`editor.scheduler.ts:294-307`). A `slot_not_planned` conflict is ignored.
- `bringup.firstSlots` holds `{slotId, series, format}`.
- There is no extra spend: these runs would happen at `writeAt` anyway. A restart mid-chain leaves the rest to the normal write-ahead.
- Preview stays the manual button.

### FR-005 What the writer is told

New `GET /api/editor/slots/:id/instructions` (`api/editor.controller.ts`, next to `:65`) → `EditorOpsService.slotInstructions(id)` → `EditorRunnerService.instructions(slot, card)`.

It makes no model call and no write. Its header reads "Rendered now from the current setup — not the stored prompt of an earlier run". It works for every slot status.

- **The system prompt.** `buildSystemPrompt` (`roles/prompts.ts:79-126`) is split into `systemPromptBlocks(...)`: `PromptBlock[]`, and `buildSystemPrompt` becomes `blocks.map((b) => b.text).join('\n')`. A test proves the output is byte-identical.
  - Block sources: `principles`, `voice`, `examples`, `style`, `owner_rules`, `card`, `memory`, `prefs`, `steering`, `skill:<name>` (one per inline skill), `skills_listed`.
- **The user prompt.** Its blocks are `slot`, `already_used`, `stories`, `idea`, `format_prefs`, `profile`, `series`. `series` comes from a new read-only `ScheduleService.executorContext(slot, { notify: false })`, because `:312-327` posts `series_source_empty` (`:319`).
- **The critic.** Its blocks are the system prompt `criticSystemPrompt(skills)` (`critic/critic.service.ts:136`) and one block per field of its context:
  - brief, profile, format_prefs, playbook, examples, skills, owner_rules, steering;
  - series, from FR-006.
- **Skills.** `skills: { inline, listed, overBudget }` against `INLINE_SKILLS_BUDGET` (`prompts.ts:27`).
- **Checks.** `config: checkSlotConfig(slot, ctx)` (073) and `preflight: preflight.assessPlanned(slot, card)` (`preflight/slot-preflight.ts:252`, which never swaps).
- **Other slot kinds.**
  - Native platform slots (`roles/editor-runner.service.ts:842-…`) show the system and user prompt as two `platform` blocks.
  - Derived slots show a note: "this slot adapts another post".
- **Dashboard.**
  - The slot page (`routes/app.editor_.slot.$id.tsx`, after Plan `:66-82`) gets a SectionCard "Instructions". It holds two CompactCards: "What the writer is told" (meta: "N blocks · N chars") and "What the critic checks".
  - Each opens a details dialog that lists the blocks. A block header carries a `Badge` with its source, and its text is in a pre-wrapped scroll area.
  - Config problems and the pre-flight verdict show as `callout-warning` above the cards.
  - A 404 or empty response shows "Instructions are not available for this slot."

### FR-006 Prompt fixes the view exposes

- **The critic gets the series note.**
  - `AttemptOpts` (`editor-runner.service.ts:239`) gains `seriesNote`.
  - `runExecutor` passes it on the first attempt (`:469`), and the ladder passes it on each step (`:613-614`).
  - `criticGate` (`:288-322`) → `CriticGateContext.seriesNote` (`critic/critic-gate.ts:91`) → the request (`:396-411`) → `CriticRequest.seriesNote` (`critic/critic.service.ts:39`).
  - `criticUserPrompt` (`:143`) renders it after the brief (`:151`) as «### Серія цього слота» plus the note.
- **The Telegram writer gets the profile's tone and taboo.**
  - `platformContext` (`network/network-runner.ts:321-339`) returns `profileVoice`: the `Тон:` and `Табу-теми` lines that `renderProfile` already writes (`agents/resource-profile.ts:195-196`).
  - `executorUser` (`editor-runner.service.ts:826-839`) adds «Профіль ресурсу (тон і табу):» and calls `platformContext` with `resourceRef ?? telegram:<key>`.
  - It does not add the full profile.
- **The precedence line names skills.**
  - `rules/owner-rules-prompt.ts:30` becomes «Важливіші за плейбук, профіль, format_prefs, скіли (зокрема channel-voice) і приклади: …».
  - The required-source line (`schedule/series-guard.ts:110`) gains «Обовʼязкове джерело серії важливіше за скіли: якщо скіл називає інше джерело — бери це.»

### FR-007 Lifecycle

- **Checklist** (`launch/launch-checklist.ts:38-116`). `StepKey` (`:12`) gains `'readiness'` and `'first_outcomes'`, both after `start`.
  - `readiness` reads "Readiness: no blockers" or "Readiness: 2 blockers". Before Start its detail comes from `bringup.ready`; after Start it comes from `channel_readiness`. The panel itself is 072's.
  - `first_outcomes` reads "First drafts: 2 of 3 written". Each `firstSlots` entry adds a detail line: "«Тест дня»: awaiting approval", or "«Тест дня»: skipped — <reasonFor(code).en>. <fix.en>". It is done when every pick has left `planned` / `running`.
- **24 h quiet card.** In `watch` (`:242-256`), a running launch with `startedAt` more than `LAUNCH_QUIET_HOURS = 24` ago, no published post and no `awaiting_approval` / `approved` slot since Start, posts once (`bringup.quietNotedAt`):
  - via the new dep `notifyQuiet(l)`, which is `inbox.postOnce` with kind `launch_quiet`, severity `action`, refType `launch`, refId `<id>:quiet`;
  - title "<key>: nothing published or waiting 24 h after Start";
  - body "Open the launch: the first drafts show what happened to each series.";
  - alert «🚀 <key>: за добу після старту нічого не вийшло і нічого не чекає схвалення» / «Відкрийте запуск: там видно, що сталося з першими слотами.»;
  - the dashboard `INBOX_KINDS` (`apps/dashboard/src/lib/inbox-kinds.ts`, near `:329`) gets `launch_quiet` with its why and steps.
- **Age warning.** A `ready` launch whose plan is older than `LAUNCH_PLAN_STALE_DAYS = 7` shows:
  - in the checklist `start` detail and in a dashboard `callout-warning`: "This plan is N days old. Make it again if the channel changed.";
  - on the owner-bot card: «План складено N днів тому — можливо, варто скласти його знову.»

  Nothing expires.

### FR-008 `/setup` Apply ends with the bot check and "Start in approval"

Today `apply` (`setup/setup.service.ts:280-320`) returns `{proposal, applied, kept, rebuilt, failed, changedSinceAnalysis}`. A new card is created with `mode: 'off'` (`setup-apply.ts:243-251`), and nothing checks the bot.

- **The Apply response** gains `next`:
  - `next: { bot: LaunchBotState, mode }` when the card is `off`;
  - `next: null` otherwise.
  - Apply also calls 072's `readiness.recheck(channelKey, 'setup_apply')`.
- **New `POST /api/channel-setup/proposals/:id/start`.** It:
  - runs the bot check (`makeLaunchBotCheck`, `launch/launch-bot.ts:9-46`) and `trackOwn`;
  - runs the would-be gate (the current state, the same as 072's mode-switch prompt; `force` in the body passes it);
  - sets mode `approve` (the same `setMode` as launch) and runs `planAhead`.
- **Dialog** (`SetupProposalDialog.tsx`; `doApply` `:58-80`, Apply `:153-154`). After an Apply with `next`, the dialog shows:
  - "Bot: admin" or "Bot: not an admin — add the bot as an admin";
  - an **unticked** checkbox "Start in approval";
  - **Done**.

  Ticked, Done calls the endpoint. On blockers it shows them with "Start anyway".

### Migration 101

`database/migrations/101_launch_material.sql`:
```sql
ALTER TABLE channel_launches ADD COLUMN IF NOT EXISTS material jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE channel_launches ADD COLUMN IF NOT EXISTS bringup  jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE channel_launches DROP CONSTRAINT IF EXISTS channel_launches_material_object;
ALTER TABLE channel_launches ADD CONSTRAINT channel_launches_material_object
  CHECK (jsonb_typeof(material) = 'object' AND jsonb_typeof(bringup) = 'object');
INSERT INTO schema_migrations (version) VALUES ('101_launch_material') ON CONFLICT DO NOTHING;
```
`database/migrations/down/101_launch_material.down.sql`:
```sql
ALTER TABLE channel_launches DROP CONSTRAINT IF EXISTS channel_launches_material_object;
ALTER TABLE channel_launches DROP COLUMN IF EXISTS bringup;
ALTER TABLE channel_launches DROP COLUMN IF EXISTS material;
DELETE FROM schema_migrations WHERE version = '101_launch_material';
```
- There is no status change and no index.
- The repository (`launch/launch.repository.ts`: `toLaunch :8-16`, `LaunchPatch :18-38`, `JSON_COLS :40`, `COLS :41-46`) and `ChannelLaunch` (`launch.types.ts:67-93`) gain `material` and `bringup`.

### Types (`launch/bring-up/bring-up.types.ts`)

```ts
export interface MaterialDataset {
  key: string; ok: boolean; error?: 'unknown_dataset' | 'dataset_not_active';
  entity: string; rows: number; postable: number | null;               // postableCount (075)
  fields: Array<{ name: string; type: string; role: string | null }>;
  samples: Array<Record<string, unknown>>;                              // ≤3, values ≤300 chars
  publish: PublishProfile | null;                                       // 075 PublishProfileSchema
  bind: DatasetBindPlan | null;                                         // bindDatasetPlan (075 FR-009)
}
export interface LaunchMaterial { datasets: MaterialDataset[]; sources: Array<{ url: string; probe: ProbeResult | null }>; readAt: string | null }
export interface BringUpCheck { at: string; planErrors: string[]; findings: Finding[]; blockers: number; warnings: number; drift: string[] }
export interface LaunchBringUp {
  set: string[]; baseline?: Record<string, unknown>; ready?: BringUpCheck; start?: BringUpCheck;
  forced?: { at: string; blockers: number; drift: string[] } | null;
  firstSlots?: Array<{ slotId: string; series: string | null; format: string }>;
  quietNotedAt?: string | null;
}
export type PromptBlockSource = 'principles' | 'voice' | 'examples' | 'style' | 'owner_rules' | 'card' | 'memory' | 'prefs'
  | 'steering' | 'skills_listed' | 'slot' | 'already_used' | 'stories' | 'idea' | 'format_prefs' | 'profile' | 'series'
  | 'brief' | 'playbook' | 'platform' | `skill:${string}`;
export interface PromptBlock { source: PromptBlockSource; title: string; text: string }
export interface SlotInstructions {
  slotId: string; channelKey: string; format: string; status: string; renderedAt: string;
  writer: { system: PromptBlock[]; user: PromptBlock[]; chars: number } | null;
  critic: { enabled: boolean; system: string; context: PromptBlock[] } | null;
  skills: { inline: string[]; listed: string[]; overBudget: string[] };
  config: ConfigProblem[]; preflight: { ok: boolean; code?: string; reason?: string } | null; note: string | null;
}
```
The dashboard mirrors `SlotInstructions` and the new `LaunchView` fields (material, set, check, firstOutcomes, ageDays) in `apps/dashboard/src/lib/launch.ts` and `api/editor.ts`.

## Not doing

- Creating the Telegram channel or adding the bot by MTProto. Only the bot check is automatic.
- Any code path that changes mode by itself. Start, Start anyway and "Start in approval" are the owner's taps.
- A paid or separate rehearsal. The first drafts are the normal approval-mode runs, brought forward.
- Storing full prompts per run. The view renders on demand.
- Mirroring the card into the playbook, archetype presets, a "New channel" dialog, or a "rewrite stale drafts" card.
- Rewriting skill, rule or brief prose. Problems link to the text (072).
- Event buses or DB triggers. The would-be check runs inside launch and setup calls.
- Re-implementing 072–076. 077 calls `bindDatasetPlan`, `postableCount`, `probeSource`, `loadChannelFacts`, `channelDoctor`, `checkSlotConfig`, `checkPlanSkeleton` and `reasonFor`.
- Expiring old launches. They get a warning only.
- Splitting native platform prompts by source.

## Tests

- **Unit** (fakes, `node:test`):
  - `parseLaunchArgs`: `from dataset a,b`, URLs, a brief that starts with "from the…", the caps, a t.me URL;
  - `bindMaterial` and `reconcilePlan`: format match versus add, precedence, the closed auto-fix list (a test lists it), the `set` lines;
  - `mergePlaybook`: keeps unlocked library and feed series, carries the source by name;
  - `firstDrafts`: one per series, excludes live, time-sensitive and derived slots, the cap, no series;
  - `systemPromptBlocks` joins byte-identical to the old `buildSystemPrompt` for the planner, executor and reviewer fixtures;
  - `criticUserPrompt` contains the series note;
  - `executorUser` contains tone and taboo;
  - the precedence lines;
  - checklist steps and the age warning;
  - the quiet-card condition.
- **PG** (`launch/bring-up/bring-up.077.pg.test.ts`, its own DB on the scratch server, `@pgtest_launch_077%`):
  - migration 101 and its down file run twice;
  - material read for a seeded dataset;
  - Start with blockers writes nothing, and Start anyway writes;
  - a second Start after a failed step continues;
  - first drafts run through a fake runner;
  - the quiet card posts once;
  - the setup `start` endpoint.
- **Instructions:**
  - the endpoint on a fixture slot makes no LLM call (FakeLlm records zero calls);
  - it writes no inbox row (`notify: false`);
  - blocks are labelled `skill:<name>`;
  - over-budget skills are listed.
- **Dashboard** (`node:test` + tsc):
  - `lib/launch.ts` helpers: outcome lines, age, blockers callout text;
  - `lib/slot-instructions.ts`: grouping and chars;
  - `INBOX_KINDS` has `launch_quiet`;
  - `no-cyrillic-ui` passes;
  - 375px layout checked on the mock server (port 3177).
- **Acceptance replays** (`bring-up.acceptance.077.pg.test.ts`, fixtures from the review §1 table, FakeLlm plans):
  - **@pdr_dev_channel.** `from dataset pdr_questions` with a model plan of 2 daily series, max 1, and a quiz series with no source. Expected:
    - quiz is bound to `library:pdr_questions` as required;
    - the max is raised to 2;
    - a timed-out rules-site URL shows as unreachable before any write;
    - the poll rule and the playbook quiz weight 0 show as doctor findings at plan-ready;
    - Start's first drafts include the quiz slot.
  - **@ai0_prompts_dev.** `from dataset nanobanana_prompts` (publish format photo), with a skill that names PromptHero. Expected:
    - the series source is `library:nanobanana_prompts`, required;
    - the skill finding shows at plan-ready;
    - the instructions view of a Prompt slot shows the required-source series block, and the critic context shows the same note.
  - **@ai0_global.** The healthy series fixture gives 0 blockers on the would-be check and on Start, and no plan error from the real-context `extra`.

## Lead calls (answered — see Amendments)

1. **Drift at Start.** Recommended: store `sectionBaseline` at ready, and show the changed sections with "Start anyway" (about 20 lines, reusing setup code).
2. **Expiry versus a warning** for old launches. Recommended: warning only, at 7 days, as a constant.
3. **First drafts.** Recommended: run them through `runSlot` now, with no scheduler or `writeAt` change.
4. **Live and time-sensitive slots in the first drafts.** Recommended: exclude them; they would be stale by their time.
5. **"Start in approval" after setup.** Recommended: a separate endpoint after Apply, so Apply itself never changes mode.
6. **Several datasets plus URLs in one `/launch`.** Recommended: allow up to 3 datasets and 10 URLs.
7. **The instructions view for written slots.** Recommended: yes, labelled "rendered now, not the stored prompt".
8. **Writer profile lines.** Recommended: tone and taboo only, not the full profile.
9. **`/launch` on a channel with 20 or more posts.** Recommended: a warning line suggesting `/setup`, with no refusal.
10. **A server-side `force` at Start, next to 072's client-only confirm.** Recommended: yes. Only the server sees the fresh would-be state and drift at the moment of the press. It never blocks: Start anyway always passes.
11. **075's `datasetPatch` at launch.** Recommended: apply it at Start, because it is additive and stale-checked. Keep `reuse` as a proposal on the panel, because a reuse policy is the owner's call.

## Amendments after the builder check

The builder check (2026-10-29, `<scratchpad>/w7/check-077.md`) and the lead's "Decisions after the drafts" (2026-10-29, the last section of `<scratchpad>/w7/contract.md`) change the body as follows. These rules override the body. Anchors are `feat/editor-agent` HEAD `1ecb8160`; re-check them by symbol after the W1/W2 merges. A1–A46 answer the check's items in the order of its list (A*n* answers item *n*).

### Lead decisions

**L1. Lead calls 1–11 are accepted as recommended.**
- Drift is stored at ready and shown with "Start anyway" (call 1). Old launches get a warning, never expire (call 2).
- First drafts run through `EditorOpsService.runSlot` now, with no scheduler or `writeAt` change (call 3). They are capped at `FIRST_DRAFTS_MAX = 6` per Start, within `FIRST_DRAFTS_WINDOW_H = 48`. They never include live (`topicMode: 'live'`), time-sensitive (`isTimeSensitive`, `approval/approval-timing.ts:50`) or derived (`treatment` `duplicate`/`adapt`) slots, and they go through the normal spend caps: no cap is lifted and no extra budget is given (call 4).
- "Start in approval" after `/setup` is a separate endpoint; Apply never changes mode (call 5). Up to 3 datasets and 10 URLs per `/launch` (call 6). The instructions view works for written slots too, labelled "rendered now" (call 7). The writer gets tone and taboo only (call 8). A `/launch` on a channel with posts warns and goes on (call 9). Server-side `force` at Start (call 10). `datasetPatch` is applied at Start; `reuse` stays a proposal on the panel (call 11).

**L2. Names 077 calls (exact; never re-implemented).**
- **075.**
  - `bindDatasetPlan(d: BindDeps, channelKey, datasetKey, o?: { cadence? }): Promise<DatasetBindPlan | Fail>` in `editor/datasets/bind-dataset.ts`. Its `card` is `null` for every new launch (no playbook). A `Fail` is a dataset warning, stored on the dataset, and never stops the launch. `BindDeps` is 075's type: 077 imports it and builds it in the module.
  - `postableCount(pool, dataset: { id?: string; key?: string }, resourceRef: string | null)` in `apps/automation/src/data/postable.ts`, returning `{ rows, postable, unposted, repeats }`. The body's `postableCount(pool, schemaId, …)` is wrong.
  - `PublishProfileSchema` lives in `apps/automation/src/data/data.types.ts`, and its helpers in `apps/automation/src/data/publish-profile.ts`. There is no `editor/data/`.
  - The `dataset_patch` apply function in `editor/datasets/bind-dataset-action.ts`, which re-reads the schema and refuses `stale` when `post_requires` or `publish` changed.
- **076.**
  - `sourceProberOf(pool)` is the bound prober, with the 6 h cache and the host record. 077 probes only through it.
  - `probeSource(url, opts)` takes `{ store?, hosts?, force?, maxAgeMs?, cacheOnly? }`.
  - `failure_class` also takes `invalid`, for a malformed URL or one the SSRF guard refuses. It is not cached.
  - The doctor code for a failed probe is `source_probe_failed`.
- **072.**
  - `loadChannelFacts(pool, key)`, `channelDoctor(facts)`, `Finding` and `applyOverlay(facts, overlay)`. The overlay may replace `card`, `profile`, `playbook` and `series`, and may add `datasets` and `sources`.
  - The DI token `READINESS_SERVICE`. `RecheckEvent.reason` is one of `'sweep' | 'view' | 'owner' | 'start' | 'config_skip' | 'fix'`.
  - The stored `channel_readiness` row. `bot_not_admin` is a 072 doctor code (error).
- **073.**
  - In `readiness/slot-config.ts`: `checkSlotConfig`, `SlotConfigSlot`, `SlotConfigCtx` and `ConfigProblem { code, detail, series?, at? }`. In `readiness/plan-skeleton.ts`: `checkPlanSkeleton`.
  - `ScheduleService.slotConfigContext(card, slot)`, read-only: the one loader of `SlotConfigCtx`. `executorToolNames(card, ctx)`.
  - `reasonFor(code)` and `reasonOfError(text)` in `reasons/catalogue.ts`. First-outcome lines parse a slot's stored error with `reasonOfError`.
  - The dashboard reads reason labels only from the mirror `apps/dashboard/src/lib/reasons.ts`.

**L3. Start anyway** (contract "Start anyway").
- 077 adds the server-side `start(id, { force })`, `POST /api/launches/:id/start-anyway` and the refusal `{ started: false, waitingFor: 'readiness', blockers, drift }`.
- It switches 072's two launch confirms (ArtifactPanel `launch:start` and the owner-bot launch card) to the launch's own check, `bringup.start ?? bringup.ready`. They stop reading the empty channel's stored row.
- Mode switches on existing channels keep 072's client confirm. 077 does not touch `ModeSwitch` or `AgentModeSwitch`.

**L4. `setMode` keeps `{ replan: false }`** (073). Every Start path of 077 calls `setMode(key, 'approve', { replan: false })` and only then `planAhead`. The Start paths are: launch Start, the auto-start in `watch`, and setup "Start in approval".

**L5. Shared lines** (contract "Shared lines edited by several specs").
- 077 edits `doStart` and `planAhead` from the merged 073 + 072 state. It keeps 072's `readiness.recheck(key, 'start')` beside `planAhead` when `planAhead` moves into the first-drafts chain (A30).
- It edits `schedule.service.ts` after 073, 074 and 075.
- 077 owns `executorContext(slot, { notify: false })`.

**L6. Doctor codes.**
- 077 owns no doctor check.
- Its own check adds two bring-up codes, `dataset_changed` and `source_changed` (A18). They are appended to `reasons/catalogue.ts` with kinds `dataset` and `source`, and mirrored in `apps/dashboard/src/lib/reasons.ts`. 073's catalogue test requires every owner-visible code.

**L7. Binding rules restated.**
- No paid rehearsal, no hard mode gate, no code path that changes mode by itself, no event bus and no DB triggers.
- No "rewrite stale drafts" card, no archetype presets, no "New channel" dialog, and no mirroring of the card into the playbook.
- Dashboard text is English and owner-bot text is Ukrainian.
- Tests use fakes. PG tests use the scratch pattern. The mock server uses port 3177 only. 077 touches migration 101 only.

### Builder check

**A1. Fixtures (item 1, wrong fact): accepted.**
- `validLaunch()` (`launch/testing/launch-fixtures.ts:7`) is a `SubmitLaunchInput` plan, not a row.
- Row defaults live in `MemoryLaunchRepo.insert` (`:59`) and, for PG, in `toLaunch` (`launch/launch.repository.ts:8-16`).
- T1 gives `MemoryLaunchRepo.insert` the empty `material` (with `requested` from its argument) and `bringup: { set: [] }`, and adds `MemoryLaunchRepo.mergeBringup`.
- T3 adds `validLaunchPlan()`: a `LaunchPlan` whose quiz series carries `source: { kind: 'library', table: 'pdr_questions' }` and `source_mode: 'required'`. `validLaunch()` does not change.

**A2. The amendments section (item 2): accepted as this section.**
- The contract's decisions are folded in above (L1–L7), and every accepted item is written here.
- The proposal to record accepted items in `tasks.md` Deltas is rejected. Deltas stays for the implementer's own deviations.

**A3. First drafts are not the scheduler's claim (item 3, wrong fact): accepted.** `runSlot` (`api/editor-ops.service.ts:276-288`) stays the runner (contract). The scheduler skips paused and unavailable slots in its tick (`editor.scheduler.ts:208-216`), not in `claimWriteAhead` (`:294-307`), so 077 does that check itself:
- New `runFirstDrafts(deps, launch, picks)` in `bring-up/first-drafts.ts` handles each pick in order:
  - `deps.firstDraftGate(slot)` returns `'paused' | 'unavailable' | null`. It is built in the module from `new ResourcePauseService({ pool }).isPaused(ref)` and `platform.health.usable(ref)`, as `editor.module.ts:1389` and `:1198` do. With a reason, the pick is left `planned` for the scheduler.
  - `deps.writeNow(slotId)` is `ops.runSlot(id, { wait: true })`.
  - `ConflictException` `slot_not_planned` → outcome `not_planned`.
  - `editor_disabled` → outcome `editor_off`, and the chain stops (the rest stay planned).
  - Any other error → `failed`, with the note clipped to 200 chars.
- Each outcome is merged into `bringup.firstSlots` (A30). The function never throws.
- `editor.scheduler.ts` is not edited.

**A4. `postableCount` signature (item 4, wrong fact): accepted.**
- `readMaterial` calls `postableCount(pool, { key }, 'telegram:<channelKey>')` and stores `rows`, `postable` and `unposted` on the dataset.
- The runway line «запас: N днів при 1 на день» uses `unposted` (or `postable` when `repeats`).

**A5. Card sources (item 5, wrong fact): accepted.**
- `card.sources` items are `{ id, kind, ref, note? }` (`api/card-input.ts:28-43`). The list has at most 30 (`:72`).
- For each probe-OK URL, `bindMaterial` adds a source:
  - `kind: 'rss'` with `ref` = the probe's `feed_url` when `probe.kind === 'rss'`, else `kind: 'url'` with `ref` = the URL;
  - `id` = `src-` plus the first 8 hex of sha1(ref);
  - `note` = the first sample title, clipped to 300.
- It skips a URL whose `ref` the card already holds, compared case-insensitively without a trailing `/`.
- When the list would pass 30, the extra sources are dropped, with one `set` line: "Source <url> not added: the card already has 30 sources".

**A6. Module wiring (item 6, wrong fact): accepted.**
- The LaunchService factory (`editor.module.ts:2111-2124`) injects positionally with trailing optionals, and TypeScript forbids a required parameter after them.
- `LaunchDeps` gains one optional `bringUp?: BringUpDeps`. It is built inside the factory from what is already in scope: `pool`, `repos`, `ops`, `runner`, `infra` (inbox, profiles), `platform` and `approval`.
- A service that is not in scope is appended at the end of `inject` as `{ token, optional: true }`. That covers `READINESS_SERVICE` and `SCHEDULE_INFRA`.
- Nothing is reordered.
- With `bringUp` undefined, `LaunchService` behaves exactly as at HEAD, so the 052 `LaunchDeps` literals still compile (A44).

**A7. Setup recheck reason (item 7, contract conflict): accepted, corrected.**
- `'setup_apply'` is not a reason, and neither is the checker's `owner_save`. Apply calls `readiness.recheck(channelKey, 'owner')`.
- 072 may already recheck after owner saves on Apply. If the merged code does, 077 adds nothing.
- 072's union is not edited.

**A8. Would-be facts (item 8, contract conflict): accepted.**
- `bring-up/would-be.ts` exports `wouldBeOverlay(writes: StartWrites, material: LaunchMaterial): FactsOverlay` and `wouldBeCheck(facts, overlay, o): BringUpCheck`.
- `FactsOverlay` is 072's overlay type. If 072 exports no name, use `type FactsOverlay = Parameters<typeof applyOverlay>[1]`.
- `wouldBeCheck` runs `channelDoctor(applyOverlay(facts, overlay))`. The body's own `wouldBeFacts` is dropped.
- When 072's overlay cannot carry a part that Start writes, 077 adds the field to 072's overlay type and `applyOverlay`. Such parts are the voice skill and the reference rules (A27). The fields are optional (`skills?`, `steering?`), a few lines appended next to the existing ones, and listed in Deltas.

**A9. `SlotConfigCtx` (item 9, contract conflict): accepted.**
- Nothing in 077 builds a `SlotConfigCtx` by hand.
- The instructions view takes it from `ScheduleService.slotConfigContext(card, slot)`, and tool names from `executorToolNames(card, ctx)` (073), through `EditorRunnerServiceDeps.slotConfigContext?` (A32).
- The would-be check passes the would-be card (from `StartWrites`) to `checkPlanSkeleton` and to the overlay, never the live card.

**A10. `bot_not_admin` in the gate (item 10, contract conflict): accepted.**
- `LAUNCH_GATE_IGNORED_CODES = ['bot_not_admin']` (`bring-up.types.ts`).
- The launch gate counts blockers as findings with severity `error` whose code is not in that list. The bot has its own gate (`waitingFor: 'bot_admin'`). The ignored finding still shows in the list.
- Test: the bot is not an admin and there is no other blocker → `waitingFor: 'bot_admin'` and `startRequested` stored.
- The setup gate (A38) uses the same filter.

**A11. Dataset deps and the stale check (item 11, contract conflict): accepted, corrected.**
- `BindDeps` is 075's input type of `bindDatasetPlan`, not 077's. 077 defines `MaterialDeps` (A26) and builds 075's `BindDeps` in the module.
- `MaterialDataset.expect = { post_requires, publish }` is the schema's two fields as read with the material. These are the fields 075's stale check compares.
- At Start the patch step (A18) applies `bind.datasetPatch` through 075's `dataset_patch` apply function with `{ dataset, patch, expect }`.
- When the schema changed since the read, the check carries `dataset_changed`: an error, whose fix reads "Make the plan again". The patch is not written, not even under `force`.

**A12. Bind before the checks (item 12, ambiguity): accepted.**
- In `buildSubmitLaunchTool.execute` (`launch-analysis.ts:159-163`), code first runs `bindMaterial(input, material)` and then `reconcilePlan`. Only then do `checkLaunch` and `extra` run, on the result.
- `execute` returns `{ ok: true, launch: plan, set }`. `analyze` (`launch.service.ts:406-429`) reads both from `terminalResult`, parses `launch` with `LaunchPlan` and stores it without recomputing.
- The polls rule (`:107-110`) exempts the formats a bound dataset sets: `LaunchCheckContext` gains `materialFormats?: string[]`, and the owner asked for that dataset.
- `material` reaches the tool through `LaunchCheckContext.material?`.
- Test: a model plan with two daily series and `posts_per_day_max: 1` passes `execute` with no error. It is stored with max 2 and the `set` line "Posts per day max 1 → 2 (two series a day)".

**A13. `LaunchPlan` and collisions (item 13, ambiguity): accepted.**
- In `launch-analysis.ts`:
  - `LaunchSeriesPlan = <the series item of SubmitLaunchInput>.extend({ source: SeriesSourceSchema.optional(), source_mode: z.enum(SERIES_SOURCE_MODES).optional() })`;
  - `LaunchPlan = SubmitLaunchInput.extend({ series_pillars: …extend({ series: z.array(LaunchSeriesPlan).max(8) }) })`.
  - Factor the series item out as a named const so both schemas share it.
- `buildSubmitLaunchTool` keeps `input: SubmitLaunchInput`, so the model never sees `source`.
- `bindMaterial` takes the datasets in the order given. Each dataset applies 075's take-over rule to the plan's series:
  1. a series that already reads `library:<key>`;
  2. else the first plan series of the same format with no required source that no earlier dataset took;
  3. else 075's new series. If that name already exists, it gets " (2)" (" (3)" …).
- A dataset with `bind: null` or an error binds nothing.
- Series instances per day above `LAUNCH_MAX_PER_DAY = 6` after reconcile are a plan error, returned to the model in Ukrainian («план: N постів серій на день — більше за 6; прибери рубрику»).

**A14. Stored shapes (item 14, missing): accepted.**
- `material.requested = { datasets, sources }` is written at insert: `LaunchRepository.insert` and `MemoryLaunchRepo.insert` take `material?`.
- `toLaunch` turns the DB default `{}` into the typed empties:
  - `material`: `{ requested: { datasets: [], sources: [] }, datasets: [], sources: [], readAt: null }`;
  - `bringup`: `{ set: [] }`.
- `redo` (`:604-620`) writes `bringup: { set: [] }` whole and keeps `material.requested`. `begin` reads the material again.

**A15. View shape (item 15, missing): accepted.**
- `launchJson` (`launch.service.ts:669-678`) adds `material`, `bringup`, `set` (= `bringup.set`) and `check` (= `bringup.start ?? bringup.ready ?? null`).
- `view()` adds `firstOutcomes: FirstOutcome[]` and `ageDays: number | null`. `ageDays` counts whole days since `bringup.ready.at` while the status is `ready`, else it is null.
- The types are in "Types after the amendments" below. The dashboard mirrors them in `apps/dashboard/src/lib/launch.ts`.

**A16. Reading the material never blocks or fails a launch (item 16, missing): accepted.**
- `readMaterial(deps, channelKey, requested)` (`bring-up/material.ts`) reads every dataset and URL with `Promise.allSettled`. Each read is wrapped in a `MATERIAL_READ_TIMEOUT_MS = 20_000` timeout. 076's probe has its own fetch timeout; this one also guards the DB reads and `bindDatasetPlan`.
- A rejected or timed-out read gives:
  - for a dataset: `ok: false, error: 'read_failed', errorText`;
  - for a source: `probe: null, note`.
- `begin` (`:357-377`) catches any throw from `readMaterial`, stores the requested items as `read_failed` and goes on. It never moves a launch to `failed` because of material.

**A17. Drift after a half-run Start (item 17, ambiguity): accepted, changed.**
- When a step fails, `doStart` first re-reads `state` (`deps.state`). It then merges `bringup.baseline` (fresh) and `bringup.written` (the step names done), and only then throws `start_failed`.
- A retry compares only the owner's edits made after the failure, so the launch's own writes are never drift.
- If that re-read throws, it stores `baseline: null` and the retry skips drift (logged).
- Test: fail at the playbook step, then a second Start succeeds without Start anyway. An owner edit of the card brief after the failure shows as drift on the second Start.

**A18. Fresh material at Start (item 18, ambiguity): accepted.**
- Start runs `readMaterial` again through the cached prober. Probes up to 6 h old come from 076's cache at $0. `bindDatasetPlan` and `postableCount` run again.
- It compares the result with the stored `material`:
  - a dataset whose schema `post_requires`/`publish` no longer equals `expect`, or whose bind series format or source changed, adds finding `dataset_changed` (error);
  - a source that was probe-OK and now fails adds `source_changed` (warn). That source is not added to the card.
- The findings go into `bringup.start`. The stored plan is not rebound.
- The patch step is idempotent:
  - when the schema already holds every row of `datasetPatch.post_requires` and its `publish.format`, it does nothing;
  - when the schema equals `expect`, it applies;
  - otherwise it skips and writes the `set` line "Dataset <key> changed since the plan: its patch was not applied".

**A19. Forced Start and the bot (item 19, ambiguity): accepted.**
- `start(id, { force: true })` merges `bringup.forced = { at, blockers, drift }` even when it then returns `waitingFor: 'bot_admin'`.
- `watch` (`:250-252`) no longer calls `doStart` directly. It calls the gate path with `force: Boolean(l.bringup.forced)`.
- On blockers, not forced, it transitions `{ startRequested: false, reason: 'Start waits: N blockers' }`.

**A20. `StartResult` (item 20, missing): accepted.**
- `launch.types.ts` exports `StartResult<V = unknown> = { launch: V; started: boolean; waitingFor: 'bot_admin' | 'readiness' | null; blockers: Finding[]; drift: string[] }`.
- `waitingFor` is null once started. `blockers` and `drift` are `[]` unless `waitingFor` is `'readiness'`.
- Consumers updated in the task that changes `start()` (T6):
  - `launch.controller.ts` (`:22-23`, plus the new `start-anyway` route);
  - `LaunchCardDeps.launches.start` (`launch-cards.ts:17`);
  - the 052 tests;
  - the dashboard type in T13.
- The slash command and the tool never call `start()`.

**A21. Owner-bot card (item 21, missing): accepted, refined.**
- Cards are unique per `(kind, ref_id)` and never refreshed (`owner-cards.repository.ts:63`, `owner-bot.service.ts:150-157`). A returned outcome resolves the card; a throw keeps it open with its keyboard (`:378-391`).
- `waiting()` (`launch-cards.ts:41-46`) also selects `bringup`. A ready launch's card is built from `bringup.ready`, which the `ready` transition writes in the same row (A26):
  - With gate blockers or drift, the body adds 072's blockers line «⚠️ N блокерів: <codes>». The Start button becomes `{ key: 'start_anyway', label: 'Старт попри блокери', confirm: 'Так, запустити попри блокери' }`, which calls `start(id, { force: true })`.
  - Otherwise the button stays `start`, as today. The 052 assertion `['start', 'check', 'open']` (`launch.052.test.ts:414`) holds without bringup.
- `act('start')` refused with `waitingFor: 'readiness'` merges `bringup.startRefusedAt` and `bringup.startRefusedKey` (the sorted blocker codes plus drift). It then throws «⚠️ Не запущено: N блокерів. Натисніть «Старт» ще раз протягом 30 хв — він запустить попри блокери, або відкрийте запуск.», and the card stays open.
- A second `act('start')` within `START_REFUSAL_WINDOW_MS = 30 min` with the same key calls `start(id, { force: true })`.
- The age line (FR-007) goes into the body.
- Test: refuse, then force.

**A22. Artifact actions (item 22, missing): accepted.**
- `launchActions(r, l)` (`launch-artifact.ts:29-43`) takes `l.gate?: { blockers: number; drift: number }`. The adapter reads it from the body's `check`, minus ignored codes.
- When status is `ready`, `startRequested` is false and the gate is non-zero, `start_anyway` ("Start anyway", `POST start-anyway`) replaces `start`. Otherwise `start` shows as today.
- `ArtifactPanel.tsx` `CONFIRM` (`:266`) gains `'launch:start_anyway'`. Its text lists the check's error findings and the drifted sections from the payload. This replaces 072's `launch:start` confirm source; there is no second dialog.
- The payload is the view (A15), so it carries `bringup` and `check`.
- A plain Start refused at the press shows the returned blockers in a toast. After the refetch the panel offers `start_anyway`, because `bringup.start` is stored.

**A23. `/launch` grammar (item 23, regression risk): accepted.** `parseLaunchArgs` (`chat/slash-commands.ts:81-95`) always returns `datasets: []` and `sources: []`. T2 updates the 052 `deepEqual` expectations (`launch.052.test.ts:123-127`). After the references, clauses repeat in any order:
- `from dataset k1[, k2 …]`: commas with or without spaces. Keys are lower-cased and stripped of a trailing `.,;:)`. The parser keeps the raw keys; `createLaunch` checks them against `SCHEMA_KEY_RE` and the store (`unknown_dataset`).
- `from <url> [<url> …]`: http(s) URLs, stripped of a trailing `.,;:)`.
  - A `t.me` / `telegram.me` URL after `from` is refused with `invalid_source`: "t.me links are references — put them right after the channel".
  - A non-http token ends the clause.
- `from` not followed by `dataset <key>` or an http(s) URL starts the brief. That covers "from the…" and a `from` at the end of the line.
- Duplicates are dropped: keys case-insensitively, URLs after the trim.
- Caps are checked in `createLaunch` (`too_many_datasets`, `too_many_sources`).
- The brief keeps its line breaks.
- Tests: one per case.

**A24. SlashMenu mirror (item 24, missing): accepted.**
- `SlashMenu.test.ts:24-28` compares `name` and `args` only, so `args` stays `'@new_channel [@ref …] brief'`.
- The `/launch` `description` changes in `chat/slash-commands.ts:12` to "Launch a new channel from a brief, up to 3 reference channels and its material (from dataset <key>, from <url>) (one model run in the background)".
- `apps/dashboard/src/components/chat/SlashMenu.tsx:14` gets the same description without the bracketed tail. Both files are in T2.

**A25. "This channel already has posts" (item 25, ambiguity): accepted.**
- New `launchQueries.postCount(key)` returns the larger of the channel's published editor slots and its `tracked_posts` rows (the table `setup/setup-posts.ts:66` reads).
- With `LAUNCH_EXISTING_POSTS_WARN = 20` or more, `createLaunch` returns `{ ok: true, launch, notes: ["This channel already has posts — /setup reads them."] }`.
- `SlashStart`'s ok branch gains `notes?: string[]`. The `case 'launch'` reply (`slash-commands.ts:182-183`) and the `launch_channel` tool result append them.
- The dep is `BringUpDeps.postCount?`.

**A26. One deps object (item 26, missing): accepted.**
- `BringUpDeps` is in "Types after the amendments". It is optional on `LaunchDeps`, and each feature is skipped when its dep is absent.
- `LaunchRepository.mergeBringup(id, partial)` (A30) is required on the repository: both repos get it in T1.
- The `ready` transition in `analyze` writes `bringup` whole (`{ set, baseline, ready }`), because nothing else writes it while the launch is `analyzing`. Every later write uses `mergeBringup`.

**A27. What the would-be overlay covers (item 27, missing): accepted, premise corrected.**
- In the @ai0_prompts_dev replay, the PromptHero skill is a stored chain skill, so 072 reads it from stored facts.
- Start also writes the voice skill and activates the reference sets' rules, and either can name a source. So both belong in the overlay.
- New pure `startWrites(plan, state, launch, material): StartWrites` (`bring-up/start-writes.ts`). It returns:
  - `profile`;
  - the card patch, with sources and `toolsAllow` (A28);
  - the format patch;
  - the playbook (`mergePlaybook`);
  - the voice skill (`launchVoice`);
  - the reference set ids to activate;
  - the dataset patches;
  - the ideas.
- `doStart` writes exactly these, and `wouldBeOverlay` reads the same object. That is one function with two consumers.
- PG test: after Start, `channelDoctor(await loadChannelFacts(...))` has no finding code that `bringup.start` lacked, except `bot_not_admin` and codes about slots planned after Start.

**A28. Tools and sources (item 28, regression risk): accepted, corrected.**
- `toolsAllow: null` means all tools (`api/card-input.ts:16`). A new launch card is created with `null` by `prepareChannel`.
- `bindMaterial` adds the read tools a source or series needs only when the card's `toolsAllow` is non-null. It takes the source→tool mapping from 073's `slot-config.ts` (the one `checkSlotConfig` uses), exported if it is local; it never writes its own list.
- A `feed` series ref may be a card source's `id` or its `ref`: `seriesSourceCatalog` lists both (`network/series-edit.ts:67`).
- The card step (`launch.service.ts:510-514`) already runs before the playbook step (`:522-528`), so nothing is reordered.

**A29. `mergePlaybook` (item 29, regression risk): accepted in part.**
- The claim that setup's counts change is wrong. Apply's `kept` lists locked format fields and `rebuilt` is a flag for the agent (`setup/setup-apply.ts:221-223`, `:266-267`, `:312`); neither counts series.
- Keeping unlocked `library`/`feed` series is intended for all four callers (`launch.service.ts:437`, `:522`; `setup/setup.service.ts:185`; `setup/setup-apply.ts:291`). `/setup` Apply must not drop a series that 075 or the agent bound to a dataset. So the "keep today's output without sources" switch is rejected.
- T4 first adds a characterisation test of today's drop rule (`setup-apply.ts:151-163`) to `setup/setup.042.test.ts`, then changes the rule. The test's expectations change in the same commit, and the Deltas name the behaviour change.

**A30. The first-drafts chain (item 30, missing): accepted.**
- `LaunchRepository.mergeBringup(id, partial)` runs `UPDATE channel_launches SET bringup = bringup || $2::jsonb, updated_at = now() WHERE id = $1 RETURNING *`. Every write after `ready` uses it. `||` is a shallow merge, so array keys are always written whole.
- After the mode step `doStart` runs `void this.firstDraftsChain(l).catch((e) => log(...))`. The chain does this:
  1. it awaits `planAhead` (073 plans today and tomorrow), then runs 072's `readiness.recheck(key, 'start')`;
  2. it lists the planned content slots of the channel in the next 48 h (`deps.plannedSlots(channelKey, now, now + 48 h)`, a read over `editor_slots`);
  3. `firstDrafts(slots, series, card, now)` (pure) picks the slots;
  4. it merges `bringup.firstSlots` (all picks, no outcome) before any run;
  5. `runFirstDrafts` (A3) runs the picks.
- After a restart mid-chain, the unrun picks stay `planned`, and the normal write-ahead writes them at `writeAt`.
- Approval alerts: one per (channel, plan date), claimed once the batch has no running slot and none due (`approval/approval-alerts.ts:33-50`, `approval/approvals.repository.ts:257-285`). A first draft from tomorrow's batch therefore sends that date's alert early with the drafts written so far. The rest of that date reaches the owner through the per-post owner-bot approval cards (`owner-bot/card-sources.ts:68`). The PG test asserts at most one `approval_alerts` row per picked date. See the open question.

**A31. Prompt blocks (item 31, ambiguity): accepted.**
- `buildSystemPrompt` joins entries that include blank lines (`roles/prompts.ts:95-125`).
- Each `PromptBlock.text` carries its own leading separator lines, so `blocks.map((b) => b.text).join('\n')` is byte-identical.
- The inputs `run` gathers (`roles/editor-runner.service.ts:353-371`) move into one private `systemPromptInputs(role, card, ctx, extras)`. `run` and `instructions()` both call it, so the view renders what `run` sends.
- The T8 golden test compares with the system prompt the `FakeLlm` records for planner, executor and reviewer fixtures. The network planner (`network/network-runner.ts:269`) keeps calling `buildSystemPrompt`.

**A32. The view has no side effects (item 32, regression risk): accepted, extended.**
- `executorContext(slot, { notify: false })` (`schedule/schedule.service.ts:312-327`) skips `sourceEmpty` (`:319`). It also skips the round roll: `nextRow` can roll a cycle round, which is a write (`schedule/next-row.ts:12-18`, `data/data-query.ts:389-404`).
- `nextInRound` gains `o?: { roll?: boolean }` (default true). The `nextRow` dep (`schedule.service.ts:66`) gains the same optional fourth argument. `notify: false` passes `{ roll: false }`.
- The runner dep `seriesContextRead` is wired next to `seriesContext` (`editor.module.ts:1631`).
- The T10 test asserts zero inbox rows, zero LLM calls, no `data_reuse_rounds` change on a cycle dataset with nothing left, and that `assessPlanned` (`preflight/slot-preflight.ts:252-261`) changed nothing on the fixture. If 076's merged pre-flight probes hosts, the view passes 076's `cacheOnly`.

**A33. Critic and skills blocks (item 33, ambiguity): accepted.**
- `criticUserPrompt` (`critic/critic.service.ts:143-193`) is split into `criticPromptBlocks(r): PromptBlock[]` and becomes their join, byte-identical (test).
- Blocks keep the `CAP` clipping (`:36`). `PromptBlock` gains `clipped?: boolean`, and the dialog badges a clipped block "clipped".
- The view builds the `CriticRequest` through the same `criticContextOf(...)` that `criticGate` (`editor-runner.service.ts:288-322`) uses.
- `inlineSkills` (`prompts.ts:34-50`) returns `{ inline, shown, voiceRef, overBudget }`. `overBudget` holds the names skipped because the body exceeded what was left; 073's merged change lists them.
- `PromptBlockSource` gains only blocks that exist: `'commitments'` (planner, `:116`), `'voice_ref'` (writer, `:121`) and `'critic_skills'`.

**A34. The critic's series note (item 34, missing): accepted, changed.**
- `seriesNote` does not travel in `AttemptOpts`, because `runPreview` passes no opts (`editor-runner.service.ts:685-707`) and `criticGate` spreads opts only when present (`:319`).
- It is a trailing parameter `seriesNote: string | null = null` of `criticGate`, `runTelegramExecutor` and `runPlatformExecutor`. Every caller passes the series note: `runExecutor` on its first attempt, every ladder step in `fallback` (the note re-read after a row is put aside, 071 R3), the evergreen step and `runPreview`.
- `CriticGateContext.seriesNote` → `CriticRequest.seriesNote` → «### Серія цього слота» after the brief line (`critic.service.ts:151`).
- `series-guard.test.ts:35` and `rules/config-conflicts.040.test.ts:174` stay green.

**A35. Tone and taboo (item 35, missing): accepted.**
- `agents/resource-profile.ts` gains `profileVoice(p): string | null`. It returns the `Тон:` and `Табу-теми` lines that `renderProfile` writes (`:195-196`), and `renderProfile` uses it, so the strings live once.
- `platformContext` (`network/network-runner.ts:321-339`) returns `profileVoice`. The profile is null when `slot.resourceRef` is null (`:325`), so `executorUser` (`editor-runner.service.ts:826-839`) passes `{ ...slot, resourceRef: slot.resourceRef ?? 'telegram:<key>' }`.
- Tests cover no profile (no block), a profile without taboo (tone line only) and a profile with both.

**A36. Checklist steps (item 36, missing): accepted, corrected.**
- There is no dashboard key mirror. `LaunchStep.key` is a `string` (`apps/dashboard/src/lib/launch.ts:6-13`), and `LaunchBody.tsx:35` renders every step.
- The server test that enumerates every step state (`launch.052.test.ts:316-323`) gains `readiness` and `first_outcomes` in T11.
- Reason text comes from a direct import of `reasonOfError` and `reasonFor` (073, pure), not through a dep. An unknown code shows the raw stored error, clipped to 120 characters.

**A37. The quiet card (item 37, missing): accepted, changed.**
- `postOnce` dedupes on `(kind, ref_type, ref_id)` (`agents/owner-inbox.ts:116-152`). So `refId` is the launch id, with no `:quiet` suffix; kind `launch_quiet` makes it unique.
- The dashboard needs no ref stripping:
  - `apps/dashboard/src/lib/inbox-kinds.ts` gains `launch_quiet`, next to `launch_graduated` (`:329`), with a `why` of 21–219 chars;
  - its steps are a link "Open launch" to `/app/artifacts` with search `{ type: 'launch', open: 'launch:' + base }`, and `read()`;
  - `inbox-kinds.test.ts` adds it to `BRIEF_KINDS` (`:86-92`) and to `FIXTURES` (`:34-64`, `{ agentId: 'o1', refType: 'launch', refId: 'l1' }`).
- New `launchQueries.waitingSince(key, since)` counts `awaiting_approval`/`approved` slots. It is exposed as `BringUpDeps.waitingSince`.
- `quietNotedAt` is merged once `notifyQuiet` resolves (an id or a duplicate's null), never when it throws.

**A38. Setup "Start in approval" (item 38, missing): accepted, corrected.**
- Apply's `failed` is `{ section, error } | null` (`setup/setup.service.ts:308-311`).
- After Apply, the service reads the card again. `next = { bot: LaunchBotState, mode: 'off' }` only when that card's mode is `off` and `failed` is null; otherwise `next` is null.
- `POST /api/channel-setup/proposals/:id/start`, body `{ force?: boolean }`, returns `{ started: boolean; waitingFor: 'bot_admin' | 'readiness' | null; blockers: Finding[]; bot: LaunchBotState }`. In order:
  1. The proposal must be `applied` or `partially_applied`, else 409 `not_applied`.
  2. The bot check runs. When the bot is not an admin: `started: false, waitingFor: 'bot_admin'`, nothing is stored, and the dialog keeps the box ticked.
  3. `trackOwn`.
  4. The gate is `channelDoctor(await loadChannelFacts(pool, key))`: errors minus `LAUNCH_GATE_IGNORED_CODES`. With blockers and no `force` the answer is `waitingFor: 'readiness'`. There is no drift: setup has its own Replace rule.
  5. `setMode(key, 'approve', { replan: false })`, then `planAhead` in the background, then `readiness.recheck(key, 'start')`.
- The bot check, `setMode`, `planAhead` and `trackOwn` come from one module-level builder used by both factories, `launchModeOps(pool, repos, ops, infra, runner, channelConfig, tracking?, trackedRepo?)`, not copies.
- The setup factory appends `{ token: EDITOR_RUNNER, optional: true }`, `{ token: READINESS_SERVICE, optional: true }`, `{ token: ChannelConfigService, optional: true }`, `{ token: TrackingService, optional: true }` and `{ token: TrackedChannelsRepository, optional: true }`. `ChannelSetupDeps` gains `start?: SetupStartDeps` and `readiness?`; without `start`, the endpoint answers 503 `unavailable`.

**A39. Where the checkbox lives (item 39, ambiguity): accepted.**
- `doApply` lives in `ProposalBody` (`components/setup/SetupProposalDialog.tsx:36-80`), which `ArtifactPanel` also renders (`ArtifactPanel.tsx:97-102`).
- `ProposalBody` gains an optional prop `onApplied?: (r: ApplyResult) => void`:
  - `SetupProposalDialog` passes it. On an Apply with `next` it keeps the dialog open on its own "Next" step: the bot line, an unticked "Start in approval" and **Done**, all in the dialog's state.
  - Without the prop (the artifact panel), `ProposalBody` shows the bot line from `next` and the hint "Start it in approval from the Setup page" as a `callout-info` under the sections.
- Closing by X, Esc or the backdrop starts nothing.
- The owner-bot setup card's `act('apply_all')` (`owner-bot/card-sources.ts:225-233`) appends `botLineUk(key, next.bot)` and «Канал вимкнений: запустіть його в режимі схвалення на сторінці Setup.» when `next` is set. `SourceDeps.setup.apply`'s type gains `next?`.

**A40. T3/T4 overlap (item 40, task order): accepted.**
- T3 routes `extra` through `buildExtra(plan, material, ctx)` (`bring-up/extra.ts`), with today's checks.
- T5 fills in the real context. The setup `extra` calls the same function with `material = null`.

**A41. Split of T4 (item 41, task order): accepted.** Old T4 becomes:
- T5: real-context `extra`, the would-be check and the baseline stored at ready, with no Start change;
- T6: the Start gate, drift, staleness, `force`, the route, artifact actions and the owner-bot card.

The Start writes (`startWrites`, sources, the patch step, `mergePlaybook`) are T4.

**A42. Prompt task order (item 42, task order): accepted.**
- The order is T8 (blocks) → T9 (prompt fixes) → T10 (instructions endpoint).
- T9 updates the T8 goldens in the same commit wherever the owner-rules precedence line (`rules/owner-rules-prompt.ts:30`) appears. The series-guard line (`schedule/series-guard.ts:110`) is in the user note, not the system prompt.

**A43. Shapes first; split dashboard tasks (item 43, task order): accepted.**
- `LaunchView` additions, `StartResult` and `BringUpDeps` are defined in T1.
- The dashboard work is four tasks: T13 launch panel, T14 checklist outcomes and inbox kind, T15 Instructions section, T16 setup "Start in approval".

**A44. 052 tests (item 44, regression risk): accepted.**
- All new deps are optional (A6, A26). Migration 101's defaults cover rows inserted by `launch.052.pg.test.ts`.
- Only these 052 expectations change: `parseLaunchArgs` (T2) and the checklist state map (T11).
- Both 052 files run after T1, T2, T6 and T11.

**A45. @pdr_dev_channel replay (item 45, regression risk): accepted, corrected.**
- The fixture's stored state holds the owner rule «poll з correct_index» and a playbook section with quiz weight 0.
- The would-be playbook replaces that section's formats with the plan's (`mergePlaybook` `formatMix`). `reconcilePlan` adds quiz at 0.2, so the replay expects the poll-rule finding at plan-ready, asserted by the code the merged 072 gives it. It also expects **no** quiz-weight finding: code fixed it.
- The body's "playbook quiz weight 0 shows as a finding" is withdrawn.

**A46. Dashboard rules (item 46, regression risk): accepted.**
- Static labels are English.
- Server prompt text (Ukrainian) appears only inside `<pre>` bodies of the details dialogs, and finding and outcome text comes from the English reason mirror.
- Every new block renders an empty state on 404 or empty data. It works at 375 px and has no inline colour (area classes).
- Pure helpers in `src/lib/*.ts` carry the node:test cases for 404 and empty data.

### Types after the amendments

These replace the body's Types block. Each takes its own `// FR` line in the code.

```ts
// launch/bring-up/bring-up.types.ts
export const LAUNCH_MAX_DATASETS = 3, LAUNCH_MAX_SOURCES = 10, LAUNCH_PLAN_STALE_DAYS = 7;
export const FIRST_DRAFTS_MAX = 6, FIRST_DRAFTS_WINDOW_H = 48, LAUNCH_QUIET_HOURS = 24, LAUNCH_EXISTING_POSTS_WARN = 20;
export const MATERIAL_READ_TIMEOUT_MS = 20_000, START_REFUSAL_WINDOW_MS = 30 * 60_000;
export const LAUNCH_GATE_IGNORED_CODES = ['bot_not_admin'] as const;

export interface MaterialDataset {
  key: string; ok: boolean;
  error?: 'unknown_dataset' | 'dataset_not_active' | 'bind_failed' | 'read_failed'; errorText?: string;
  entity: string; rows: number; postable: number | null; unposted: number | null;   // postableCount (075)
  fields: Array<{ name: string; type: string; role: string | null }>;
  samples: Array<Record<string, unknown>>;                                            // ≤3, values ≤300 chars
  publish: PublishProfile | null;                                                     // data/data.types.ts (075)
  bind: DatasetBindPlan | null;                                                       // bindDatasetPlan (075)
  expect: { post_requires: unknown; publish: unknown } | null;                        // 075's stale check at Start
}
export interface MaterialSource { url: string; probe: ProbeResult | null; note?: string }
export interface LaunchMaterial {
  requested: { datasets: string[]; sources: string[] };
  datasets: MaterialDataset[]; sources: MaterialSource[]; readAt: string | null;
}
export interface BringUpCheck { at: string; planErrors: string[]; findings: Finding[]; blockers: number; warnings: number; drift: string[] }
export interface FirstSlot {
  slotId: string; series: string | null; format: string;
  outcome?: 'ran' | 'not_planned' | 'paused' | 'unavailable' | 'editor_off' | 'failed'; note?: string;
}
export interface LaunchBringUp {
  set: string[];
  baseline?: Record<string, unknown> | null; written?: string[];
  ready?: BringUpCheck; start?: BringUpCheck;
  forced?: { at: string; blockers: number; drift: string[] } | null;
  startRefusedAt?: string | null; startRefusedKey?: string | null;
  firstSlots?: FirstSlot[]; quietNotedAt?: string | null;
}
export interface FirstOutcome { slotId: string; series: string | null; status: string; reason?: string; fix?: string }
/** What launchJson / view add (A15). */
export interface LaunchViewBringUp {
  material: LaunchMaterial; bringup: LaunchBringUp; set: string[]; check: BringUpCheck | null;
  firstOutcomes: FirstOutcome[]; ageDays: number | null;
}
/** Reads behind FR-001 (A4, A11, A16). */
export interface MaterialDeps {
  schema(key: string): Promise<DataSchema | null>;                       // DataStore.getSchema
  sampleRows(schemaId: string, n: number): Promise<Array<Record<string, unknown>>>;
  postable(key: string, resourceRef: string): Promise<{ rows: number; postable: number; unposted: number; repeats: boolean }>;
  bind(channelKey: string, key: string): Promise<DatasetBindPlan | Fail>; // bindDatasetPlan with 075's BindDeps
  probe(url: string): Promise<ProbeResult>;                               // sourceProberOf(pool)
}
/** Optional on LaunchDeps (`bringUp?`): a feature is skipped when its dep is absent (A6, A26). */
export interface BringUpDeps {
  material?: MaterialDeps;
  postCount?(channelKey: string): Promise<number>;
  context?(channelKey: string, wouldBeCard: WouldBeCard): Promise<{ resources: Array<{ ref: string; platform: string }>; telegramFormats: string[]; catalog: SeriesSourceCatalog }>;
  facts?(channelKey: string): Promise<ChannelFacts>;                      // loadChannelFacts (072)
  applyDatasetPatch?(p: { dataset: string; patch: unknown; expect: unknown }): Promise<{ ok: boolean; error?: string }>; // 075
  plannedSlots?(channelKey: string, from: Date, to: Date): Promise<EditorSlot[]>;
  firstDraftGate?(slot: EditorSlot): Promise<'paused' | 'unavailable' | null>;
  writeNow?(slotId: string): Promise<unknown>;                            // ops.runSlot(id, { wait: true })
  slotStates?(ids: string[]): Promise<Array<{ id: string; status: string; error: string | null }>>;
  readinessRow?(channelKey: string): Promise<{ blockers: number; warnings: number; checkedAt: string } | null>;
  recheck?(channelKey: string, reason: 'start' | 'owner'): Promise<unknown>; // READINESS_SERVICE
  waitingSince?(channelKey: string, since: Date): Promise<number>;
  notifyQuiet?(l: ChannelLaunch): Promise<number | null>;                 // inbox.postOnce, kind launch_quiet
}
```
- `launch.types.ts`: `ChannelLaunch` gains `material: LaunchMaterial` and `bringup: LaunchBringUp`, and exports `StartResult` (A20).
- `PromptBlock` gains `clipped?: boolean`. `PromptBlockSource` gains `'commitments' | 'voice_ref' | 'critic_skills'` (A33).
- `SlotInstructions` is unchanged otherwise.

### Open for the lead

1. **The approval alert on a first-drafts day (A30).** A first draft from a batch date sends that date's one batch alert early, and the rest of the date gets no batch alert. Per-post owner-bot approval cards still arrive.
   - The alternative is to re-alert in `approval-alerts.ts` when `waiting` grows: about 5 lines, another subsystem.
   - Recommended: accept for 077 (the early alert is the owner's first look) and note it in the runbook §37. Do not change `approval-alerts.ts`.

## Lead decisions after the integration review (2026-10-29)

These override everything above, including the Amendments. They come from a cross-spec review of all six specs (the item numbers I1… are that review's).

- **I7:** `reconcilePlan` adds no series format to `format_mix`. If `validatePlaybook` still needs a section key, add it at weight 0. Relax `checkLaunch`'s rule that a series format must be in `format_mix`, to match 073. The A45 replay expects no poll-rule finding.
- **I8:** before Start, `LaunchBody` shows a Readiness panel fed by `bringup.ready.findings`; its fixes route to the launch's own fixes (edit plan, source actions). After Start, 072's stored-row panel takes over.
- **Owner-flow gaps:**
  - the dataset drawer "Use in a channel" (075) gets a "New channel from this dataset" entry that opens `/launch` with `from dataset <key>` prefilled;
  - the launch panel wires 076's source fixes (Remove, Route via proxy, Upload the page) for failed sources, and re-runs the material read and plan-ready after any of them.
- **I1:** the `roll` option of `nextInRound` already exists after 073. 077 only adds `executorContext({ notify: false })`.
- Use `postableCount(pool, { id?, key? }, resourceRef)`, 075's exported `chooseBindSeries` and `applyDatasetPatch`, and `sourceProberOf(pool)`, never a bare `probeSource(url)`.
- The early approval batch alert for first drafts is accepted: no change in `approval-alerts.ts`, a line in runbook § 37, and a PG assertion of at most one `approval_alerts` row per picked date.
