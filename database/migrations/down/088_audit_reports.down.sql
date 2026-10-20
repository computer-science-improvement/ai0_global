-- Down for 088_audit_reports.sql (spec 055). Agents of kind 'auditor' are removed first (the old check forbids them).
DELETE FROM agents WHERE kind = 'auditor';
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_kind_check;
ALTER TABLE agents ADD CONSTRAINT agents_kind_check
  CHECK (kind IN ('manager','builder','orchestrator','planner','ideator','idea_reviewer','executor','reviewer'));
DROP TABLE IF EXISTS audit_dismissals;
DROP TABLE IF EXISTS audit_reports;
DELETE FROM schema_migrations WHERE version = '088_audit_reports';
