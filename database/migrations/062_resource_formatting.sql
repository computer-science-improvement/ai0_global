-- 062_resource_formatting.sql — derived posts and agent-owned formatting (spec 024 T3, T4, T8).
--
-- • media_holds: hosted slides of a source slot that has derived (duplicate /
--   adapt) slots still pending; deleted after the last derived slot finishes or
--   after 24 h (FR-007).
--
-- Additive and idempotent.

-- ── delayed media cleanup (T3) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS media_holds (
  slot_id    UUID PRIMARY KEY REFERENCES editor_slots(id) ON DELETE CASCADE,
  paths      TEXT[] NOT NULL DEFAULT '{}',
  urls       TEXT[] NOT NULL DEFAULT '{}',
  hold_until TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_media_holds_until ON media_holds (hold_until);

INSERT INTO schema_migrations (version) VALUES ('062_resource_formatting')
  ON CONFLICT (version) DO NOTHING;
