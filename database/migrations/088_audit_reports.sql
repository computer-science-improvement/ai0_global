-- 088_audit_reports.sql — the sysadmin's weekly audit (spec 055).
--
-- • audit_reports: one report per run. `findings` holds every finding with its status (open | applied | dismissed |
--   failed), so a report is its own version. `week` (ISO, Kyiv) with trigger 'schedule' is unique: the weekly claim
--   is the insert, so a restart or a second instance never runs the same week twice.
-- • audit_dismissals: a finding key the owner dismissed until a date; the next report leaves it out.
-- • agents.kind gains 'auditor' (@sysadmin, kind auditor, system scope).
--
-- Additive, non-destructive and idempotent (CI re-applies it).

CREATE TABLE IF NOT EXISTS audit_reports (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week         TEXT NOT NULL,
  trigger      TEXT NOT NULL CHECK (trigger IN ('schedule', 'owner')),
  status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  findings     JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary      TEXT,
  llm          JSONB,
  cost_usd     NUMERIC(10, 6) NOT NULL DEFAULT 0,
  error        TEXT,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_reports_week ON audit_reports (week) WHERE trigger = 'schedule';
CREATE INDEX IF NOT EXISTS idx_audit_reports_started ON audit_reports (started_at DESC);

CREATE TABLE IF NOT EXISTS audit_dismissals (
  finding_key  TEXT PRIMARY KEY,
  until        TIMESTAMPTZ NOT NULL,
  by           TEXT NOT NULL DEFAULT 'owner',
  at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
DECLARE c TEXT;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'agents'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%builder%' AND pg_get_constraintdef(oid) LIKE '%orchestrator%'
     AND pg_get_constraintdef(oid) NOT LIKE '%created_by%' AND pg_get_constraintdef(oid) NOT LIKE '%auditor%'
   LIMIT 1;
  IF c IS NOT NULL THEN
    EXECUTE format('ALTER TABLE agents DROP CONSTRAINT %I', c);
    ALTER TABLE agents ADD CONSTRAINT agents_kind_check
      CHECK (kind IN ('manager','builder','auditor','orchestrator','planner','ideator','idea_reviewer','executor','reviewer'));
  END IF;
END $$;
