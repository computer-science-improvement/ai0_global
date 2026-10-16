-- 079_agent_reliability.sql — agent reliability and owner control (spec 040).
--
-- • llm_budgets: the owner chat pool `editor.chat` ($1.00/day). Chat turns are `editor.chat.<role>` and no longer count
--   against the agents' production cap `editor.` (FR-001). Owner-editable on Spend → Budgets; never overwritten here.
-- • editor_runs: status `no_terminal` (a role with terminal tools ended without one, FR-003) and the loop breaker's counters
--   `repeat_blocked` / `tools_dropped` (FR-002).
-- • source_host_failures: hosts that refused or failed a fetch, blocked for 24 h so agents stop retrying them (FR-006).
-- • agent_directives: `supersedes` and status `superseded` (FR-007).
-- • manager_reviews.signature: the anomaly set + quality flags a review saw; an unchanged one skips the next run (FR-007).
-- • editor_channel_memory.source_text: the owner's own words a rule came from (FR-010).
--
-- Additive, non-destructive and idempotent (CI re-applies it).

-- ── llm_budgets ──────────────────────────────────────────────────────────────
INSERT INTO llm_budgets (scope_kind, scope_key, daily_usd, seeded_from)
VALUES ('feature_prefix', 'editor.chat', 1.00, 'spec 040')
ON CONFLICT (scope_kind, scope_key) DO NOTHING;

-- ── editor_runs ──────────────────────────────────────────────────────────────
ALTER TABLE editor_runs ADD COLUMN IF NOT EXISTS repeat_blocked SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE editor_runs ADD COLUMN IF NOT EXISTS tools_dropped  TEXT[];

-- 042 created the status CHECK inline: drop the single-column CHECK on status, whatever its name, then add the named one.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.conrelid = 'public.editor_runs'::regclass AND c.contype = 'c'
       AND array_length(c.conkey, 1) = 1 AND a.attname = 'status'
  LOOP
    EXECUTE format('ALTER TABLE editor_runs DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE editor_runs ADD CONSTRAINT editor_runs_status_check CHECK (status IN (
  'running','ok','error','budget_exceeded','max_steps','disabled','no_terminal'));

-- ── source_host_failures ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS source_host_failures (
  host          TEXT PRIMARY KEY,
  reason        TEXT NOT NULL,
  status_code   INT,
  failures      INT NOT NULL DEFAULT 1,
  first_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  blocked_until TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_source_host_failures_until ON source_host_failures (blocked_until);

-- ── agent_directives ─────────────────────────────────────────────────────────
ALTER TABLE agent_directives ADD COLUMN IF NOT EXISTS supersedes UUID REFERENCES agent_directives(id) ON DELETE SET NULL;
ALTER TABLE agent_directives DROP CONSTRAINT IF EXISTS agent_directives_status_check;
ALTER TABLE agent_directives ADD CONSTRAINT agent_directives_status_check CHECK (status IN (
  'new','awaiting_owner','accepted','rejected','applied','evaluated','expired','canceled','contested','declined','failed','superseded'));

-- ── manager_reviews ──────────────────────────────────────────────────────────
ALTER TABLE manager_reviews ADD COLUMN IF NOT EXISTS signature TEXT;

-- ── editor_channel_memory ────────────────────────────────────────────────────
ALTER TABLE editor_channel_memory ADD COLUMN IF NOT EXISTS source_text TEXT;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'editor_ro') THEN
    EXECUTE 'GRANT SELECT ON public.source_host_failures TO editor_ro';
  END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES ('079_agent_reliability')
  ON CONFLICT (version) DO NOTHING;
