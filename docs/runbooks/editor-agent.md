# Runbook: editor agent

Autonomous per-channel editor (specs [003](../../specs/003-editor-harness/spec.md),
[004](../../specs/004-post-spec-and-skills/spec.md), [005](../../specs/005-editor-roles/spec.md)).

Every channel has three roles:
- **Planner:** runs once a day and builds the day's plan of slots: time, format and topic.
- **Executor:** runs once per slot. It gathers material, writes a `PostSpec`, and then publishes it or skips the slot.
- **Reviewer:** runs weekly. It turns stats into channel memory and format weights.

Everything runs on OpenRouter (`z-ai/glm-5.3-flash` by default, about $0.006 per post).

## 1. Enable

1. Apply migration `042_editor` (`database/migrate.sh`, or let the service apply it at boot).
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
    {"id":"library_facts","kind":"library","ref":"facts"}]',
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
- `models`: `{"executor":"z-ai/glm-5.3"}` gives this channel a stronger writer.
- `daily_budget_usd`: per-channel spend cap.

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
- **Web access.** `web_fetch`, `fetch_feed` and `extract_images` are SSRF-guarded on every redirect hop.
- **No other powers.** Runtime agents have no shell, no file writes and no account actions.
