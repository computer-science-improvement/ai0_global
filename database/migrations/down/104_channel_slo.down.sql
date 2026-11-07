-- Down for 104_channel_slo.sql (spec 091). The SLO table and the slot marker go. Pauses closed by the migration stay
-- closed (the old breaker re-pauses a channel after the next streak). Idempotent.
DROP TABLE IF EXISTS channel_slo;
ALTER TABLE editor_slots DROP COLUMN IF EXISTS slo;
DELETE FROM schema_migrations WHERE version = '104_channel_slo';
