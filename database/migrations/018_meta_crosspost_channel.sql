-- 018_meta_crosspost_channel.sql — reconcile meta_crosspost_targets to channel
-- keying. Migration 017 originally shipped with a binding_id column; the design
-- moved to channel_id (the publish sites all have the channelId). The table is
-- empty at this point (targets are only created via the API added alongside
-- this change), so a drop+recreate is safe and idempotent.

DROP TABLE IF EXISTS meta_crosspost_targets;

CREATE TABLE meta_crosspost_targets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id      UUID NOT NULL REFERENCES tracked_channels(id) ON DELETE CASCADE,
  platform        TEXT NOT NULL CHECK (platform IN ('instagram','facebook','threads')),
  meta_account_id UUID NOT NULL REFERENCES meta_accounts(id) ON DELETE CASCADE,
  mode            TEXT NOT NULL CHECK (mode IN ('mirror','teaser')),
  enabled         BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel_id, platform, meta_account_id)
);
CREATE INDEX IF NOT EXISTS idx_meta_crosspost_channel ON meta_crosspost_targets (channel_id);

INSERT INTO schema_migrations (version) VALUES ('018_meta_crosspost_channel')
  ON CONFLICT (version) DO NOTHING;
