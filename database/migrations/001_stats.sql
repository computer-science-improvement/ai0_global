-- 001_stats.sql
-- Statistics module: persistent record of published posts + hourly snapshots
-- of per-post metrics (views, reactions, forwards) and per-channel metrics
-- (subscribers, metadata).

-- Tracks which migrations have been applied. Created first; migration runner
-- also ensures this table exists before applying anything else.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     VARCHAR(64) PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per successful publication.
CREATE TABLE IF NOT EXISTS published_posts (
  id            BIGSERIAL PRIMARY KEY,
  channel_id    VARCHAR(128) NOT NULL,
  message_id    BIGINT       NOT NULL,
  source_url    TEXT,
  title         TEXT,
  strategy_type VARCHAR(64),
  tags          TEXT[],
  posted_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (channel_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_published_posts_channel_time
  ON published_posts (channel_id, posted_at DESC);

-- Hourly snapshot per post.
CREATE TABLE IF NOT EXISTS post_stats_snapshots (
  id              BIGSERIAL PRIMARY KEY,
  post_id         BIGINT       NOT NULL REFERENCES published_posts(id) ON DELETE CASCADE,
  captured_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  views           INT,
  forwards        INT,
  replies         INT,
  reactions       JSONB,
  reactions_total INT
);
CREATE INDEX IF NOT EXISTS idx_post_stats_post_time
  ON post_stats_snapshots (post_id, captured_at DESC);

-- Hourly snapshot per channel.
CREATE TABLE IF NOT EXISTS channel_stats_snapshots (
  id            BIGSERIAL PRIMARY KEY,
  channel_id    VARCHAR(128) NOT NULL,
  captured_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  subscribers   INT,
  title         TEXT,
  description   TEXT,
  online_count  INT
);
CREATE INDEX IF NOT EXISTS idx_channel_stats_channel_time
  ON channel_stats_snapshots (channel_id, captured_at DESC);
