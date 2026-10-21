-- Down for 092_skill_probe.sql (spec 059). A version still being probed or rejected by a probe never went live: both
-- become 'superseded' (the history row stays), then the outcome check goes back to its four states.
UPDATE skill_versions SET outcome = 'superseded' WHERE outcome IN ('probing', 'rejected');
DROP INDEX IF EXISTS idx_skill_versions_probing;
ALTER TABLE skill_versions DROP CONSTRAINT IF EXISTS skill_versions_outcome_check;
ALTER TABLE skill_versions ADD CONSTRAINT skill_versions_outcome_check
  CHECK (outcome IN ('pending', 'kept', 'rolled_back', 'superseded'));
ALTER TABLE skill_versions DROP COLUMN IF EXISTS probe;
DELETE FROM schema_migrations WHERE version = '092_skill_probe';
