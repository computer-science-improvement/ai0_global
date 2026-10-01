# 003/004/005: Data model (migration `042_editor.sql`)

All tables are new. The only existing table that changes is `published_posts`, which gains two columns; nothing existing is dropped or rewritten.

```sql
-- Channel editorial card (005). channel_key = tracked_channels.channel_key / the key
-- ChannelConfigService.resolveChannel accepts.
editor_channels (
  channel_key        TEXT PRIMARY KEY,
  mode               TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('off','shadow','live')),
  title              TEXT,
  language           TEXT NOT NULL DEFAULT 'uk',
  timezone           TEXT NOT NULL DEFAULT 'Europe/Kyiv',
  posts_per_day_min  SMALLINT NOT NULL DEFAULT 2,
  posts_per_day_max  SMALLINT NOT NULL DEFAULT 6,
  quiet_start_hour   SMALLINT NOT NULL DEFAULT 23,   -- local, inclusive
  quiet_end_hour     SMALLINT NOT NULL DEFAULT 8,    -- local, exclusive
  min_gap_minutes    SMALLINT NOT NULL DEFAULT 60,
  plan_hour          SMALLINT NOT NULL DEFAULT 6,    -- local hour the planner runs
  brief              TEXT NOT NULL DEFAULT '',       -- what the channel is about, audience
  formats            JSONB NOT NULL DEFAULT '{"text":1,"photo":1}',  -- format -> weight
  hashtags           TEXT[] NOT NULL DEFAULT '{}',   -- allowed vocabulary (without #)
  hashtag_min        SMALLINT NOT NULL DEFAULT 1,
  hashtag_max        SMALLINT NOT NULL DEFAULT 3,
  footer             TEXT,                           -- signature line, HTML-free
  link_style         TEXT NOT NULL DEFAULT 'inline' CHECK (link_style IN ('inline','footer','button')),
  emoji_policy       TEXT NOT NULL DEFAULT 'sparse' CHECK (emoji_policy IN ('none','sparse','free')),
  skills             TEXT[] NOT NULL DEFAULT '{}',   -- channel/voice skills always loaded
  sources            JSONB NOT NULL DEFAULT '[]',    -- [{id,kind:'rss'|'url'|'library',ref,note}]
  tools_allow        TEXT[],                         -- NULL = role defaults
  explore_ratio      NUMERIC(3,2) NOT NULL DEFAULT 0.20,
  daily_budget_usd   NUMERIC(8,4),                   -- NULL = env default
  models             JSONB NOT NULL DEFAULT '{}',    -- role -> model id override
  banned_terms       TEXT[] NOT NULL DEFAULT '{}',
  created_at, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)

editor_channel_memory (
  id BIGSERIAL PK, channel_key TEXT NOT NULL REFERENCES editor_channels ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('insight','rule','avoid')),
  text TEXT NOT NULL, evidence JSONB, created_by TEXT NOT NULL CHECK (created_by IN ('reviewer','owner')),
  active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)

editor_plans (
  id UUID PK DEFAULT gen_random_uuid(), channel_key TEXT NOT NULL REFERENCES editor_channels ON DELETE CASCADE,
  plan_date DATE NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded')),
  rationale TEXT, run_id UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
UNIQUE INDEX ON editor_plans (channel_key, plan_date) WHERE status = 'active'

editor_slots (
  id UUID PK DEFAULT gen_random_uuid(), plan_id UUID NOT NULL REFERENCES editor_plans ON DELETE CASCADE,
  channel_key TEXT NOT NULL, scheduled_at TIMESTAMPTZ NOT NULL,
  kind TEXT NOT NULL DEFAULT 'content' CHECK (kind IN ('content','reserved')),
  format TEXT NOT NULL, topic TEXT NOT NULL, angle TEXT, source_hints JSONB NOT NULL DEFAULT '[]',
  is_experiment BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','running','published','shadowed','skipped','failed')),
  attempts SMALLINT NOT NULL DEFAULT 0, run_id UUID, published_post_id BIGINT,
  post_spec JSONB, rendered_preview TEXT, error TEXT,
  created_at, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
INDEX ON editor_slots (status, scheduled_at)

editor_runs (
  id UUID PK DEFAULT gen_random_uuid(), role TEXT NOT NULL, channel_key TEXT, slot_id UUID,
  model TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','ok','error','budget_exceeded','max_steps','disabled')),
  steps SMALLINT NOT NULL DEFAULT 0, prompt_tokens INT NOT NULL DEFAULT 0, completion_tokens INT NOT NULL DEFAULT 0,
  cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0, error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ
)
INDEX ON editor_runs (channel_key, started_at DESC); INDEX ON editor_runs (started_at)

editor_run_steps (
  id BIGSERIAL PK, run_id UUID NOT NULL REFERENCES editor_runs ON DELETE CASCADE, idx SMALLINT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('llm','tool')), tool_name TEXT,
  input JSONB, output JSONB, is_error BOOLEAN NOT NULL DEFAULT false,
  prompt_tokens INT, completion_tokens INT, cost_usd NUMERIC(12,6), duration_ms INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)

ALTER TABLE published_posts ADD COLUMN IF NOT EXISTS format TEXT,
                            ADD COLUMN IF NOT EXISTS editor_slot_id UUID;
```

## Views (read-only surface for agents)
- `editor_v_post_performance`: `published_posts` joined with the latest `post_stats_snapshots` row.
  Columns: `channel_id, post_id, message_id, title, strategy_type, format, tags, posted_at, views, forwards,
  replies, reactions_total, age_hours, views_per_hour`.
- `editor_v_channel_daily`: per channel and day, the latest subscriber count and the number of posts.

## Role `editor_ro`
`CREATE ROLE editor_ro NOLOGIN` (guarded with DO-block `IF NOT EXISTS`), then
`GRANT editor_ro TO CURRENT_USER` so the app can `SET LOCAL ROLE editor_ro`.
SELECT is granted on:
- `published_posts`, `post_stats_snapshots`, `channel_stats_snapshots`, `tracked_channels`, `tracked_posts`
- `recipes`, `facts`, `quotes`, `prompts`, `on_this_day`, `articles`, `pdr_questions`, `birthdays`, `assets`,
  `tg_posts`, `jokes`, `name_days`
- `editor_channels`, `editor_channel_memory`, `editor_plans`, `editor_slots`, the two views

Grants are issued only for tables that exist (DO-block over `to_regclass`). **No grants** on `my_bots`,
`meta_accounts`, `tiktok_accounts`, `mtproto_sessions`, `telegraph_accounts`, `app_settings`, `ad_orders`,
`agent_*`, `ai_logs` or `bot_logs`.

## State machine: `editor_slots.status`
```
planned ──claim──► running ──publish_post ok (live)──► published
                      │ ───publish_post ok (shadow)──► shadowed
                      │ ───skip_slot──────────────────► skipped
                      │ ───error / max_steps / budget─► failed   (attempts < 2 → back to planned at +15 min)
running for more than 15 min (crash) ──sweeper──► failed
```
