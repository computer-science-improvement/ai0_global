-- 092_skill_probe.sql — probe before adopt: a skill self-edit is tried on recent posts before it goes live (spec 059).
--
-- skill_versions.outcome gets two states: 'probing' (written, not live yet — skills.body / current_version still point at
-- the previous version) and 'rejected' (the probe found the edit worse; it never went live). The existing states keep
-- their meaning ('pending' = live under the 7-day KPI review).
--
-- skill_versions.probe: the evidence of the probe as JSON — { verdict, reason?, samples[], costUsd, at } (the old and new
-- preview of each sample slot, the critic verdicts, the judge's reasons). Null for every version made without a probe.
--
-- Additive and idempotent (CI re-applies it): the old outcome check is looked up by definition, not by name.

ALTER TABLE skill_versions ADD COLUMN IF NOT EXISTS probe JSONB;

DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'skill_versions'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%outcome%'
  LOOP
    EXECUTE format('ALTER TABLE skill_versions DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE skill_versions ADD CONSTRAINT skill_versions_outcome_check
    CHECK (outcome IN ('pending', 'kept', 'rolled_back', 'superseded', 'probing', 'rejected'));
END $$;

CREATE INDEX IF NOT EXISTS idx_skill_versions_probing ON skill_versions (created_at) WHERE outcome = 'probing';

INSERT INTO schema_migrations (version) VALUES ('092_skill_probe') ON CONFLICT DO NOTHING;
