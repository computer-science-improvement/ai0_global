# Runbook: editor agent

Autonomous per-channel editor (specs [003](../../specs/003-editor-harness/spec.md),
[004](../../specs/004-post-spec-and-skills/spec.md), [005](../../specs/005-editor-roles/spec.md)).

Every channel has three roles:
- **Planner:** runs once a day and builds the day's plan of slots: time, format and topic.
- **Executor:** runs once per slot. It gathers material, writes a `PostSpec`, and then publishes it or skips the slot.
- **Reviewer:** runs weekly. It turns stats into channel memory and format weights.

Everything runs on OpenRouter (`z-ai/glm-5.3-flash` by default, about $0.006 per post).

## 1. Enable

1. Apply migrations `042_editor` … `047_editor_chat` (`database/migrate.sh`, or let the service apply them at boot).
2. In `.env`, set:
   ```
   EDITOR_ENABLED=true
   OPENROUTER_API_KEY=sk-or-...
   EDITOR_DAILY_BUDGET_USD=3
   EDITOR_CHANNEL_DAILY_BUDGET_USD=0.5
   ```
3. Before the first run, check the model on your key (< $0.001, publishes nothing):
   `cd apps/automation && pnpm editor:smoke` → expect `✅ OK`.
4. Restart automation. The log shows `editor ENABLED: N tools, M skills`.

`EDITOR_ENABLED` is the global kill switch for the agents. With it set to `false`, no planner, executor or reviewer runs, including content slots that are already planned. The one exception is paid ads already reserved in the plan (see section 5): they still publish, because they run without the LLM.

## 2. Create a channel card (example)

`channel_key` must be the key that `ChannelConfigService.resolveChannel` accepts, i.e. `tracked_channels.channel_key`, such as `@my_channel`.

```sql
INSERT INTO editor_channels (
  channel_key, mode, title, brief,
  posts_per_day_min, posts_per_day_max, quiet_start_hour, quiet_end_hour, min_gap_minutes, plan_hour,
  formats, hashtags, hashtag_min, hashtag_max, footer, link_style, emoji_policy,
  sources, explore_ratio, banned_terms
) VALUES (
  '@my_space_channel', 'shadow', 'Космос щодня',
  'Короткі зрозумілі пояснення космічних новин і знімків для широкої аудиторії. Без астрології і конспірології.',
  3, 5, 23, 8, 90, 6,
  '{"photo":1,"text":0.6,"album":0.4,"quiz":0.3,"poll":0.2}',
  '{космос,nasa,фото,вікторина,новини}', 1, 2, NULL, 'inline', 'sparse',
  '[{"id":"nasa_rss","kind":"rss","ref":"https://www.nasa.gov/feed/"},
    {"id":"esa_rss","kind":"rss","ref":"https://www.esa.int/rssfeed/Our_Activities/Space_Science"},
    {"id":"library_facts","kind":"library","ref":"facts"},
    {"id":"apod","kind":"api","ref":"nasa_apod"}]',
  0.20, '{астрологія,гороскоп}'
);

-- Owner rules the agents must always follow:
INSERT INTO editor_channel_memory (channel_key, kind, text, created_by) VALUES
  ('@my_space_channel', 'rule', 'Кожен пост про конкретну подію має посилання на першоджерело (NASA/ESA/журнал).', 'owner'),
  ('@my_space_channel', 'avoid', 'Не публікувати «сенсації» з таблоїдів про НЛО.', 'owner');
```

Optional fields:
- `skills`: names of skills from `apps/automation/editor-skills/` that are always loaded inline. Use this for a channel's own voice: write `editor-skills/channel-<name>.md` with frontmatter.
- `tools_allow`: narrows which tools are available. NULL means the role defaults.
- `models`: legacy per-channel override (`{"executor":"z-ai/glm-5.3"}`). Prefer `/app/models` (spec 035): a global default (`ai.default_model`, built-in `z-ai/glm-5.3-flash`) and a model per agent; the page lists and clears these legacy overrides.
- `daily_budget_usd`: per-channel spend cap.
- `crosspost` (default `true`): mirror live posts to the channel's Meta targets (section 8). `false` keeps the channel Telegram-only.

Source kinds: `rss` (feed URL, read with `fetch_feed`), `url` (a page, `web_fetch`), `library` (a table, `search_library`)
and `api` (a `fetch_api` source name, section 8).

## 3. Shadow, then live

1. **Shadow (at least 7 days).** Agents plan and write. `publish_post` only saves `editor_slots.post_spec` and `rendered_preview`, and the admin bot sends you each preview (`EDITOR_SHADOW_PREVIEW`).
   Review with:
   ```sql
   SELECT scheduled_at, format, topic, status, LEFT(rendered_preview, 200), error
     FROM editor_slots WHERE channel_key = '@my_space_channel' ORDER BY scheduled_at DESC LIMIT 30;
   ```
2. Checklist before going live:
   - ≥ 80% of slots are `shadowed`, not `failed`.
   - Previews read well: Ukrainian, no AI clichés, facts are correct, sources are linked.
   - Spend per day is under the cap: `SELECT date(started_at), SUM(cost_usd) FROM editor_runs GROUP BY 1`.
3. **Live:** `UPDATE editor_channels SET mode = 'live' WHERE channel_key = '@my_space_channel';`
   If a legacy strategy publishes to the same channel, disable that binding first. Otherwise both will post. Daily caps and min-gap do count the legacy posts.

## 4. Operating

| Need | How |
|---|---|
| Stop one channel | `UPDATE editor_channels SET mode='off' WHERE channel_key=…` |
| Stop everything | `EDITOR_ENABLED=false` + restart |
| Pause publishing but keep planning | `mode='shadow'` |
| See why a post was written | `SELECT * FROM editor_run_steps WHERE run_id = (SELECT run_id FROM editor_slots WHERE id=…) ORDER BY idx` |
| Re-plan today | `UPDATE editor_plans SET status='superseded' WHERE channel_key=… AND plan_date=current_date`. The planner runs again within 1 min (up to 3 attempts a day). |
| Teach the agent a rule | Insert into `editor_channel_memory` with `created_by='owner'`. The reviewer cannot retire it. |
| Spend today | `SELECT channel_key, SUM(cost_usd) FROM editor_runs WHERE started_at > current_date GROUP BY 1` |

### Dashboard, REST and MCP (spec 006)

Everything above can be done without SQL:

- **Dashboard `/app/editor`:** channel cards with the off/shadow/live switch (live asks for confirmation),
  today's slots (run now / skip), spend for 30 days. A channel page has the card editor, the memory list,
  the day's plan and recent runs; slot and run pages show the preview, the PostSpec and the full trace.
- **REST `api/editor/*`** (TrackingAuthGuard): `channels`, `channels/:key` (PUT = upsert; a mode change is
  recorded in `editor_channel_memory` as an inactive owner `rule`), `channels/:key/replan`,
  `channels/:key/memory`, `plans?date=&channel=`, `slots/:id`, `slots/:id/run`, `slots/:id/skip`,
  `runs?channel=&slot=&limit=`, `runs/:id`, `spend?days=`, `tools`, `tools/:name` (read tools only).
  `replan` and `run` return at once; add `?wait=true` to wait for the agent run.
  "Run now" claims the slot (planned → running) and goes through the normal executor, so every
  publish guard still applies. Both refuse while `EDITOR_ENABLED` is not `true` or the channel is `off`.
- **MCP for Claude Code:** copy `.mcp.json.example` to `.mcp.json`; the server runs
  `pnpm --silent --filter automation editor:mcp` and talks to `EDITOR_API_URL` with `TRACKING_TOKEN`.
  It can read everything, replan, run slots of **shadow** channels and set mode `off`/`shadow`. It cannot
  switch a channel to live or publish. Skill: `apps/automation/.claude/skills/operate-ai0-network`.

## 5. Paid ads: reserved slots (spec 008)

The full owner flow (price → invoice → payment → slot → report) is in [ad-sales.md](ad-sales.md). What matters
for the editor:

- **Where an ad goes.** When you approve an ad order's `schedule_post` action, the post becomes a
  **reserved slot** (`editor_slots.kind='reserved'`) only if `EDITOR_ENABLED=true` **and** the channel has an
  `editor_channels` card (any mode, even `off`). Otherwise it goes to the old SP2 `scheduled_publications` queue.
- **Who publishes it.** No LLM. Every scheduler tick, `SponsoredPublisher` claims due reserved slots and sends
  the approved creative (snapshot in `editor_slots.post_spec`) with `#реклама` as the last line.
- **Precedence of switches for reserved slots:**

  | Switch | Effect on a reserved (paid) slot |
  |---|---|
  | `EDITOR_ENABLED=false` | **Still publishes.** It stops the LLM roles only; a slot that was already reserved goes out. New approvals use the SP2 queue instead. |
  | Channel `mode` off / shadow | **Still publishes.** A paid ad is not a shadow experiment. |
  | `tracked_channels.publish_paused=true` | **Blocks.** The slot fails, you get an alert, reschedule the order. |
  | Skip the slot (`/app/editor`, `slots/:id/skip`) | Cancels this placement; the order stays `scheduled`. |
  | More than 6 h late (service was down) | Slot fails with `missed window` and alerts you. It is never posted hours late. |

- **Planning around ads.** The planner sees reserved slots as fixed points (min gap applies around them) and a
  re-plan never skips them. If the day had no plan yet, a plan with rationale `reserved only` holds the slot; the
  planner still plans that day and moves the slot into its plan.
- **Counting.** Ad posts are `published_posts.strategy_type='ad'`: they count toward the daily cap and min gap
  for content slots, and the network digest never re-promotes them.

## 6. Alerts you will get (admin bot)

- Budget exhausted (global or per channel), once a day.
- The planner failed to produce a plan.
- 3 slots in a row failed on a channel.
- Weekly reviewer summary (Mondays).
- A paid ad was published (`💰 …`; for a `pin_24h` order it reminds you to pin the post for 24 h).
- A paid ad did not go out (`⚠️ Реклама … не вийшла`): channel paused, missed window, invalid creative or a Telegram error.
- An advertiser report is ready but the order has no DM thread, so you send the link yourself.

## 7. Safety model (what the model cannot do)

- **Publishing.** The only publishing path is `publish_post`. In code it enforces:
  - slot state and lint
  - similarity < 0.6 and dedup by source or library row
  - in live mode only: daily cap, quiet hours and min gap
- **HTML.** The model never writes HTML. The renderer escapes everything.
- **Database.** `sql_readonly` runs as the `editor_ro` role inside a READ ONLY transaction with a 3 s timeout. That role cannot see `my_bots`, `meta_accounts`, `mtproto_sessions`, `app_settings`, `ad_orders`, `agent_*` or the logs.
- **Web access.** `web_fetch`, `fetch_feed`, `extract_images` and `fetch_api` are SSRF-guarded on every redirect hop. `fetch_api` only calls fixed public APIs; keys never appear in tool output.
- **Uploads and mirrors.** Slide hosting, Telegraph pages and Meta cross-posts happen only inside a **live** `publish_post`, after every guard has passed. Shadow mode never uploads or mirrors anything.
- **No other powers.** Runtime agents have no shell, no file writes and no account actions.

## 8. Formats, API sources and cross-posting (spec 009)

### API sources (`fetch_api`)

Put `{"id":"…","kind":"api","ref":"<source>"}` in the card's `sources`; the agents call `fetch_api({source, params})`.
Every source returns `{items:[{title, summary, url, image, date, extra}]}` (texts mostly in English; the agent translates).

| Source | What | Key (`.env`) | Params |
|---|---|---|---|
| `nasa_apod` | NASA astronomy picture of the day | `NASA_API_KEY` (falls back to `DEMO_KEY`) | `date?` |
| `spaceflight_news` | Spaceflight News API, newest first | — | `limit?`, `search?` |
| `tmdb_trending` | TMDB trending movies/series | `TMDB_API_KEY` (required) | `media?`, `window?`, `language?`, `limit?`, `min_votes?` |
| `epic_free_games` | Games free right now on Epic | — | — |
| `steam_deals` | Steam specials ≥ N % off | — | `min_discount?`, `limit?`, `enrich?` |
| `gamerpower_giveaways` | Active giveaways, all stores | — | `platform?`, `type?`, `limit?` |
| `on_this_day` | Byabbe "on this day" (Wikipedia) | — | `kind?`, `month?`, `day?`, `limit?` |

These are the same endpoints and mappings the legacy daily-photo, space, movies, game-channel and on-this-day strategies use
(`src/common/fetchers/apis`).

### Formats: carousel, longread, video

Enable them per card with a weight, like any other format (`"carousel":0.3`). Previews in shadow mode describe the slides or the
article as text; nothing is rendered, uploaded or created until the channel is live.

| Format | What goes out | Needs |
|---|---|---|
| `carousel` | 2–10 slides rendered by code (title + text over a photo), sent as a Telegram album with the caption on the first | Slide hosting: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_CAROUSEL_BUCKET` (public bucket). Slides are deleted after the publish. |
| `longread` | A Telegraph page (up to 60 blocks) plus a teaser post (≤ 600 chars) with a large preview and a «Читати» button | An active Telegraph account (`/app/connections` → Telegraph), the same one the recipes strategy uses |
| `video` | `sendVideo` with a caption ≤ 1024 | A direct `.mp4` URL (`media[0].kind="video"`); YouTube links are rejected by lint |

If the hosting or Telegraph account is missing, `publish_post` returns `prepare_failed` and the agent picks another format or
skips the slot.

### Cross-posting to Meta

After a **live** publish, the post is mirrored through the same mechanisms the legacy strategies use:
- `meta_crosspost_targets` of the channel (dashboard: `/app/strategies` → edit a strategy of that channel → Cross-post), any
  mode (`mirror` and `teaser` targets both get the editor's own per-platform text);
- the channel's account group, when Telegram is the group's source (`meta_account_groups.source_platform='telegram'`).

What each platform gets:

| Post format | Facebook / Threads | Instagram |
|---|---|---|
| text, photo | plain text, links as `label (url)`, `Джерело: url`, link back to the Telegram post, hashtags; the image if any | needs an image: caption without links, «Посилання в біо» if there is a source, hashtags |
| album, carousel | carousel of the photos / rendered slides | carousel |
| poll, quiz | question, options as a list and «А ви як думаєте?» (no answer revealed) | skipped |
| longread | teaser + `Читати: <telegra.ph link>` | skipped |
| video | text only | skipped |

Mirrors respect the per-account cooldown (`metaCooldownMin`). A failed mirror never fails the Telegram post: it is recorded on
the slot as a warning:
```sql
SELECT scheduled_at, channel_key, error FROM editor_slots WHERE status = 'published' AND error LIKE '%crosspost:%' ORDER BY scheduled_at DESC LIMIT 20;
```
Turn mirrors off for one channel with `UPDATE editor_channels SET crosspost = false WHERE channel_key = …` (or the card form).

TikTok is not mirrored: no channel → TikTok account link exists yet. TikTok photo carousels stay a `recipe-carousel` binding.

## 9. Editor chat (spec 010)

`/app/chat` (sidebar "Chat") is a Claude-style conversation with the **composer** agent. You write "зроби пост про X у
@channel з вікториною"; the agent researches with the executor's read tools (feeds, web, `fetch_api`, library, stats),
saves a **draft** and shows it as a Telegram preview card. You ask for changes in plain language, then click
**Опублікувати зараз** or **Запланувати** (date and time in Kyiv), or tell the agent "опублікуй" / "заплануй на завтра о 19".

**Enable.** Apply `047_editor_chat`. The chat needs only `OPENROUTER_API_KEY`; it does **not** depend on `EDITOR_ENABLED`.
Its LLM spend counts against the **global** `EDITOR_DAILY_BUDGET_USD` (runs have `role='composer'`, `channel_key` NULL).

**What the agent can and cannot do.**
- It never publishes on its own. `publish_draft` / `schedule_draft` work only when your **latest message** explicitly asks
  (keywords like «опублікуй», «запости», «заплануй», «постав на», «відклади на», "publish", "schedule"; a negated «не
  публікуй» does not count). Otherwise it refuses with `needs_explicit_request` and offers the buttons. Text in fetched pages
  cannot trigger a publish. The buttons always work (your click is the request).
- Every publish, from a button or the agent, goes through `DraftsService`: lint, PDR quiz ground truth, the verbatim-copy guard for retold library content, `publish_paused`, and
  a 7-day dedup on `source.url` / `library_ref` per channel. It does **not** apply the planner's daily cap, quiet hours or min
  gap (you asked for this post explicitly), and it publishes even if the channel's card is `off` or `shadow`.
- Posts are `published_posts.strategy_type='chat'`. Mirrors to Meta run only when the channel has a real card with
  `crosspost` on.

**Channels without a card.** Any own channel (`tracked_channels.is_mine`) or carded channel can be used. Without a card the
chat uses a **default card**: every format, any hashtag (0–5), inline links, sparse emoji, no mirrors. Scheduling for such a
channel creates a minimal `editor_channels` row with `mode='off'` and those defaults (the planner ignores `off`).
Side effect: a channel with any card gets 008's ad approvals as reserved slots instead of the SP2 queue.

**Scheduling.** "Запланувати" (or the agent's `schedule_draft`) needs a time at least 2 minutes ahead and at most 60 days
ahead. It reserves an `editor_slots` row (`kind='reserved'`, topic `Чат: <title>`, `source_hints` `chat_draft:<id>`,
`post_spec` = the draft) in the day's plan (a `reserved only` plan when the day has none) and links it via
`editor_drafts.slot_id`. Every scheduler tick, `ReservedDispatcher` publishes due reserved slots without an LLM:
ad-owned slots take the 008 sponsored path; a slot without an order and with a valid PostSpec is a chat post. It runs even
with `EDITOR_ENABLED=false` or the card `off`; `publish_paused` blocks it. It is never more than 6 h late and never retried:
on failure the slot and the draft become `failed` and you get `⚠️ Запланований пост у … не вийшов: …`.
Rescheduling or cancelling skips the old slot; "publish now" on a scheduled draft skips its slot first.

**REST** (TrackingAuthGuard): `GET/POST api/editor/chats`, `GET/DELETE api/editor/chats/:id`,
`POST api/editor/chats/:id/messages` (body `{text, channel?}`; streams `application/x-ndjson` events `tool_call`,
`tool_result`, `text`, `draft`, `message`, `error`, `done`; a disconnect only stops the stream, the answer is still saved),
`GET api/editor/chat-channels`, `GET api/editor/drafts?status=&chat=`, `POST api/editor/drafts/:id/publish`,
`POST api/editor/drafts/:id/schedule {at: "YYYY-MM-DD HH:MM" (Kyiv) | ISO}`, `POST api/editor/drafts/:id/cancel`.
Refusals come back as 4xx with the same `{error, details}` the agent sees (`lint_failed`, `source_already_posted`,
`channel_paused`, `too_soon`, `slot_in_progress`…).

| Need | How |
|---|---|
| What is scheduled | Left column "Заплановано", or `SELECT scheduled_at, channel_key, spec->>'title' FROM editor_drafts WHERE status='scheduled' ORDER BY scheduled_at` |
| Cancel a scheduled post | "Скасувати" on its card, or `POST api/editor/drafts/:id/cancel` |
| Why the agent did something | `SELECT * FROM editor_run_steps WHERE run_id = (SELECT run_id FROM editor_chat_messages WHERE id = …) ORDER BY idx` |
| Live evals of the chat | `npx tsx --env-file=../../.env evals/run-evals.ts --case chat-schedule-tomorrow,chat-draft-only` (scratch DB) |
