-- Down for 093_series_pauses.sql (spec 060). The pauses are dropped: the planner plans every series again. The inbox
-- notes keep their text; they lose their subject and parts (the repeat rule then starts from nothing).
DROP INDEX IF EXISTS idx_agent_inbox_subject;
ALTER TABLE agent_inbox DROP COLUMN IF EXISTS parts;
ALTER TABLE agent_inbox DROP COLUMN IF EXISTS subject;
DROP TABLE IF EXISTS series_pauses;
DELETE FROM schema_migrations WHERE version = '093_series_pauses';
