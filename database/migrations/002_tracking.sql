-- 002_tracking.sql
-- Channel-tracking platform (Phase 1): channels under monitoring + per-post
-- snapshots + ad-link edges between channels.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS tracked_channels (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tg_chat_id      BIGINT UNIQUE,
  username        TEXT,
  title           TEXT,
  about           TEXT,
  category        TEXT,
  is_mine         BOOLEAN NOT NULL DEFAULT FALSE,
  is_closed       BOOLEAN NOT NULL DEFAULT FALSE,
  poll_tier       TEXT NOT NULL DEFAULT 'warm',
  subs_count      INT,
  added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_polled_at  TIMESTAMPTZ,
  meta            JSONB
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tracked_channels_username
  ON tracked_channels (LOWER(username)) WHERE username IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tracked_channels_tier_polled
  ON tracked_channels (poll_tier, last_polled_at);
CREATE INDEX IF NOT EXISTS idx_tracked_channels_is_mine
  ON tracked_channels (is_mine);

CREATE TABLE IF NOT EXISTS tracked_subs_history (
  channel_id   UUID NOT NULL REFERENCES tracked_channels(id) ON DELETE CASCADE,
  snapshot_at  TIMESTAMPTZ NOT NULL,
  subs_count   INT NOT NULL,
  PRIMARY KEY (channel_id, snapshot_at)
);

CREATE TABLE IF NOT EXISTS tracked_posts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id       UUID NOT NULL REFERENCES tracked_channels(id) ON DELETE CASCADE,
  tg_message_id    BIGINT NOT NULL,
  text             TEXT,
  has_media        BOOLEAN NOT NULL DEFAULT FALSE,
  media_type       TEXT,
  posted_at        TIMESTAMPTZ NOT NULL,
  views            INT,
  forwards         INT,
  reactions_total  INT,
  reactions        JSONB,
  comments_count   INT,
  ad_refs          JSONB,
  last_metrics_at  TIMESTAMPTZ,
  UNIQUE (channel_id, tg_message_id)
);
CREATE INDEX IF NOT EXISTS idx_tracked_posts_channel_posted
  ON tracked_posts (channel_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_tracked_posts_ad_refs
  ON tracked_posts USING GIN (ad_refs)
  WHERE ad_refs IS NOT NULL;

CREATE TABLE IF NOT EXISTS tracked_post_metrics_history (
  post_id      UUID NOT NULL REFERENCES tracked_posts(id) ON DELETE CASCADE,
  snapshot_at  TIMESTAMPTZ NOT NULL,
  views        INT NOT NULL,
  forwards     INT NOT NULL,
  reactions    INT NOT NULL,
  comments     INT NOT NULL,
  PRIMARY KEY (post_id, snapshot_at)
);

CREATE TABLE IF NOT EXISTS tracked_ad_edges (
  source_channel_id  UUID NOT NULL REFERENCES tracked_channels(id) ON DELETE CASCADE,
  target_channel_id  UUID REFERENCES tracked_channels(id) ON DELETE SET NULL,
  target_username    TEXT NOT NULL,
  target_kind        TEXT NOT NULL,
  ad_post_count      INT NOT NULL DEFAULT 1,
  first_seen_at      TIMESTAMPTZ NOT NULL,
  last_seen_at       TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (source_channel_id, target_username, target_kind)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tracked_ad_edges_case_insensitive
  ON tracked_ad_edges (source_channel_id, LOWER(target_username), target_kind);
CREATE INDEX IF NOT EXISTS idx_tracked_ad_edges_target
  ON tracked_ad_edges (target_channel_id)
  WHERE target_channel_id IS NOT NULL;
