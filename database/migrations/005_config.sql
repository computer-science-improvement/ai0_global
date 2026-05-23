-- 005_config.sql
-- Phase 5a: Move bot/channel/strategy config from channels.<env>.json into Postgres.

CREATE TABLE IF NOT EXISTS my_bots (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id            TEXT UNIQUE NOT NULL,
  username          TEXT,
  first_name        TEXT,
  platform          TEXT NOT NULL DEFAULT 'telegram',
  token_env         TEXT NOT NULL,
  active            BOOLEAN NOT NULL DEFAULT true,
  last_verified_at  TIMESTAMPTZ,
  verify_error      TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS strategy_bindings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ext_id      TEXT UNIQUE NOT NULL,
  type        TEXT NOT NULL,
  channel_id  UUID NOT NULL,
  schedule    TEXT NOT NULL,
  params      JSONB NOT NULL DEFAULT '{}',
  enabled     BOOLEAN NOT NULL DEFAULT true,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_strategy_bindings_channel ON strategy_bindings (channel_id);
CREATE INDEX IF NOT EXISTS idx_strategy_bindings_type    ON strategy_bindings (type);
CREATE INDEX IF NOT EXISTS idx_strategy_bindings_enabled ON strategy_bindings (enabled);

CREATE TABLE IF NOT EXISTS forward_routes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_channel_id UUID NOT NULL,
  target_channel_id UUID NOT NULL,
  topic             TEXT NOT NULL,
  description       TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_channel_id, topic)
);

ALTER TABLE tracked_channels
  ADD COLUMN IF NOT EXISTS channel_key TEXT,
  ADD COLUMN IF NOT EXISTS kind        TEXT,
  ADD COLUMN IF NOT EXISTS bot_id      UUID;

CREATE UNIQUE INDEX IF NOT EXISTS uq_tracked_channels_channel_key
  ON tracked_channels (channel_key) WHERE channel_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tracked_channels_bot ON tracked_channels (bot_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_strategy_bindings_channel') THEN
    ALTER TABLE strategy_bindings
      ADD CONSTRAINT fk_strategy_bindings_channel
      FOREIGN KEY (channel_id) REFERENCES tracked_channels(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_forward_routes_source') THEN
    ALTER TABLE forward_routes
      ADD CONSTRAINT fk_forward_routes_source
      FOREIGN KEY (source_channel_id) REFERENCES tracked_channels(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_forward_routes_target') THEN
    ALTER TABLE forward_routes
      ADD CONSTRAINT fk_forward_routes_target
      FOREIGN KEY (target_channel_id) REFERENCES tracked_channels(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_tracked_channels_bot') THEN
    ALTER TABLE tracked_channels
      ADD CONSTRAINT fk_tracked_channels_bot
      FOREIGN KEY (bot_id) REFERENCES my_bots(id) ON DELETE SET NULL;
  END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES ('005_config')
  ON CONFLICT (version) DO NOTHING;
