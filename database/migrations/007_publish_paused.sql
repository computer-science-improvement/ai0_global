-- 007_publish_paused.sql
-- Per-channel publishing kill switch. Orthogonal to strategy_bindings.enabled
-- and to my_bots.active. When true, TelegramPublisher silently refuses to
-- publish or forward content into this channel, regardless of which strategy
-- or forward route triggered the attempt. Reversible by flipping back to
-- false from the dashboard (no row deletion needed).

ALTER TABLE tracked_channels
  ADD COLUMN IF NOT EXISTS publish_paused BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_tracked_channels_publish_paused
  ON tracked_channels (publish_paused) WHERE publish_paused = TRUE;

INSERT INTO schema_migrations (version) VALUES ('007_publish_paused')
  ON CONFLICT (version) DO NOTHING;
