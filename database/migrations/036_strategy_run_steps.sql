-- 036_strategy_run_steps.sql — per-run execution trace.
--
-- A run was only ever stored at run-level (status + one error string), so when a
-- publish failed you couldn't see what ran, in what order, how long each step
-- took, or where it broke — and swallowed fan-out failures (IG/Threads mirror)
-- never surfaced at all. `steps` holds an ordered chain recorded by the run
-- tracer: [{ seq, service, action, status, durationMs, detail?, error? }].
ALTER TABLE strategy_runs
  ADD COLUMN IF NOT EXISTS steps JSONB NOT NULL DEFAULT '[]'::jsonb;

INSERT INTO schema_migrations (version) VALUES ('036_strategy_run_steps') ON CONFLICT DO NOTHING;
