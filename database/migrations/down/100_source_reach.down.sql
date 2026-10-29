-- Down for 100_source_reach.sql (spec 076). The probes and the three counters go. A block of the new reason becomes a
-- plain `timeout` block (the old code does not know `unreachable`); `blocked_until` is kept, so the old code simply waits it
-- out. Every statement is idempotent: running it twice is harmless.
DROP TABLE IF EXISTS source_probes;
ALTER TABLE source_host_failures DROP COLUMN IF EXISTS consecutive_timeouts;
ALTER TABLE source_host_failures DROP COLUMN IF EXISTS timeouts_since;
ALTER TABLE source_host_failures DROP COLUMN IF EXISTS last_success_at;
UPDATE source_host_failures SET reason = 'timeout' WHERE reason = 'unreachable';
DELETE FROM schema_migrations WHERE version = '100_source_reach';
