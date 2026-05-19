-- 004_discovery.sql
-- Phase 4 MVP: candidate channels from external catalogs + themes on tracked channels.

CREATE TABLE IF NOT EXISTS candidate_channels (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source        TEXT NOT NULL,
  external_id   TEXT NOT NULL,
  slug          TEXT NOT NULL,
  link          TEXT NOT NULL,
  title         TEXT NOT NULL,
  description   TEXT,
  language      TEXT,
  themes        TEXT[] NOT NULL DEFAULT '{}',
  sex_ratio     INTEGER,
  price_min     INTEGER,
  price_max     INTEGER,
  avatar_url    TEXT,
  raw_payload   JSONB NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, external_id)
);

CREATE INDEX IF NOT EXISTS idx_candidate_channels_themes ON candidate_channels USING GIN (themes);
CREATE INDEX IF NOT EXISTS idx_candidate_channels_slug ON candidate_channels (LOWER(slug));
CREATE INDEX IF NOT EXISTS idx_candidate_channels_price ON candidate_channels (price_min);

ALTER TABLE tracked_channels
  ADD COLUMN IF NOT EXISTS themes TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_tracked_channels_themes
  ON tracked_channels USING GIN (themes);

INSERT INTO schema_migrations (version) VALUES ('004_discovery')
  ON CONFLICT (version) DO NOTHING;
