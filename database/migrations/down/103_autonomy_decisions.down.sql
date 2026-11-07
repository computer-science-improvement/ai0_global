-- Down for 103_autonomy_decisions.sql (spec 090). The decision log goes; nothing else depends on it (writers swallow their
-- errors). Idempotent: running it twice is harmless.
DROP TABLE IF EXISTS autonomy_decisions;
DELETE FROM schema_migrations WHERE version = '103_autonomy_decisions';
