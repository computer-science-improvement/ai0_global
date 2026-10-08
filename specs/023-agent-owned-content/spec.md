# 023: Agent-owned content: strategies become agent tools; the agent sets the schedule (chat, manual override)

**Status:** SPEC · **Depends on:** 009 (T001–T003), 018, 020, 021 · **Supersedes/extends:** supersedes 009 T004–T006; extends 020 (series), 018 (chat cards)
**Owner comments addressed:** #2, #4, #5 (plans/brd-comments-2026-10-06.md)
**Migrations:** `059_schedule_rules.sql`, `060_content_ledger.sql`

## Why
The owner wants the strategy pattern gone:
- #2: «у агентів просто будуть доступні бази данних і вони самі вирішуватимуть що публікувати»;
- #4: «агент повинен задавати розклад + цим можна буде управляти у чаті, або вручну … процес побудови стратегії повинен бути винесений на рівень tool_call»;
- #5: generating from a source is «можливість яку агент може або викликати або ні».

Today cron strategies publish without review, while agents cannot see the knowledge bases, change the schedule only by
rewriting the whole playbook, and cannot be steered from chat. This spec makes the agent the only content engine:
- every strategy capability is a tool the agent may use or ignore;
- "building a strategy" becomes series tool calls stored in the playbook;
- the owner steers the schedule through chat cards or schedule rules in the UI, and the planner must respect them;
- the existing bindings move into series proposals (shadow-first, owner approval) and are then retired.

## Current state (as-is)
- **18 strategy types** (BRD 02 §4.1): `strategy_bindings` rows (cron, destination, `params`) that publish without
  review once enabled (§3.1); cron runs in `SCHEDULER_TZ`, UTC by default (§4.3).
- **009 T001–T003 are done:** `fetch_api` (7 adapters, `tools/api-adapters/*`), `search_library` (12 tables,
  `tools/library-tables.ts`), all 8 formats. Digests have no tool (`get_network_highlights` was never built).
- **Series.** `network/playbook.ts` `SeriesSchema` has `{name, cadence daily@|weekly:<day>@, resource_ref, format,
  brief, active}`, but no source and only one day and one time. Agents change series only by resubmitting the whole
  body (`submit_playbook`, BR-AGT-51…53). `network-plan.ts` checks that a named series is due, but never requires a due
  series to be planned. The single-channel planner (`roles/plan-rules.ts` `validatePlan`) ignores series entirely.
- **Chat steering.** `agents/pending-actions.ts` has agent, brief, profile, skill and directive cards, but no playbook or
  schedule card (BRD 04 §3.7). The owner can only reserve one-off posts (`schedule_draft`, BR-EDT-42).
- **Dedup is split across 4 ledgers:** the `posted` JSONB per content table, `posted_news` (global by URL),
  `published_posts.source_url` and `platform_posts.source_ref`.
  - Strategies write `image_url` or the quote URL as `source_url`; the editor writes `library://…`. So the editor can
    repost a recipe a strategy already posted.
  - The windows differ: `publish_post` blocks forever, including shadowed slots (`editor-plans.repository.ts`
    `sourceAlreadyPosted`); chat uses 7 days (`chat/drafts.service.ts` `DEDUP_DAYS`); platform posts use 7 days
    (`platform/publish-platform.ts`).
  - `on-this-day` can publish a date only once in the system's history (§4.4).
- **Runway.** `ContentRunwayService` counts unposted items for 8 types, shown only on channel pages (BR-PUB-10);
  agents see nothing but `sql_readonly`.

## Functional requirements
| ID | Requirement |
|----|-------------|
| FR-001 | **Migration `059_schedule_rules.sql`.** <br>• `schedule_rules(id uuid pk, agent_id uuid fk agents, resource_ref text not null, kind text check in (pin, blackout, frequency), days smallint[] null` (0 = Sunday; null = every day)`, at_local text null` (HH:MM)`, until_local text null` (blackout end)`, window_min int default 20 check 0–120, format text null, series_name text null, brief text null, source jsonb null, per_day_min int null, per_day_max int null, valid_from date null, valid_until date null, active bool default true, created_by text check in (owner, chat), note text, created_at, updated_at)`, indexed on `(agent_id, active)`. <br>• `editor_slots` gets `schedule_rule_id uuid null` and `series_name text null`. <br>• `strategy_bindings` gets `retired_at timestamptz null`, `retired_reason text null` and `migrated_to jsonb null` (`{agent_id, playbook_id, series[]}`). <br>• The `playbooks.created_by` check adds `migration`. |
| FR-002 | **Series v2** (`playbook.ts`; old bodies parse with defaults). <br>• `cadence`: `daily@HH:MM[,HH:MM]` or `weekly:mon[,thu]@HH:MM[,…]`, at most 6 times, in the resource timezone (the card's `timezone`, default Europe/Kyiv). <br>• `source` (optional), one of: `{kind:'library', table, category?, query?, today_only?}`, `{kind:'api', source, params}`, `{kind:'feed', ref}`, `{kind:'network_highlights', scope}` or `{kind:'free'}`. It is validated against `LIBRARY_TABLE_NAMES`, the adapter names and the card sources. <br>• `source_mode`: `suggested` (default) or `required`. <br>• `origin`: agent, owner or migration. `locked` (bool) is set by code whenever the owner creates or edits a series. `migrated_from` is the binding `ext_id`. <br>• New validation: no series time in quiet hours, and the series instances per day on a resource must not exceed `per_day.max`. |
| FR-003 | **Series tools for the orchestrator.** <br>• `list_series`, `define_series({name, cadence, resource_ref, format, brief, source?, source_mode?, rationale})`, `update_series({name, patch, rationale})`, `set_series_active({name, active, reason})` and `retire_series({name, reason})`. <br>• Each builds the next body from the active version (or from the agent's own pending draft) and goes through `validatePlaybook` + `classifyPlaybookChange` and the existing submit path. <br>• Classification changes: a time shift of 90 min or less on the same days, or a source change within the same kind, is non-structural. Adding, removing, or changing days, resource or format is structural and goes to `pending_owner` with a card. <br>• On a `locked` series the tools return `series_locked`, and the agent may raise it in its run summary. <br>• At most 5 mutating series calls per run. `submit_playbook` stays for full rebuilds. Directive kind `pause_series` (021) is applied through these tools. |
| FR-004 | **Planners honour series and rules** (both `validatePlan` and `validateNetworkPlan`). <br>• **Pins.** Before the planner runs, code materialises each active `pin` due that date as an `editor_slots` row: `kind='content'`, `schedule_rule_id`, the pin's format, topic = the pin brief (or its series brief), `source_hints` from the source. It is idempotent per (rule, date). The planner sees pins as fixed slots: it cannot move or drop them, and they count toward `per_day`. <br>• **Blackout.** A planned slot inside a blackout window is a validation error, and the executor re-checks it in live. Reserved (ad) slots are not blocked; creating one inside a blackout returns the warning `blackout_window`. <br>• **Frequency.** The rule overrides the playbook `per_day` and the card's `postsPerDayMin/Max` for that resource and date range. <br>• **Due series.** A slot gains `series`, and the plan gains `skipped_series[{name, reason ≥ 10 chars}]`. Each due active series must be planned within ±90 min of its time or listed as skipped. A `locked` series cannot be skipped. Series slots store `series_name`. |
| FR-005 | **Series slot execution.** <br>• The executor gets the series brief, source and `source_mode`. <br>• `suggested`: the prompt says the source is optional. The agent may pick another source or format (within the playbook) and states why in `notes`. <br>• `required`: the publish guard checks that the PostSpec's `library_ref` table or source URL matches the series source, and returns `series_source_mismatch` otherwise. <br>• An exhausted `required` source → `skip_slot` plus an owner inbox item `series_source_empty`. |
| FR-006 | **Chat steering** (composer and agent chat only; never in autonomous runs). <br>• `get_schedule({resource_ref?, days ≤ 7})` (read): series with origin and locked flag, rules, planned slots for the next 48 h, and reserved slots. <br>• `propose_series_change({op: add, update, pause, resume or remove, series})` → card `series_change`. Apply writes an owner playbook version (`created_by='owner'`, active immediately, BR-AGT-53) with the series `locked`, and supersedes the agent's pending draft. <br>• `propose_schedule_rule({op: add, update or disable, rule})` → card `schedule_rule`. <br>• `propose_slot_change({slot_id, op: move or skip, to_local?})` → card `slot_change`, for planned content slots within 48 h. <br>All require an explicit request in the owner's last message (BR-EDT-38 verb check). The card shows a human diff («Рецепт дня: щодня 19:00 → 20:30»); the payload is validated at propose and at apply, and a stale card → `failed`. |
| FR-007 | **Manual schedule UI.** <br>• A new agent tab **Schedule** (`?tab=schedule`): a 7-day grid with one lane per resource, showing projected series instances (agent vs owner-locked), pins, blackouts, frequency overrides, planned and reserved slots. <br>• Forms to add, edit and disable rules; inline series edit (which locks the series); and **Unlock** (which hands the series back to the agent). <br>• REST (`TrackingAuthGuard`): <br>&nbsp;&nbsp;– `GET /api/agents/:handle/schedule?from&to` <br>&nbsp;&nbsp;– `POST/PATCH /api/agents/:handle/schedule-rules[/:id]` <br>&nbsp;&nbsp;– `PUT /api/agents/:handle/series/:name` <br>&nbsp;&nbsp;– `POST /api/agents/:handle/series/:name/unlock` <br>• One `ScheduleService` holds the validation shared by REST, cards and tools. Times display in the resource timezone with its label. |
| FR-008 | **`library_catalog({resource_ref?, tables?})`** (read, all roles). <br>• Per library table: a code-owned description; counts of total, usable (not error-marked), unposted on this resource and unposted network-wide (all from the FR-010 ledger); today-items for dated tables; the top 10 categories with unposted counts; the license mix; when it was last used here; the reuse policy; and `runway_days` (unposted ÷ expected daily use from active series plus 28-day usage). <br>• Also `apis` (name, description, `configured: bool`, never key values) and card feeds. Cached 10 min; a ≤ 1,500-char summary goes into orchestrator and planner prompts. <br>• `runway_days < 14` for a table that an active series uses → owner inbox `low_runway` (once per table per 7 days). This replaces `ContentRunwayService` for agent channels. |
| FR-009 | **Capability parity.** <br>• `get_network_highlights({scope: channel or network, date?, strategy_types?, min_items 3–8})` reuses the selection logic of `network-digest` and `topic-digest`, moved to `src/common/digests/`. <br>• A new shared skill `content-sources`: sources are optional tools; read the catalog first; pick the source and format per post; never invent facts without a source. <br>• Editor prompts drop the "strategy" wording. |
| FR-010 | **Unified ledger (`060_content_ledger.sql`).** <br>• `content_ledger(id bigserial pk, resource_ref text, source_ref text, origin text check in (strategy, editor, chat, platform, manual, backfill), status text check in (published, shadowed, error), published_post_id bigint null, platform_post_id bigint null, slot_id uuid null, used_at timestamptz, unique(resource_ref, source_ref, status))`, indexed on `source_ref`. <br>• Canonical `source_ref`: `library://<table>/<id>`, or a normalised URL (lowercase host, no `utm_*`, no fragment), or `digest://…`. <br>• `ContentLedger.record()` is called from every publish path: `publish_post`, platform publish, chat publish, `ReservedDispatcher`, and legacy strategies (through `PublishedPostsRepository`, mapping each row id to `library://`). <br>• `ContentLedger.check(resource_ref, source_ref, scope?)` replaces `sourceAlreadyPosted`, `DEDUP_DAYS` and `PLATFORM_DEDUP_DAYS`. The rules: published library items never repeat on a resource; dated tables (`on_this_day`, `birthdays`, `name_days`) may repeat after 300 days; a URL never repeats on a resource; `shadowed` blocks the same resource for 7 days only; `error` excludes the item everywhere. <br>• An idempotent backfill reads `posted` JSONB (`<channel_key>` → `telegram:<key>`; `TELEGRAM` → every Telegram channel that had a binding of that type; `IG:/FB:/TH:/TT:<uuid>` → the resource ref; `error:*` → error), `posted_news`, `published_posts` and `platform_posts`. <br>• `search_library` and `library_catalog` read only the ledger. The legacy columns stay read-only and are archived later (non-destructive). |
| FR-011 | **Binding migration** (deterministic, no LLM). <br>`StrategyMigrationService.propose(channelKey)` maps every enabled binding on the channel or its network: <br>• **cron → cadence:** a fixed minute, an hour list or step, a day-of-week list or `*`, with day-of-month and month `*`. Quiet-hour times are dropped. The digest retry cron `*/10 19-20` becomes one time, 19:00. More than 6 times a day, or minute steps, become a frequency hint (`per_day` from 14 days of `published_posts`) plus a pillar note, not a series. <br>• **type → format/source:** quotes → text, library quotes; facts → photo, facts; pdr-quiz → quiz, pdr_questions, `required`; recipes → photo, recipes; recipe-carousel → carousel, recipes; ai0-prompts and curated-prompts → photo, prompts (`provider`/`mediaType` → category); assets → text, assets (`dataSource`); birthday-strategy → photo, birthdays `today_only`; on-this-day → photo, on_this_day `today_only`; ai0-news, ua-news and game-channel → photo, feed or api (`feedUrl`/`sources`); space-news, daily-photo and movies → photo, api adapter; network-digest and topic-digest → text, network_highlights. <br>• **Output:** a playbook draft (`created_by='migration'`, `pending_owner`) = the active playbook (or a minimal one from the card) plus the migrated series (`origin='migration'`, unlocked). Its rationale holds a per-binding table (`ext_id`, cron → cadence, type → format/source, warnings) and an "unmappable" list (for example, a Meta or TikTok destination in a `mirror` network). <br>• **Triggers:** "Migrate to agent" on `/app/strategies` or `@ai0` (card `migrate_strategies`); `migrate:strategies --dry-run` prints proposals without writing. In shadow, the bindings keep publishing. |
| FR-012 | **Cutover and guard.** <br>• **Cutover card.** `strategy_cutover` is offered after 7 or more days in shadow with 80% or more of the series instances shadowed. One transaction sets the card and agent to `approve` (spec 031; the owner switches to `live` later) and sets the bindings to `enabled=false, retired_at, retired_reason='migrated', migrated_to`, then publishes `config:changed`. It is refused while `EDITOR_ENABLED≠true`. <br>• **Live guard.** Any other switch to `live` (`EditorChannelsRepository` mode change, `AgentsService.patch`) returns `409 bindings_still_enabled` (listing the `ext_id`s) while an enabled binding targets the same destination. <br>• **Rollback.** Re-enabling a retired binding returns `409 binding_retired`. The rollback card `strategy_rollback` puts the agent back to shadow and re-enables the migrated bindings. |
| FR-013 | **`/app/strategies` lifecycle.** <br>• **Phase A (read-only legacy):** a banner ("content is run by agents", per-channel Migrate buttons); Add is hidden; `POST /api/strategies` → `410 strategies_legacy`; `PATCH` only allows `enabled:false` and `notes`; retired rows are greyed out with a link to the agent's series. The menu item moves under "Legacy". On the Overview, "Active strategies / Upcoming runs" become "Upcoming slots" (series and pins). <br>• **Phase B (009 T005):** a type with no enabled binding for 14 days loses its module, tests, preview and runway counter (an owner-approved PR). Once no binding is enabled anywhere for 14 days, `/app/strategies*` redirects to `/app/agents` and the strategy scheduler is removed. `strategy_bindings` and `strategy_runs` stay as history. |

## Corner cases
- **A pin within the gap of an ad slot.** Both are owner commitments: both stay, and the API returns the warning
  `conflicts_with_reserved`.
- **A pin inside quiet hours.** It is allowed because the owner set it explicitly; the UI warns.
- **A locked series vs a manager `pause_series` directive.** The orchestrator rejects it with `reason_kind=owner_rule`
  (021 FR-008).
- **Two pending cards for one series.** The second to apply re-validates against the current version and fails as
  stale.
- **A pending migration draft vs the agent's own submit.** The agent gets `migration_pending`, and the migration draft is
  never silently superseded.
- **A binding on a channel without an editor card.** The proposal is refused with `no_agent`; `@ai0` first offers
  `create_agent`.
- **DST.** A non-existent local time moves to the next valid minute (`zonedToUtc`).
- **The kill switch.** With `EDITOR_ENABLED=false`, pins are materialised but never executed. Cutover is refused, so
  retiring bindings can never leave a channel silent unintentionally.

## Non-goals
- New platforms (#3) and per-resource timezone management (#8). This spec only reads the card timezone.
- Directive vs advice (#7) and unique vs duplicated posts per resource (#6). Those belong to separate specs; 019/020 already
  plan native variants.
- New datasets or scrapers.
- Dropping the `posted` and `posted_news` columns (they are only archived later).
- `/app/calendar` and manual `scheduled_publications` (manual posts are a separate path).

## Success criteria
- **Unit tests:** series v2 validation and the time-shift classification; locked-series tools; pin materialisation,
  blackout, frequency and due/skip rules in both planners; the `required`-source guard; card staleness for all 3 kinds;
  cron → cadence (incl. `*/10 19-20`, `0 */4`, `*/30`) and the type mapping; ledger canonicalisation, reuse policy and
  shadow window; the live guard and the cutover transaction.
- **PG tests:** backfill from all 4 legacy ledgers (strategy-posted items are not offered by `search_library`);
  proposal → approve → shadow plan contains the series → cutover retires the bindings; a second live switch is refused.
- **Live evals:** `chat-series-change` («рецепти о 20:30 по буднях» → a correct card), `planner-honours-pins`,
  `executor-suggested-source-exhausted` (picks another source, explains why), `ideas-catalog-aware`.
- **Owner dry run:** the dry run on the live DB maps at least 90% of the enabled bindings, and the rest are listed with
  a reason.

## Open questions for the owner
1. ~~May the agent shift a series time by 90 min or less without a card?~~ **Decided 2026-10-06 (spec 031):** only in
   `live`. A resource in `approve` mode (the default for new resources) sends a card for every schedule change.
2. **Is a dedicated `content_ledger` acceptable** instead of "published_posts as the single source" (009 T006)?
   `published_posts` is Telegram-only and needs a `message_id`. Default: a new table.
3. **Should an owner edit lock the series until "Unlock"?** Default: yes.
4. **Should high-frequency news bindings (hourly) become a frequency hint plus a source, rather than a series?**
   Default: yes.
5. **Cutover offer threshold?** Default: 7 days in shadow and 80% of the series instances shadowed.

## Task breakdown

### T1: Unify the dedup ledger
**Scope:**
- `060_content_ledger.sql` plus the idempotent backfill from the 4 legacy ledgers.
- `ContentLedger` (record, check, reuse policy, canonical refs) in every publish path, replacing the 3 dedup checks;
  `search_library` reads it.

**Acceptance:**
- [ ] Backfill PG test passes; a rerun is a no-op.
- [ ] A strategy-posted item is excluded from `search_library` on that channel.
- [ ] `on_this_day` reusable after 300 days; shadowed items blocked 7 days only.

**Size:** L · **Depends on:** 009 T001

### T2: Give agents a library catalog and network highlights
**Scope:**
- `library_catalog` (ledger counts, cache, prompt summary).
- `get_network_highlights` with digest logic moved to `src/common/digests/`.
- The `content-sources` skill; `low_runway` inbox items.

**Acceptance:**
- [ ] Catalog matches fixture counts and contains no secrets; summary ≤ 1,500 chars.
- [ ] `low_runway` fires once per table per 7 days.

**Size:** M · **Depends on:** T1

### T3: Extend series and give the orchestrator series tools
**Scope:**
- Series v2 schema (backward compatible).
- The 5 series tools through the submit path; the ≤ 90-min shift classification; `pause_series` via the tools.

**Acceptance:**
- [ ] Old bodies parse unchanged; a locked series → `series_locked`.
- [ ] A structural change → `pending_owner` plus a card; a 60-min shift applies at once.

**Size:** M · **Depends on:** 020, 021

### T4: Make both planners honour series and schedule rules
**Scope:**
- `059_schedule_rules.sql`; pin materialisation.
- Blackout, frequency and due/skip rules in both validators; `series_name`/`schedule_rule_id` on slots.
- Executor series context and the `series_source_mismatch` guard.

**Acceptance:**
- [ ] A plan missing a due locked series is rejected; pins appear once per date.
- [ ] A blackout slot is rejected at planning and in the live executor.

**Size:** L · **Depends on:** T3

### T5: Let the owner steer the schedule from chat and the Schedule tab
**Scope:**
- The 4 chat tools and 3 card handlers.
- Schedule REST with the shared `ScheduleService`.
- The **Schedule** tab (7-day lanes, rule forms, series edit, Unlock).

**Acceptance:**
- [ ] Without an explicit request → `needs_explicit_request`.
- [ ] Apply creates an owner version with a locked series; a stale card fails.
- [ ] `chat-series-change` eval passes.

**Size:** L · **Depends on:** T4, 018

### T6: Migrate strategy bindings into series proposals
**Scope:**
- `StrategyMigrationService` (both mappers, unmappable reasons) and the `--dry-run` CLI.
- The migrate, cutover and rollback cards; the retirement columns; the `bindings_still_enabled` guard.

**Acceptance:**
- [ ] The dry run writes nothing; cutover is one transaction (live + bindings retired).
- [ ] A live switch with an enabled binding → 409; rollback restores the bindings.

**Size:** L · **Depends on:** T1, T3, T4

### T7: Turn /app/strategies into read-only legacy, then remove it
**Scope:**
- Phase A: read-only legacy UI and API (FR-013), the "Upcoming slots" Overview card.
- Phase B (owner-gated PRs): delete idle strategy modules, redirect the route, remove the scheduler and
  `ContentRunwayService`.

**Acceptance:**
- [ ] No UI path can create or enable a binding.
- [ ] After phase B, `/app/strategies` redirects and `pnpm --filter automation test` stays green.

**Size:** M · **Depends on:** T6

## Implementation notes (T1, 2026-10-07)
Built on `feat/editor-agent` after spec 032 (data store) and 031 (approval mode); commit `feat(content): 023-T1 …`.

- **Migration `060_content_ledger.sql`** (059 stays free for T4's schedule rules). Table as in FR-010 plus a `note`
  column (the reason of an `error` row). The rules live in SQL, so the publish guards and the row filters of
  `query_data` / `library_catalog` cannot disagree: `content_ledger_blocks()` (one predicate),
  `content_ledger_blocking()` (guards) and `content_ledger_used()` (query CTE). `content_ref_canonical()` resolves
  a `library://` alias to `data://` (032 FR-011), lower-cases the scheme and host, drops `utm_*` and the fragment.
- **Reuse policy from the schema (032 FR-011).** 060 moves the dated datasets (`on_this_day`, `birthdays`,
  `name_days`) from the 058 seed of 365 days to 300 days when still at the seed value: a 365-day window blocks the
  same date next year whenever it is posted earlier in the day.
- **Writers.** `ContentLedger.record()` (TS, best-effort after a send) is called from
  `EditorPlansRepository.insertPublication` (publish_post, the chat, the approval publisher and the sponsored
  path; origin editor / chat / manual; every ref of the spec, not only `source_url`), `updateSlot(status: shadowed)`,
  `PlatformPostsRepository.insert/settle` (origin platform) and `PublicationsRepository.insert` (legacy
  strategies, the URL). The two legacy ledgers strategies still write feed the ledger through **triggers**:
  `data_items.posted` (markers written through the 058 views; this records the library row itself, also for Meta /
  TikTok destinations that never reach `published_posts`) and `posted_news`. Triggers swallow their own errors so
  a ledger problem never fails a publish.
- **Checks.** `sourceAlreadyPosted` (publish_post; now ledger + waiting posts of spec 031),
  `sourceUsed` (chat; replaces `sourcePostedSince` and `DEDUP_DAYS`), `publishedSource` (approval re-check;
  published only) and the platform `alreadyPosted` (source via the ledger; the same-idea repeat keeps a 7-day
  window, `PLATFORM_IDEA_DEDUP_DAYS`) all call `ContentLedger.check()`. Waiting / approved posts are not ledger
  statuses; `check({ waiting: true })` and `usedRefsCte()` still read them from `editor_slots` / `platform_posts`.
  Behaviour change: a shadow preview now holds its source 7 days (it held it for ever on Telegram and not at all on
  platforms); the chat's 7-day window became the ledger rules.
- **Backfill mapping.** `TELEGRAM` → every Telegram channel with a binding of the dataset's strategy types
  (`recipes`/`recipe-carousel`, `ai0-prompts`/`curated-prompts`, …); with no such binding it becomes the wildcard
  `telegram:*`, which counts only network-wide. Editor slots (shadowed and published, both refs of the spec) are
  backfilled too. `query_data`, `search_library`, `library_catalog`, the items browser's "Posted N×" badge, the
  stats' `unposted_network` and import undo's "used" now read only the ledger.
- **Not dropped:** `data_items.posted` and `posted_news` stay (strategies still write them and the triggers mirror
  them); drop them after the strategies are retired (T6/T7), as 032 FR-009 says.
- **Production migration.** On a synthetic DB with 60k marked rows (175k markers), 100k `published_posts`, 30k
  `posted_news` and 5k platform posts the backfill wrote 310k rows (108 MB with indexes) in ≈ 14 s on a laptop;
  the rerun is a no-op (≈ 8.5 s). `content_ledger_used()` for one resource ≈ 0.17 s on that data. 060 runs in one
  transaction, so the deploy holds writes to the touched tables for that time.

## Implementation notes (T2, 2026-10-07)
Commit `feat(content): 023-T2 …` (committed after T3, which it builds on for series sources). 032 T6 already
built `library_catalog` from `data_schemas` and `query_data`; T2 adds only what FR-008/FR-009 still needed.

- **Catalog additions** (`editor/tools/catalog-context.ts`): the overview now carries `apis` (name, what it
  returns, `configured` from the presence of `TMDB_API_KEY` / `NASA_API_KEY` — never a value; NASA counts as
  configured because it falls back to `DEMO_KEY`) and the card's `feeds` (rss / url sources). Per dataset on the
  asking resource: `last_used_here` and `runway_days` = unposted here ÷ the larger of (active series that name
  the dataset as `library` source × instances per day) and (28-day ledger publications ÷ 28) — "larger of"
  instead of "plus" so a series' own posts are not counted twice. Unposted counts come from the T1 ledger. The
  overview is cached 10 minutes per resource and card sources; `library_catalog({dataset})` is not cached.
  032's per-dataset `license` stays; a license mix per row was not added.
- **Prompt summary** (≤ 1,500 characters, cut with "…"): appended to the orchestrator's daily prompt and to both
  planners' user prompts through optional `catalogSummary` deps, cached 10 minutes per channel.
- **`low_runway`**: after each daily orchestrator run (`runwayCheck`), for every active series with a library
  source; one `agent_inbox` item (`ref_type='dataset'`, `ref_id=<key>`, severity action, English text, Ukrainian
  Telegram alert) per dataset per 7 days. `ContentRunwayService` is untouched (strategy channels still use it;
  it goes with T7).
- **`get_network_highlights`** (`editor/tools/highlights-tools.ts`): the digest query and both picks moved to
  `src/common/digests/` (`digest-format.ts`, moved from `strategies/network-digest/digest-format.util.ts`,
  which now re-exports it; `digest-selection.ts`), and the two strategy repositories call the shared query.
  Without `strategy_types` it is the network digest (own channels, views per hour), with them the topic digest
  (newest N, chronological). `date` selects a calendar day in the card's time zone (default: the last 24 h);
  `already_posted_today` reads the legacy `digest://…` sentinel through the ledger. A PostSpec source must be
  http(s), so the agent's own digest is deduped by its links, not by a `digest://` ref.
- **Prompts and skills:** `content-sources` lists the other sources (APIs, feeds, highlights, runway); the
  orchestrator prompt says "content plan" instead of "strategy".

## Implementation notes (T3, 2026-10-07)
Commit `feat(content): 023-T3 …`. No migration (series live in the playbook JSON; 059 is still free for T4).

- **Series v2** (`network/series.ts`, `SeriesSchema` in `playbook.ts`): cadence, `source`, `source_mode`, `origin`,
  `locked`, `migrated_from` as in FR-002. Stored bodies are raw JSON, so code reads them through
  `normalizePlaybook()` (v1 bodies get the defaults). `seriesDue` returns one instance per time.
- **Validation.** Quiet hours apply to agent submissions only: an owner's own series may sit in quiet hours
  (owner precedence, as for pins). Library datasets come from active `data_schemas` keys, feeds from the card's
  rss/url sources (id or ref), APIs from the adapter names. Series instances per weekday are checked against the
  section's `per_day.max` (paused series do not count).
- **Classification (with spec 031).** `classifyPlaybookChange(prev, next, { mode })` takes the effective mode
  (orchestrator × card). A ≤ 90-min shift on the same days and a source change within its kind apply at once in
  `shadow` and `live`; in `approve` every schedule change, pausing or resuming a series included, is structural
  (a card). Without a mode a shift stays structural. Change reasons are now English (they reach the Inbox).
- **One submit path** (`network/series-edit.ts`, `submitPlaybookVersion`): `submit_playbook` and the five series
  tools validate, guard ownership, classify, store and post the Inbox item the same way. The guard copies
  `origin` / `locked` / `migrated_from` from the active version (an agent cannot claim or unlock a series) and
  refuses any edit or removal of a locked series (`series_locked`). A pending draft created by `migration`
  answers `migration_pending` (the DB check that allows `created_by='migration'` comes with T6).
- **Owner lock.** `NetworkService.putPlaybook` locks every series the owner adds or edits (`lockOwnerSeries`);
  unchanged series keep their lock, so only Unlock (T5) hands one back.
- **Series tools** (`network/series-tools.ts`): `list_series` is also readable by the planner and the manager.
  The base is the agent's own pending draft when there is one (a minor change on top of a pending structural
  draft therefore waits for the owner too). The 5-per-run budget counts every mutating call, refused ones
  included.
- **`pause_series`.** `accept_directive` answers `owner_rule_conflict` for a locked series (the orchestrator then
  rejects with `owner_rule`); the prompt and the `editor-orchestrator-workflow` skill say to apply the directive
  with `set_series_active`.
- **Dashboard.** Only `fmtCadence` learned the v2 form; the Schedule tab and lock badges are T5.

## Implementation notes (T4, 2026-10-07)
Commit `feat(content): 023-T4 …`. Migration `059_schedule_rules.sql` as in FR-001.

- **Deviation — `editor_slots.rule_date`.** Besides `schedule_rule_id` and `series_name`, a pin slot stores its
  resource-local date; the idempotency key is a partial unique index on `(schedule_rule_id, rule_date)`. A
  skipped or published pin is therefore never re-created. Disabling or changing a pin deletes only its future,
  still-`planned` slots (the new version is materialised at once). The rules' resource is free text checked by
  the service (no FK), and `schedule_rules` belongs to the orchestrator (`agent_id`).
- **Where the rules live.** Pure checks in `editor/schedule/plan-schedule-rules.ts` (`planScheduleErrors`,
  `planPerDay`, `scheduleBlock`) and `schedule-rules.ts`; both validators call `planScheduleErrors` with one
  line through an optional `schedule` context, so callers without it behave as before. Frequency and pins
  reach the existing count checks through the caller: `ScheduleService.effectiveCard` / `effectiveNet` lower
  the day's posts per day (the frequency rule, else the card / playbook) by the day's pins.
- **Pins.** Materialised for the resource-local today and tomorrow by the scheduler before planning (at most
  every 10 min per channel) and right after a rule is added or changed; a day without a plan gets a
  reserved-only plan, so the planner still runs. `replacePlan` moves pins to the new plan like reserved slots
  (never skipped as "superseded"). Planned slots keep `max(window_min, min gap)` from a pin; a pin with
  `series_name` covers that series' instance. `window_min` has no other meaning yet.
- **Due series.** A slot names its series with `series` (both planners; the single planner got the field too) and
  stores `series:<name>` in `source_hints`; the plan transaction copies it into `series_name`. An instance that
  is already past (late start, +90 min) or inside a blackout is not required. `skipped_series` is optional in
  both inputs (old plans validate unchanged).
- **Executor.** `ScheduleService.executorContext` adds the series note (brief, source, mode) to the executor
  prompt; a pin without a series gets a "pinned by the owner" note. Required-source guard
  (`series_source_mismatch`) in `publish_post` and `publish_platform_post`: library → same dataset; feed → the
  feed's site; api → a source URL, on the adapter's site for nasa_apod / tmdb_trending / on_this_day (the others
  aggregate many sites); network highlights → a t.me link. Live blackout re-check returns `blackout_window`
  (owner pins are exempt). Approval-mode posts are not re-checked at send time.
- **`series_source_empty`.** Detected by code only for a `required` **library** source (no unposted rows on the
  resource, ledger counts): the slot is skipped before any LLM call and one Inbox item per series per day is
  filed. A required feed / API with nothing usable is left to the agent's `skip_slot` (no Inbox item).
- **Reserved slots** are never blocked; the chat's `schedule_draft` result carries `warnings: ['blackout_window']`.
- **Prompts.** The day's pins, blackouts, frequency and due series reach both planners and the orchestrator
  through the existing catalog-summary hook (no runner change).

## Implementation notes (T5, 2026-10-07)
Commit `feat(content): 023-T5 …`. No migration.

- **One `ScheduleService`** (`editor/schedule/schedule.service.ts`, built in T4) holds every check the REST, the
  cards and the tools share. Owner-facing text (card summaries, REST errors, warnings) is English; the agents'
  tool results stay Ukrainian.
- **Chat tools** (`schedule-tools.ts`, role `composer` only — the composer and @agent chats; they need a chat
  context): `get_schedule`, `propose_series_change`, `propose_schedule_rule`, `propose_slot_change`.
  **Deviation — the explicit-request check** is the agent-change verb check *or* `hasScheduleChangeIntent`:
  schedule verbs (перенеси, пропусти, скасуй, move, skip…) or a time plus a cadence word, so «рецепти о 20:30
  по буднях» counts; negations («не переноси») do not.
- **Cards and staleness.** `series_change` stores the series' content + lock key at propose time and fails as
  `stale` when it differs at Apply (two cards for one series: the second fails); Apply writes an owner version
  (`created_by='owner'`, active, the series locked), which supersedes a pending agent draft (existing
  `insertPlaybook` rule). `schedule_rule` checks the rule's `updated_at`; `slot_change` moves / skips only a
  slot that is still `planned` at the proposed time (any change → `stale`). Rules from the chat are
  `created_by='chat'`.
- **REST** (`schedule.controller.ts`, `TrackingAuthGuard`): `GET /api/agents/:handle/schedule?from&to` (default
  the anchor's today + 6 days, at most 14 days), `POST/PATCH /api/agents/:handle/schedule-rules[/:id]` (`active:
  false` disables, `true` re-enables), `PUT /api/agents/:handle/series/:name` (adds the series when the name is
  new, locks it either way), `POST /api/agents/:handle/series/:name/unlock`. **Unlock also writes an owner
  version** (so it supersedes a pending agent draft too). The GET response adds `resources[].formats` and
  `sourceOptions` for the forms.
- **Schedule tab** (`?tab=schedule`, network tabs only): a 7-day grid, one lane per resource labelled with its
  zone and offset (series instances take the status of the slot that realises them; pins of their own slot;
  other slots listed with status); a day list under 760 px; Series (edit → "Save and lock", Unlock) and
  Rules (add / edit / disable / enable) card-rows with modal forms. Slot moves stay chat-only (not in the
  REST list of FR-007).
- **Evals** (written, not run): `chat-series-change` and `planner-honours-pins` (`evals/cases/schedule.ts`); the
  eval stack wires the ScheduleService into the tools, runner and planners.

## Implementation notes (T6, 2026-10-08)
Commit `feat(content): 023-T6 …`. Code in `apps/automation/src/editor/migration/`.

- **Migration `063_strategy_retirement.sql`.** 059 (T4) had already added `retired_at` / `retired_reason` /
  `migrated_to` and the `created_by='migration'` playbook check; 063 re-asserts both idempotently and adds the guards
  the cutover relies on: `strategy_bindings_retired_chk` (a retired row stays disabled and names its reason,
  `migrated` or `owner`; re-enabling must clear the retirement in the same UPDATE — only the rollback does),
  `migrated_to` must be an object, and a partial index on `retired_at`.
- **Proposal** (`proposal.ts`, `cron-cadence.ts`, `type-mapping.ts`; pure). The cron runs in `SCHEDULER_TZ` (else
  the process zone, UTC in Docker); times are converted to the resource zone **at today's offsets** (a warning says
  so) and a whole-day shift moves the weekdays (a cron whose times cross midnight unevenly is unmappable). The
  digest types are retry loops: a minute step collapses to the window's first time. Quiet-hour times are dropped
  before the > 6 check. A Meta / TikTok binding gets the platform's native format (photo → `ig_photo` / `fb_photo` /
  `th_image` / `tt_photo`, carousel → `ig_carousel` / `fb_album` / `th_carousel` / `tt_photo`, text → `fb_text` /
  `th_text`, none on Instagram). Unmappable reasons: no agent equivalent, the format is off on the card (or missing
  on the platform), a `required` dataset is not in the library, day-of-month / month crons, all times in quiet
  hours, a destination outside the network or unusable (health), a Meta / TikTok binding in a `legacy_duplicate`
  network, a binding some series already names (`migrated_from`), no resolvable destination.
- **Deviations in the mapping.** A feed that is not on the channel card gives a series without a source (warning;
  the `ua-news` brief keeps the feed URL) — naming it would make every later agent submit fail validation;
  `ai0-news` reads `config/sources` and gets no source. `game-channel` names one API (suggested mode). Both digests
  map to `network_highlights` scope `network`. **The "pillar note" of a frequency hint is a playbook `rules` line**
  («Замість стратегії <ext_id> (<type>): близько N пост(ів) на день …») because pillar shares must add up to 100;
  the hint is `published_posts` of the last 14 days ÷ 14 (Telegram; other platforms: successful `strategy_runs`),
  else the cron count. Each section's `per_day.max` becomes at least the busiest weekday's series instances plus
  the hints (capped at 24 / the platform API cap); a missing section is added (`discovery`), a missing format
  weight is set to 0.5. Series are named after the binding `ext_id` (a clash gets " (2)"); briefs are Ukrainian
  agent instructions, the rationale and warnings English.
- **Draft.** The `migrate_strategies` card stores the proposal key (bindings + active version); Apply re-proposes and
  fails `stale` when it changed, `migration_invalid` when the draft does not validate, `nothing_to_migrate` when
  nothing maps. It writes `created_by='migration'`, `pending_owner` (superseding an agent's pending draft), the
  per-binding outcomes in `review.strategy_migration`, and an Inbox `playbook_pending` item. The owner approves it on
  the agent page as any pending version.
- **Cutover.** The bindings it retires are the enabled bindings of the network that the **active** playbook took
  over: a series' `migrated_from` or a frequency-hint rule line. Unmappable bindings stay enabled and keep blocking
  `live` (the owner pauses them). Shadow statistics: since = the first slot of a migrated series; the last 7 days'
  projected instances vs slots of those series that were `shadowed` / `published` / `awaiting_approval` / `approved`.
  `StrategyMigrationUpkeep` (06:41 daily) files a chatless `strategy_cutover` card when ready (one pending card per
  channel) and one Inbox item `strategy_cutover_ready` per channel per 7 days. Apply: `EDITOR_ENABLED≠true` →
  `editor_disabled`; one transaction sets the card (audited like an owner upsert) and the orchestrator to
  `CUTOVER_TARGET_MODE` (approve) and retires the bindings (`migrated_to` = `{agent_id, handle, playbook_id,
  series[]}`); then `config:changed` (kind `strategy`) and an Inbox item.
- **Guards.** `bindings_still_enabled` (409, `ext_ids`) in `EditorChannelsRepository.upsert` (inside its
  transaction, so the owner's card form, the autonomy switch and `AgentsService` all hit it) and in
  `AgentsService.patch` (also for platform resources and network scopes). **A Telegram anchor's live switch covers
  its whole account group** (its Meta / TikTok bindings too). `binding_retired` (409) in `PATCH /api/strategies/:id`
  plus the DB check.
- **Rollback** (`strategy_rollback`): one transaction re-enables the bindings retired for this agent and clears their
  retirement, and puts the orchestrator **and its card** back to `shadow` (leaving approval drops waiting posts, as
  in 031).
- **Triggers.** REST (`TrackingAuthGuard`): `GET /api/strategies/migration` (per-channel state, pending cards),
  `GET /api/strategies/migration/proposal?channel=` (dry run), `POST /api/strategies/migration/{migrate,cutover,rollback}`
  `{channel}` → a chatless card (Apply / Discard through `/api/agents/actions/:id/…`). @ai0:
  `propose_strategy_migration({channel, op: preview|migrate|cutover|rollback})` (cards need the explicit-request
  check). CLI: `pnpm --filter automation migrate:strategies --dry-run [--channel @key] [--json]` on a read-only
  connection (`default_transaction_read_only`); it does not check resource health.
- **Tests.** Unit: cron → cadence (incl. `*/10 19-20`, `0 */4`, `*/30`, zones, weekday shift), the 18 type rules,
  native formats, every binding of `config/channels.json` (10 of 10 mapped), the guards. PG
  (`strategy-migration.pg.test.ts`): dry run writes nothing → migrate (stale, then applied) → approve → shadow →
  offer → refused without `EDITOR_ENABLED` → cutover transaction → 409 live guard (card and agent) → 409
  `binding_retired` and the DB check → live after pausing the last binding → rollback.

## Implementation notes (T7 phase A, 2026-10-08)
Commit `feat(content): 023-T7 …`. **Phase B (deleting idle strategy modules, the redirect, removing the scheduler and
`ContentRunwayService`) is not done: it is owner-gated.** No migration.

- **API.** `POST /api/strategies` → `410 strategies_legacy` (the create validation is gone). `PATCH /api/strategies/:id`
  accepts only `enabled: false` and `notes`; any other field (enabling included) → `410 strategies_legacy` with
  `refused[]`; a retired binding asked to enable → `409 binding_retired` first. `DELETE` and the read endpoints
  (`GET`, `types`, runs, previews) stay. The list adds `retired_at`, `retired_reason`, `migrated_to`. The unit tests of
  the removed create / edit validation were replaced by `strategies.controller.legacy.test.ts`.
- **`/app/strategies`.** No Add button; a "Content is run by agents" banner (`components/strategies/MigrationBanner.tsx`)
  lists every channel with bindings (state badge, agent link to its Schedule tab, enabled / retired counts, shadow
  days and share) with **Migrate** (a dry-run modal, then "Create migration draft" proposes and applies the
  `migrate_strategies` card), **Cutover** (when ready; confirm, then the card is applied), **Rollback** (when bindings
  were retired) and the pending migration cards (e.g. the upkeep's cutover offer) with Apply / Discard. Rows can only
  be paused (no Enable); retired rows are greyed, sorted last, and link to the agent's series. `/app/strategies/new`
  explains that strategies can no longer be created. The detail page is a read-only "Legacy strategy" panel (notes,
  Pause, cross-post targets) and the recipe post preview is read-only. The channel page shows schedules as text.
  **Deviation:** the create form (`StrategyForm`, `lib/strategy-types.ts`) and the inline schedule editors
  (`InlineScheduleEditor`, `SchedulePicker`) were deleted rather than hidden; `PatchStrategyInput` now types only
  `{ enabled?: false; notes? }`, so tsc rejects any UI path that enables a binding.
- **Menu.** A new **Legacy** group (`g_legacy`, last) holds Strategies and its hidden New-strategy entry; saved menus
  keep the owner's own placement.
- **Overview.** "Active strategies" became **Upcoming slots (24 h)** and "Upcoming runs" the **Upcoming slots** card:
  the next series instances and owner pins of every Telegram-anchored agent (not `off`) with the status of the slot
  that realises each (`GET /api/schedule/upcoming?hours&limit`, `editor/schedule/upcoming.ts`, built on
  `ScheduleService.schedule`). "Strategy status" was renamed "Legacy strategy runs".
