-- 053_directives.sql — the MANAGER and its directives (spec 021).
--
-- agent_directives is the mailbox between @manager and the orchestrators:
-- advice and tasks go straight to them, structural kinds wait for the owner.
-- kpi_snapshots keeps the daily KPI digest numbers per scope; manager_reviews
-- records every manager run, including "continue as before".
--
-- Additive and idempotent.

CREATE TABLE IF NOT EXISTS agent_directives (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_agent_id  UUID REFERENCES agents(id) ON DELETE SET NULL,
  to_agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('advice','task','format_shift','frequency','repost','cross_promo','pause_series','experiment','pause_resource','strategy')),
  structural     BOOLEAN NOT NULL DEFAULT false,
  body           TEXT NOT NULL,
  params         JSONB NOT NULL DEFAULT '{}',
  rationale      TEXT NOT NULL,
  evidence       JSONB,
  expected       JSONB,
  review_at      TIMESTAMPTZ,
  status         TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','awaiting_owner','accepted','rejected','applied','evaluated','expired','canceled')),
  resolution     TEXT,
  reason_kind    TEXT,
  owner_decision TEXT CHECK (owner_decision IN ('approved','declined','timeout_applied','timeout_dropped')),
  outcome        TEXT CHECK (outcome IN ('worked','no_effect','hurt','inconclusive')),
  outcome_detail JSONB,
  delivered_at   TIMESTAMPTZ,
  applied_at     TIMESTAMPTZ,
  run_id         UUID,
  shadow         BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_directives_to ON agent_directives (to_agent_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_directives_status ON agent_directives (status, created_at DESC);

CREATE TABLE IF NOT EXISTS manager_reviews (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      UUID,
  verdict     TEXT NOT NULL CHECK (verdict IN ('continue','directives','skipped')),
  summary     TEXT NOT NULL,
  digest_hash TEXT,
  directive_ids UUID[] NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_manager_reviews_created ON manager_reviews (created_at DESC);

CREATE TABLE IF NOT EXISTS kpi_snapshots (
  scope    TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  day      DATE NOT NULL,
  metrics  JSONB NOT NULL,
  PRIMARY KEY (scope, scope_id, day)
);

-- Memory of agents without a channel card (the manager): lessons from directive outcomes.
CREATE TABLE IF NOT EXISTS agent_memory (
  id         BIGSERIAL PRIMARY KEY,
  agent_id   UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('insight','rule','avoid')),
  text       TEXT NOT NULL,
  evidence   JSONB,
  created_by TEXT NOT NULL CHECK (created_by IN ('reviewer','owner','system')),
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_memory_agent ON agent_memory (agent_id, active, created_at DESC);

DO $$
DECLARE
  t TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'editor_ro') THEN
    FOREACH t IN ARRAY ARRAY['agent_directives','manager_reviews','kpi_snapshots','agent_memory','ad_orders'] LOOP
      IF to_regclass('public.' || t) IS NOT NULL THEN
        EXECUTE format('GRANT SELECT ON public.%I TO editor_ro', t);
      END IF;
    END LOOP;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'editor_ro grants skipped (insufficient privilege)';
END $$;

INSERT INTO schema_migrations (version) VALUES ('053_directives')
  ON CONFLICT (version) DO NOTHING;
