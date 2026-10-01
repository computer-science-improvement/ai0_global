-- 052_playbooks_ideas.sql — playbooks, the idea pool and network day plans (spec 020).
--
-- A network (account group) in 'orchestrated' mode is run by the orchestrator
-- of its Telegram channel (the anchor): its day plan is the anchor channel's
-- editor plan, and slots for the other resources carry resource_ref.
--
-- Additive and idempotent.

ALTER TABLE meta_account_groups ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'mirror';
DO $$
BEGIN
  ALTER TABLE meta_account_groups ADD CONSTRAINT meta_account_groups_mode_chk CHECK (mode IN ('mirror','orchestrated'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS playbooks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  version     INT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('draft','pending_owner','active','superseded','rejected')),
  brief       TEXT,
  body        JSONB NOT NULL,
  review      JSONB,
  rationale   TEXT,
  created_by  TEXT NOT NULL CHECK (created_by IN ('orchestrator','owner')),
  run_id      UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at  TIMESTAMPTZ,
  UNIQUE (agent_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_playbooks_active ON playbooks (agent_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS content_ideas (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  angle       TEXT,
  sources     JSONB NOT NULL DEFAULT '[]',
  variants    JSONB NOT NULL DEFAULT '[]',
  why         TEXT,
  evidence    JSONB,
  origin      TEXT NOT NULL CHECK (origin IN ('orchestrator','series','directive','owner','trend')),
  origin_ref  TEXT,
  expires_at  TIMESTAMPTZ NOT NULL,
  status      TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','accepted','needs_revision','rejected','planned','used','expired')),
  revisions   SMALLINT NOT NULL DEFAULT 0,
  review      JSONB,
  reviewed_by UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_content_ideas_agent ON content_ideas (agent_id, status, created_at DESC);

ALTER TABLE editor_slots ADD COLUMN IF NOT EXISTS idea_id UUID;

DO $$
DECLARE
  t TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'editor_ro') THEN
    FOREACH t IN ARRAY ARRAY['playbooks','content_ideas','meta_account_groups'] LOOP
      EXECUTE format('GRANT SELECT ON public.%I TO editor_ro', t);
    END LOOP;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'editor_ro grants skipped (insufficient privilege)';
END $$;

INSERT INTO schema_migrations (version) VALUES ('052_playbooks_ideas')
  ON CONFLICT (version) DO NOTHING;
