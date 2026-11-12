-- Down for 105_mcp_connector.sql (spec 103). The connector's OAuth state and audit go, and so do the slot lock and
-- origin columns: locked slots become ordinary slots again. Idempotent.
DROP TABLE IF EXISTS mcp_audit;
DROP TABLE IF EXISTS mcp_oauth_tokens;
DROP TABLE IF EXISTS mcp_oauth_grants;
DROP TABLE IF EXISTS mcp_oauth_requests;
DROP TABLE IF EXISTS mcp_oauth_clients;
DROP INDEX IF EXISTS idx_editor_slots_locked;
ALTER TABLE editor_slots DROP CONSTRAINT IF EXISTS editor_slots_created_via_chk;
ALTER TABLE editor_slots DROP CONSTRAINT IF EXISTS editor_slots_locked_by_chk;
ALTER TABLE editor_chats DROP CONSTRAINT IF EXISTS editor_chats_created_via_chk;
ALTER TABLE editor_slots DROP COLUMN IF EXISTS created_via;
ALTER TABLE editor_slots DROP COLUMN IF EXISTS locked_by;
ALTER TABLE editor_slots DROP COLUMN IF EXISTS locked_at;
ALTER TABLE editor_chats DROP COLUMN IF EXISTS created_via;
DELETE FROM schema_migrations WHERE version = '105_mcp_connector';
