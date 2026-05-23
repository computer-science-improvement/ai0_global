-- 006_strategy_runs.sql
-- Phase 5c: per-execution log of cron-fired strategies. Used by the dashboard
-- to show recent runs + outcomes alongside the next-run timestamp. Append-only.

CREATE TABLE IF NOT EXISTS strategy_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id   UUID NOT NULL,
  ext_id        TEXT NOT NULL,   -- denormalized, so a deleted strategy keeps history
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  status        TEXT NOT NULL,   -- 'running' | 'ok' | 'error' | 'skipped'
  error         TEXT,
  duration_ms   INTEGER          -- finished_at - started_at, denormalized for fast sort
);

CREATE INDEX IF NOT EXISTS idx_strategy_runs_strategy_started
  ON strategy_runs (strategy_id, started_at DESC);

-- Foreign key — ON DELETE CASCADE means deleting a strategy also drops its
-- history. We mirror ext_id above so dashboard listing can still resolve
-- "this run was for strategy X" if it scoops up rows from a deleted strategy
-- via a different query path.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_strategy_runs_strategy') THEN
    ALTER TABLE strategy_runs
      ADD CONSTRAINT fk_strategy_runs_strategy
      FOREIGN KEY (strategy_id) REFERENCES strategy_bindings(id) ON DELETE CASCADE;
  END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES ('006_strategy_runs')
  ON CONFLICT (version) DO NOTHING;
