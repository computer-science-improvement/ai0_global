-- Down for 082_agent_voice.sql (spec 047).
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_grammatical_gender_check;
ALTER TABLE agents DROP COLUMN IF EXISTS grammatical_gender;
DELETE FROM schema_migrations WHERE version = '082_agent_voice';
