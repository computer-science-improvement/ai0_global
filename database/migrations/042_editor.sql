-- 042_editor.sql
-- Editor agent (specs/003-005): channel editorial cards, memory, daily plans,
-- slots, run traces; read-only views + an `editor_ro` role for agent SQL.
-- Additive only — no existing table is altered except two nullable columns
-- on published_posts.

CREATE TABLE IF NOT EXISTS editor_channels (
  channel_key        TEXT PRIMARY KEY,
  mode               TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('off','shadow','live')),
  title              TEXT,
  language           TEXT NOT NULL DEFAULT 'uk',
  timezone           TEXT NOT NULL DEFAULT 'Europe/Kyiv',
  posts_per_day_min  SMALLINT NOT NULL DEFAULT 2 CHECK (posts_per_day_min >= 0),
  posts_per_day_max  SMALLINT NOT NULL DEFAULT 6 CHECK (posts_per_day_max >= 1),
  quiet_start_hour   SMALLINT NOT NULL DEFAULT 23 CHECK (quiet_start_hour BETWEEN 0 AND 23),
  quiet_end_hour     SMALLINT NOT NULL DEFAULT 8  CHECK (quiet_end_hour BETWEEN 0 AND 23),
  min_gap_minutes    SMALLINT NOT NULL DEFAULT 60 CHECK (min_gap_minutes >= 0),
  plan_hour          SMALLINT NOT NULL DEFAULT 6  CHECK (plan_hour BETWEEN 0 AND 23),
  brief              TEXT NOT NULL DEFAULT '',
  formats            JSONB NOT NULL DEFAULT '{"text":1,"photo":1}',
  hashtags           TEXT[] NOT NULL DEFAULT '{}',
  hashtag_min        SMALLINT NOT NULL DEFAULT 1,
  hashtag_max        SMALLINT NOT NULL DEFAULT 3,
  footer             TEXT,
  link_style         TEXT NOT NULL DEFAULT 'inline' CHECK (link_style IN ('inline','footer','button')),
  emoji_policy       TEXT NOT NULL DEFAULT 'sparse' CHECK (emoji_policy IN ('none','sparse','free')),
  skills             TEXT[] NOT NULL DEFAULT '{}',
  sources            JSONB NOT NULL DEFAULT '[]',
  tools_allow        TEXT[],
  explore_ratio      NUMERIC(3,2) NOT NULL DEFAULT 0.20 CHECK (explore_ratio BETWEEN 0 AND 1),
  daily_budget_usd   NUMERIC(8,4),
  models             JSONB NOT NULL DEFAULT '{}',
  banned_terms       TEXT[] NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (posts_per_day_min <= posts_per_day_max),
  CHECK (hashtag_min <= hashtag_max)
);

CREATE TABLE IF NOT EXISTS editor_channel_memory (
  id          BIGSERIAL PRIMARY KEY,
  channel_key TEXT NOT NULL REFERENCES editor_channels(channel_key) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('insight','rule','avoid')),
  text        TEXT NOT NULL,
  evidence    JSONB,
  created_by  TEXT NOT NULL CHECK (created_by IN ('reviewer','owner')),
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_editor_memory_channel ON editor_channel_memory (channel_key, active, created_at DESC);

CREATE TABLE IF NOT EXISTS editor_plans (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_key TEXT NOT NULL REFERENCES editor_channels(channel_key) ON DELETE CASCADE,
  plan_date   DATE NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded')),
  rationale   TEXT,
  run_id      UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_editor_plans_active ON editor_plans (channel_key, plan_date) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS editor_slots (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id           UUID NOT NULL REFERENCES editor_plans(id) ON DELETE CASCADE,
  channel_key       TEXT NOT NULL,
  scheduled_at      TIMESTAMPTZ NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'content' CHECK (kind IN ('content','reserved')),
  format            TEXT NOT NULL,
  topic             TEXT NOT NULL,
  angle             TEXT,
  source_hints      JSONB NOT NULL DEFAULT '[]',
  is_experiment     BOOLEAN NOT NULL DEFAULT false,
  status            TEXT NOT NULL DEFAULT 'planned'
                      CHECK (status IN ('planned','running','published','shadowed','skipped','failed')),
  attempts          SMALLINT NOT NULL DEFAULT 0,
  run_id            UUID,
  published_post_id BIGINT,
  post_spec         JSONB,
  rendered_preview  TEXT,
  error             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_editor_slots_due     ON editor_slots (status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_editor_slots_channel ON editor_slots (channel_key, scheduled_at DESC);

CREATE TABLE IF NOT EXISTS editor_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role              TEXT NOT NULL,
  channel_key       TEXT,
  slot_id           UUID,
  model             TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running','ok','error','budget_exceeded','max_steps','disabled')),
  steps             SMALLINT NOT NULL DEFAULT 0,
  prompt_tokens     INT NOT NULL DEFAULT 0,
  completion_tokens INT NOT NULL DEFAULT 0,
  cost_usd          NUMERIC(12,6) NOT NULL DEFAULT 0,
  error             TEXT,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_editor_runs_channel ON editor_runs (channel_key, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_editor_runs_started ON editor_runs (started_at);

CREATE TABLE IF NOT EXISTS editor_run_steps (
  id                BIGSERIAL PRIMARY KEY,
  run_id            UUID NOT NULL REFERENCES editor_runs(id) ON DELETE CASCADE,
  idx               SMALLINT NOT NULL,
  type              TEXT NOT NULL CHECK (type IN ('llm','tool')),
  tool_name         TEXT,
  input             JSONB,
  output            JSONB,
  is_error          BOOLEAN NOT NULL DEFAULT false,
  prompt_tokens     INT,
  completion_tokens INT,
  cost_usd          NUMERIC(12,6),
  duration_ms       INT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_editor_run_steps_run ON editor_run_steps (run_id, idx);

ALTER TABLE published_posts ADD COLUMN IF NOT EXISTS format         TEXT;
ALTER TABLE published_posts ADD COLUMN IF NOT EXISTS editor_slot_id UUID;

-- ── Read-only views for agents ───────────────────────────────────────────────
CREATE OR REPLACE VIEW editor_v_post_performance AS
SELECT p.channel_id,
       p.id            AS post_id,
       p.message_id,
       p.title,
       p.strategy_type,
       p.format,
       p.tags,
       p.source_url,
       p.posted_at,
       s.views,
       s.forwards,
       s.replies,
       s.reactions_total,
       ROUND((EXTRACT(EPOCH FROM (COALESCE(s.captured_at, now()) - p.posted_at)) / 3600.0)::numeric, 1) AS age_hours,
       CASE WHEN s.views IS NULL THEN NULL
            ELSE ROUND((s.views / GREATEST(EXTRACT(EPOCH FROM (s.captured_at - p.posted_at)) / 3600.0, 1))::numeric, 1)
       END AS views_per_hour
FROM published_posts p
LEFT JOIN LATERAL (
  SELECT views, forwards, replies, reactions_total, captured_at
  FROM post_stats_snapshots
  WHERE post_id = p.id
  ORDER BY captured_at DESC
  LIMIT 1
) s ON true;

CREATE OR REPLACE VIEW editor_v_channel_daily AS
SELECT d.channel_id,
       d.day,
       d.subscribers,
       (SELECT COUNT(*) FROM published_posts p
         WHERE p.channel_id = d.channel_id
           AND (p.posted_at AT TIME ZONE 'Europe/Kyiv')::date = d.day) AS posts
FROM (
  SELECT DISTINCT ON (channel_id, (captured_at AT TIME ZONE 'Europe/Kyiv')::date)
         channel_id,
         (captured_at AT TIME ZONE 'Europe/Kyiv')::date AS day,
         subscribers
  FROM channel_stats_snapshots
  ORDER BY channel_id, (captured_at AT TIME ZONE 'Europe/Kyiv')::date, captured_at DESC
) d;

-- ── editor_ro: the role agent SQL runs under (SET LOCAL ROLE) ────────────────
-- SELECT only, and only on content / stats / editor tables. Deliberately NO
-- grants on my_bots, meta_accounts, tiktok_accounts, mtproto_sessions,
-- telegraph_accounts, app_settings, ad_orders, agent_*, ai_logs, bot_logs.
-- Wrapped so a DB user without CREATEROLE degrades to "sql_readonly fails"
-- instead of failing the whole migration.
DO $$
DECLARE
  t TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'editor_ro') THEN
    CREATE ROLE editor_ro NOLOGIN;
  END IF;
  EXECUTE format('GRANT editor_ro TO %I', current_user);
  EXECUTE 'GRANT USAGE ON SCHEMA public TO editor_ro';
  FOREACH t IN ARRAY ARRAY[
    'published_posts','post_stats_snapshots','channel_stats_snapshots','tracked_channels','tracked_posts',
    'recipes','facts','quotes','prompts','on_this_day','articles','pdr_questions','birthdays','assets',
    'tg_posts','jokes','name_days',
    'editor_channels','editor_channel_memory','editor_plans','editor_slots',
    'editor_v_post_performance','editor_v_channel_daily'
  ] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON public.%I TO editor_ro', t);
    END IF;
  END LOOP;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'editor_ro not configured (insufficient privilege) — sql_readonly will be unavailable';
END $$;

INSERT INTO schema_migrations (version) VALUES ('042_editor')
  ON CONFLICT (version) DO NOTHING;
