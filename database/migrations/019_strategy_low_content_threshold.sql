-- 019_strategy_low_content_threshold.sql — per-strategy low-content alert
-- threshold (posts). NULL means "use the default" (100, in code). Additive,
-- nullable, no backfill.

ALTER TABLE strategy_bindings
  ADD COLUMN IF NOT EXISTS low_content_threshold INTEGER;

INSERT INTO schema_migrations (version) VALUES ('019_strategy_low_content_threshold')
  ON CONFLICT (version) DO NOTHING;
