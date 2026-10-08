-- 065_directive_binding.sql — binding directives vs optional advice, and executor bookkeeping (spec 025 FR-001).
--
-- • agent_directives.binding: 'directive' (the orchestrator must carry it out) or 'advice' (optional).
--   Existing kind='advice' rows are backfilled to binding='advice'.
-- • Executor bookkeeping: change (the executor's diff), exec_attempts / exec_error (hourly retry, `failed`
--   after 3), verification / verified_at (observed in plans and publishing), contested_at.
-- • Status and owner_decision CHECKs are widened (contested, declined, failed; upheld, refusal_accepted).
-- • playbooks.directive_id links a version written by a directive executor; created_by gains 'directive'.
-- • resource_pauses: pauses of one resource by a pause_resource directive (spec 025 FR-013, used from T4).
--
-- Additive, non-destructive and idempotent (CI re-applies it).

-- ── agent_directives ─────────────────────────────────────────────────────────
ALTER TABLE agent_directives ADD COLUMN IF NOT EXISTS binding       TEXT NOT NULL DEFAULT 'directive';
ALTER TABLE agent_directives ADD COLUMN IF NOT EXISTS change        JSONB;
ALTER TABLE agent_directives ADD COLUMN IF NOT EXISTS exec_attempts SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE agent_directives ADD COLUMN IF NOT EXISTS exec_error    TEXT;
ALTER TABLE agent_directives ADD COLUMN IF NOT EXISTS verification  JSONB;
ALTER TABLE agent_directives ADD COLUMN IF NOT EXISTS verified_at   TIMESTAMPTZ;
ALTER TABLE agent_directives ADD COLUMN IF NOT EXISTS contested_at  TIMESTAMPTZ;

UPDATE agent_directives SET binding = 'advice' WHERE kind = 'advice' AND binding <> 'advice';

-- Widen the CHECKs: whatever their names are (053 created them inline), drop the single-column CHECKs on
-- status / owner_decision / binding and add the named ones. No data changes.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.conname, a.attname
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.conrelid = 'public.agent_directives'::regclass AND c.contype = 'c'
       AND array_length(c.conkey, 1) = 1 AND a.attname IN ('status', 'owner_decision', 'binding')
  LOOP
    EXECUTE format('ALTER TABLE agent_directives DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE agent_directives ADD CONSTRAINT agent_directives_status_check CHECK (status IN (
  'new','awaiting_owner','accepted','rejected','applied','evaluated','expired','canceled','contested','declined','failed'));
ALTER TABLE agent_directives ADD CONSTRAINT agent_directives_owner_decision_check CHECK (owner_decision IN (
  'approved','declined','timeout_applied','timeout_dropped','upheld','refusal_accepted'));
ALTER TABLE agent_directives ADD CONSTRAINT agent_directives_binding_check CHECK (binding IN ('directive','advice'));

-- Accepted rows waiting for (a retry of) their executor; applied rows waiting for verification.
CREATE INDEX IF NOT EXISTS idx_directives_exec ON agent_directives (status, updated_at) WHERE status IN ('accepted', 'applied');

-- ── playbooks ────────────────────────────────────────────────────────────────
ALTER TABLE playbooks ADD COLUMN IF NOT EXISTS directive_id UUID REFERENCES agent_directives(id) ON DELETE SET NULL;
ALTER TABLE playbooks DROP CONSTRAINT IF EXISTS playbooks_created_by_check;
ALTER TABLE playbooks ADD CONSTRAINT playbooks_created_by_check CHECK (created_by IN ('orchestrator','owner','migration','directive'));
CREATE INDEX IF NOT EXISTS idx_playbooks_directive ON playbooks (directive_id) WHERE directive_id IS NOT NULL;

-- ── resource_pauses ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS resource_pauses (
  id           BIGSERIAL PRIMARY KEY,
  resource_ref TEXT NOT NULL,
  agent_id     UUID,
  directive_id UUID,
  reason       TEXT NOT NULL,
  starts_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  until        TIMESTAMPTZ NOT NULL,
  lifted_at    TIMESTAMPTZ,
  lifted_by    TEXT CHECK (lifted_by IN ('schedule','owner')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_resource_pauses_active ON resource_pauses (resource_ref) WHERE lifted_at IS NULL;

DO $$
DECLARE
  t TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'editor_ro') THEN
    FOREACH t IN ARRAY ARRAY['agent_directives','playbooks','resource_pauses'] LOOP
      IF to_regclass('public.' || t) IS NOT NULL THEN
        EXECUTE format('GRANT SELECT ON public.%I TO editor_ro', t);
      END IF;
    END LOOP;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'editor_ro grants skipped (insufficient privilege)';
END $$;

INSERT INTO schema_migrations (version) VALUES ('065_directive_binding')
  ON CONFLICT (version) DO NOTHING;
