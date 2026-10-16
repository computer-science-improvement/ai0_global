-- Down for 079_agent_reliability.sql (spec 040). Rows using the new statuses are mapped back first.
UPDATE editor_runs SET status = 'max_steps' WHERE status = 'no_terminal';
ALTER TABLE editor_runs DROP CONSTRAINT IF EXISTS editor_runs_status_check;
ALTER TABLE editor_runs ADD CONSTRAINT editor_runs_status_check CHECK (status IN (
  'running','ok','error','budget_exceeded','max_steps','disabled'));
ALTER TABLE editor_runs DROP COLUMN IF EXISTS repeat_blocked;
ALTER TABLE editor_runs DROP COLUMN IF EXISTS tools_dropped;

UPDATE agent_directives SET status = 'canceled' WHERE status = 'superseded';
ALTER TABLE agent_directives DROP CONSTRAINT IF EXISTS agent_directives_status_check;
ALTER TABLE agent_directives ADD CONSTRAINT agent_directives_status_check CHECK (status IN (
  'new','awaiting_owner','accepted','rejected','applied','evaluated','expired','canceled','contested','declined','failed'));
ALTER TABLE agent_directives DROP COLUMN IF EXISTS supersedes;

DROP TABLE IF EXISTS source_host_failures;
ALTER TABLE editor_channel_memory DROP COLUMN IF EXISTS source_text;
DELETE FROM llm_budgets WHERE scope_kind = 'feature_prefix' AND scope_key = 'editor.chat' AND seeded_from = 'spec 040';
DELETE FROM schema_migrations WHERE version = '079_agent_reliability';
