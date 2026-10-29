-- Down for 097_channel_readiness.sql (spec 072). The stored readiness rows are dropped: the dashboard and the owner bot lose the
-- panel until the doctor is back; the next deploy of 072 recomputes every row. Idempotent.
DROP INDEX IF EXISTS idx_channel_readiness_open;
DROP TABLE IF EXISTS channel_readiness;
DELETE FROM schema_migrations WHERE version = '097_channel_readiness';
