-- 093_series_pauses.sql — the dead-series breaker (spec 060).
--
-- series_pauses: a series (or an owner pin, or a resource without a series) whose last N closed slots all skipped for
-- the same cause (no material, or the source is unreachable) is paused by code: the planner stops planning it, planned
-- slots of it are skipped with `series_paused` ($0), and the owner gets one note and one card. One open pause per
-- (channel_key, series_key); a resumed pause stays as history (resumed_at, resumed_by).
--
--   series_key  'series:<name>' | 'rule:<schedule_rule_id>' | 'resource:<resource_ref>' (slots with neither)
--   label       what the owner reads (the series name, or the resource)
--   cause       'no_material' | 'source_unreachable' | 'owner' (the owner paused it from a card)
--   reason      the last skip reason, one line
--   streak      how many skips in a row led to the pause (0 for an owner pause)
--
-- Additive and idempotent (CI re-applies it).

CREATE TABLE IF NOT EXISTS series_pauses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_key TEXT NOT NULL,
  series_key  TEXT NOT NULL,
  label       TEXT NOT NULL,
  cause       TEXT NOT NULL CHECK (cause IN ('no_material', 'source_unreachable', 'owner')),
  reason      TEXT NOT NULL DEFAULT '',
  streak      INT  NOT NULL DEFAULT 0,
  paused_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resumed_at  TIMESTAMPTZ,
  resumed_by  TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_series_pauses_open ON series_pauses (channel_key, series_key) WHERE resumed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_series_pauses_channel ON series_pauses (channel_key, paused_at DESC);

INSERT INTO schema_migrations (version) VALUES ('093_series_pauses') ON CONFLICT DO NOTHING;
