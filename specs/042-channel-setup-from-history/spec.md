# 042: Channel setup from history

**Status:** DONE (2026-10-17) · **Priority:** P1 · **Linear:** AI0-140 (T1–T8: AI0-141…AI0-148) · **Depends on:** 017–022 (agents, profiles, playbooks), 024 (formatting),
029 (llm_usage / budgets), 040 (loop breaker, owner skills reach the writers) · **Migration:** `080_channel_setup.sql`

**Owner request (2026-10-16):** «у мене ще є багато каналів, мені потрібен функціонал для налаштування автоматичного агента для
каналу … вичитає останні 20 постів, проаналізує і напише бриф та все інше для цього каналу якщо там були пости».

Owner decisions (brainstorm 2026-10-16):
- Run it from a button on the agent page (one channel) and in a batch (all own channels that miss setup).
- The result is one **proposal per channel** with sections; the owner reviews it in a dialog and applies all or some sections.
- Posts come from `tracked_posts`, topped up live by the tracking userbot (MTProto `getHistory`). No t.me/s scraping, no exports.
- The proposal fills everything: brief + profile, formatting + style, format mix, rubrics (series) + pillars, schedule, examples +
  a "voice" skill.
- A channel with no editor card / agent gets them on Apply, in mode `off`.

## What exists and what is missing
| Exists | Gap |
|---|---|
| `tracked_posts` holds full texts + metrics; `PollPostsWorker` / `TrackingMtprotoClient.getHistory` fill it | Nothing reads 20 full texts for setup; `ResourceCatalog.inspect` prefers `editor_v_post_performance` (titles only, 200-char clip, 28 days) |
| @ai0 builder: `inspect_resource`, `draft_resource_profile` (code, no LLM), `create_agent`, `set_brief`, `set_resource_profile` cards | No LLM analysis: audience, tone, taboo, formats, rubrics stay empty; cards expire in 24 h; one channel per conversation |
| `setProfile`, `setBrief`, `patchFormat`, `putPlaybook`, skills write/attach, `AgentCreator.create` | No card for format_prefs / style / card fields / series as a whole; Apply of `set_brief` rebuilds the playbook and would overwrite proposed series |
| `/app/channels` lists own channels; agent page has profile / formatting / playbook / skills / schedule panels | No place that shows which channels miss setup, no batch run |

## FRs

### FR-001 Post collection
- Input: a channel key of an own channel (`tracked_channels.is_mine`). A key with no `tracked_channels` row is refused
  (`not_tracked`); own channels from `channels*.json` already have one (json importer).
- Take the last **20** posts (`posted_at DESC`) from `tracked_posts`, skipping service messages and posts with neither text nor media.
- When fewer than 20 are stored, call `getHistory(channel, 0, 50)` once through the tracking client and upsert the result into
  `tracked_posts` (same mapping as `PollPostsWorker`), then read again.
- Access is checked before the pull: the entity resolution distinguishes "no access" from "no posts". No access → status
  `no_access` with the hint "Add the tracking account to the channel"; the model is not called.
- Fewer than **5** usable posts → status `too_few_posts`; the model is not called.
- `FLOOD_WAIT` → the proposal goes back to `queued` with `retry_at` = now + the wait (FR-007).

### FR-002 Metrics in code
Computed from the collected posts, no LLM, stored on the proposal and shown in the dialog:
- `per_day` (posts / active day over the span), `span_days`, `active_hours` histogram (channel timezone, default Europe/Kyiv),
  `peak_hours` (top 3 hours by median views, ≥ 2 posts each), `quiet_hours` (longest run of hours with no posts).
- Format mix: text / photo / video / album / poll / document shares from `has_media` / `media_type`.
- Length: median and p90 characters; line breaks per post.
- Share of posts with emoji (and median count), hashtags (and the vocabulary used ≥ 2 times), links, a CTA-like last line, a
  repeated signature/footer (same last line in ≥ 30 % of posts), mentions.
- Address: «ти»/«ви» forms count.
- Engagement per post: `(reactions_total + forwards + comments_count) / views`; top 5 post ids by it (ties by views).
- Repeated headers: first lines / leading emoji+word patterns seen in ≥ 2 posts (rubric candidates) with their post ids.

### FR-003 Analysis run
- New editor role `onboarder` (EDITOR_ROLES, `ROLE_DEFAULTS`: maxTokens 8000, temperature 0.3, effort medium; env key
  `EDITOR_MODEL_ONBOARDER`; shown in the model picker like the other roles).
- One `AgentLoop` run per channel, feature `editor.onboarder` (production pool; spec 040 breaker applies), channel budget and the
  total AI cap apply; `maxSteps` 4, `maxCostUsd` 0.30. The user prompt carries: channel title/about/subscribers, the metrics, and
  the posts (id, date, format, views, engagement, full text cut at 1500 chars).
- The only tool is the terminal `submit_channel_setup` (zod schema = the six sections below, each with `evidence`:
  `{post_ids: string[], note: string ≤ 300}`).
- Validation beyond the schema (the tool returns an error with a numbered checklist, spec 040 style):
  - every `post_ids` entry is one of the given posts;
  - a series needs ≥ 2 evidence posts;
  - pillar shares sum to 100 (± 5, the playbook rule);
  - format weights only use formats the channel has;
  - example ids are among the given posts.
- On `no_terminal` / budget / errors the proposal gets status `failed` with the reason; no partial sections.

### FR-004 Sections
1. **brief_profile:** `ResourceProfileSchema` fields topic, audience {who, age, region}, language, goals, tone, taboo, notes;
   `brief` text 5–10 sentences. `examples[]` comes from section 6.
2. **formatting:** `format_prefs` (length, emoji, hashtags, mentions, cta, links, line_breaks, signature, humor, slang,
   content_kind) and `style` (address, hashtags off/vocabulary, headline); card `hashtags[]`, `hashtag_min/max`, `footer`,
   `emoji_policy`, `link_style` when the metrics show a repeated pattern.
3. **format_mix:** card `formats` weights from the observed shares.
4. **series_pillars:** `series[]` (name, cadence `daily@HH:MM` | `weekly:<days>@HH:MM`, format, brief, source `free` unless the
   evidence shows another) and `pillars[]` (3–5, shares in % summing to 100, as the playbook stores them).
5. **schedule:** card `posts_per_day_min/max`, `quiet_start/end_hour`; playbook `best_hours` of the channel's section = peak hours.
   (`agents.schedule.times` is when the orchestrator runs, not when posts go out, so it is not touched.)
6. **examples_voice:** 3–5 example post ids (texts copied verbatim from `tracked_posts` at Apply, never from the model), and a skill
   `channel-voice` on the channel's agent (markdown: 5–8 do / don't rules, 2–3 short quotes from the posts, `applies_to` executor + checker).

Locked values are kept: `format_locks[]` fields and `locked` series are not overwritten; the dialog shows them as "kept (locked)".
The proposal never changes mode, budgets, sources, models or tools.

### FR-005 Proposal storage
- Table `channel_setup_proposals` (080): `id`, `channel_key`, `resource_ref`, `agent_id` (null for a channel without an agent),
  `status` (`queued | collecting | analyzing | ready | applied | partially_applied | discarded | superseded | failed | no_access |
  too_few_posts`), `reason`, `retry_at`, `post_ids` (tracked_posts ids), `metrics` jsonb, `sections` jsonb, `section_status` jsonb
  (`{<section>: pending|applied|kept|skipped}`), `baseline` jsonb (the values each section would replace, taken at analysis),
  `run_id`, `cost_usd`, `created_by`, `created_at`, `updated_at`, `applied_at`.
- A new run for a channel marks its open (`ready`) proposal `superseded`. No TTL.

### FR-006 Apply
- `POST /api/channel-setup/proposals/:id/apply` `{sections: string[]}` (owner only). Sections are written in the order below;
  each section's write is atomic (the existing repositories' own transactions). A failing section stops the Apply: the
  sections before it stay applied, it and the rest stay `pending`, the error is returned per section (`partially_applied`).
  1. No card/agent → the card is created through the owner card upsert with mode `off`, then the registry sync creates the
     orchestrator and its children (handle derived from the channel key, `created_by` `sync`, mode mirrors the card: `off`).
  2. brief_profile → `setProfile(..., 'owner')` (tone skill attaches as today) + `setBrief`.
  3. formatting → format_prefs/style through the owner path (not the agent's 3-per-day `patchFormat` limit) + card fields.
  4. format_mix, schedule → card fields (`upsertChannel` validation).
  5. series_pillars, schedule (best hours) and examples_voice → one new **active** playbook version through the owner's
     `putPlaybook` (current body + proposed series/pillars/examples and the channel section's formats, per_day and best_hours;
     a channel without a playbook gets a single `core` section); the skill is written and attached.
- When brief and series are applied together, the `onBrief` playbook rebuild is skipped. A brief applied without series keeps
  today's rebuild.
- **Drift check:** before writing, each section's current value is compared with `baseline`; a changed one is refused
  (`changed_since_analysis`) with the current value, and the dialog asks to review again. The other sections still apply.
- `POST …/discard` → `discarded`. Status becomes `applied` when all non-skipped sections are applied, else `partially_applied`.
- Every write keeps the existing version tables (`resource_profile_versions`, playbook versions), `updated_by` = `owner`.

### FR-007 Runs and API
- `POST /api/channel-setup/analyze` `{channelKeys: string[]}` (1…50) → proposals `queued`. The queue is the table: an in-process
  worker takes the oldest `queued` proposal whose `retry_at` has passed, one at a time; it is kicked on enqueue and by the
  editor's minute tick, so a restart loses nothing. FLOOD_WAIT puts the proposal back to `queued` with `retry_at`.
- `GET /api/channel-setup/overview`: own channels with tracked posts count, whether brief / profile / active playbook / card
  exist, last proposal status, and a cost estimate per channel (the average cost of the last 20 successful onboarder runs; none until the first run).
- `GET /api/channel-setup/proposals/:id`, `GET /api/channel-setup/proposals?channel=`.
- @ai0 builder tool `analyze_channel_history {channel_key}`: queues a run and returns the proposal link (no card, no other logic).

### FR-008 Dashboard (English UI)
- `/app/setup` (nav: under Agents; link from My channels): table of own channels — channel, posts stored, Brief / Profile /
  Playbook / Card badges, last proposal status, cost estimate; filter "Missing setup"; checkboxes + "Analyze selected" with a
  confirm showing the total estimate. Rows poll while queued / analyzing.
- Agent page: "Set up from history" button; a badge when a `ready` proposal exists.
- Proposal dialog (`Modal` size lg): metrics strip; six sections, each a compact "now → proposed" row that expands to the full
  values and the evidence (post date, first line, views, link `t.me/<key>/<msg_id>`); a checkbox per section (locked / identical
  sections unchecked and marked); "Apply selected" and "Discard". Drift errors show inline on the section.

## Non-goals
- Other platforms (IG/FB/Threads/TikTok history), t.me/s scraping, Telegram Desktop export upload.
- Changing mode, budgets, sources, models or tools; turning a channel on.
- Re-analysis on a schedule.

## Verification
- Unit: metrics on synthetic posts (peaks, mix, emoji/hashtags, signature, rubric candidates); `submit_channel_setup` checks; drift
  check; lock handling.
- FakeLlm replay: posts → proposal → Apply all; every write checked; the playbook rebuild did not run; Apply of brief alone does
  rebuild.
- PG (scratch): 080 applies twice; Apply all against real repositories (scratch rows removed after); new channel → card + agent in `off`; `superseded`;
  `getHistory` top-up upsert with a fake client.
- Dashboard: tests for the table and the dialog; browser check on mocks at desktop and mobile width.
- No paid model calls, no real Telegram calls in tests.
