-- 076_silent_days.sql — silent days: the fallback ladder trace and the daily owner alerts (spec 037 FR-010, T10).
--
-- (073 and 074 are reserved for spec 037 T2 story registry and T14 post audit; 075 is T16 ledger_url_canonical.)
--
-- • editor_slots.fallback: the fallback ladder of a slot whose post failed (critic reject, lint / guard failure):
--   { steps: [{ step: initial|next_candidate|lighter_format|evergreen, at, format, outcome, reason, verdict,
--               run_id, cost_usd, source_url? }],
--     final: { outcome: rescued|skipped|ended, code, step, reason } }.
--   The run trace of every step is its own editor_runs row (run_id). NULL = the slot never climbed the ladder.
-- • A unique partial index on agent_inbox for the once-per-resource-per-day alerts (dark_day, series_missed,
--   critic_reject_streak): ref_type 'resource_day', ref_id '<resource_ref>|<local date>'. A second check the same
--   day cannot insert a duplicate even from two processes.
--
-- Additive, guarded and idempotent: CI re-applies this file.

DO $$
BEGIN
  IF to_regclass('public.editor_slots') IS NOT NULL THEN
    ALTER TABLE editor_slots ADD COLUMN IF NOT EXISTS fallback JSONB;
  END IF;
  IF to_regclass('public.agent_inbox') IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_inbox_resource_day
      ON agent_inbox (kind, ref_id) WHERE ref_type = 'resource_day';
  END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES ('076_silent_days')
  ON CONFLICT (version) DO NOTHING;
