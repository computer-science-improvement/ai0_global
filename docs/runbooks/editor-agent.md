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
3. Restart automation. The log shows `editor ENABLED: N tools, M skills`.

`EDITOR_ENABLED` is the global kill switch. With it set to `false`, nothing runs, including slots that are already planned.

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

## 5. Alerts you will get (admin bot)

- Budget exhausted (global or per channel), once a day.
- The planner failed to produce a plan.
- 3 slots in a row failed on a channel.
- Weekly reviewer summary (Mondays).

## 6. Safety model (what the model cannot do)

- **Publishing.** The only publishing path is `publish_post`. In code it enforces:
  - slot state and lint
  - similarity < 0.6 and dedup by source or library row
  - in live mode only: daily cap, quiet hours and min gap
- **HTML.** The model never writes HTML. The renderer escapes everything.
- **Database.** `sql_readonly` runs as the `editor_ro` role inside a READ ONLY transaction with a 3 s timeout. That role cannot see `my_bots`, `meta_accounts`, `mtproto_sessions`, `app_settings`, `ad_orders`, `agent_*` or the logs.
- **Web access.** `web_fetch`, `fetch_feed` and `extract_images` are SSRF-guarded on every redirect hop.
- **No other powers.** Runtime agents have no shell, no file writes and no account actions.
