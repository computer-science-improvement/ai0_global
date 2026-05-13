-- 003_roi_cache.sql
-- Cached output of RoiAnalyzerService. 7-day TTL by application convention.

CREATE TABLE IF NOT EXISTS tracked_roi_cache (
  channel_id            UUID PRIMARY KEY REFERENCES tracked_channels(id) ON DELETE CASCADE,
  estimated_subs_per_ad INT NOT NULL,
  confidence            TEXT NOT NULL,
  narrative             TEXT,
  risks                 JSONB,
  inputs                JSONB,
  computed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  source                TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tracked_roi_cache_computed ON tracked_roi_cache (computed_at DESC);
