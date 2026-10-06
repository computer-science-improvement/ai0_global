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
