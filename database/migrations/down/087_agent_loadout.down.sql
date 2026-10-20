-- Down for 087_agent_loadout.sql (spec 054).
ALTER TABLE editor_runs DROP COLUMN IF EXISTS tools_offered;
DROP TABLE IF EXISTS agent_tools;
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_loadout_mode_check;
ALTER TABLE agents DROP COLUMN IF EXISTS loadout_mode;
DELETE FROM schema_migrations WHERE version = '087_agent_loadout';
