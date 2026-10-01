-- 049_agents.sql — agent registry (spec 017): named agents bound to a resource,
-- a network or the whole system; skills stored in the DB with versions; runs
-- linked to their agent.
--
-- The per-channel orchestrators and their role children are created by
-- AgentRegistrySync at boot (idempotent, handles collisions in code); this
-- migration seeds only the two system agents (@manager, @ai0).
--
-- Additive and idempotent: new tables and nullable columns only.

CREATE TABLE IF NOT EXISTS agents (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             TEXT NOT NULL CHECK (kind IN ('manager','builder','orchestrator','planner','ideator','idea_reviewer','executor','reviewer')),
  scope            TEXT NOT NULL CHECK (scope IN ('system','network','resource')),
  scope_id         TEXT,
  parent_id        UUID REFERENCES agents(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  handle           TEXT NOT NULL CHECK (handle ~ '^[a-z][a-z0-9_]{2,31}$'),
  emoji            TEXT,
  description      TEXT,
  mode             TEXT NOT NULL DEFAULT 'shadow' CHECK (mode IN ('off','shadow','live')),
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  paused_until     TIMESTAMPTZ,
  model            TEXT,
  reasoning_effort TEXT CHECK (reasoning_effort IN ('low','medium','high')),
  schedule         JSONB NOT NULL DEFAULT '{}',
  daily_budget_usd NUMERIC(8,4),
  shadow_until     TIMESTAMPTZ,
  created_by       TEXT NOT NULL DEFAULT 'owner' CHECK (created_by IN ('owner','builder','migration','sync')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_agents_handle ON agents (lower(handle));
-- One top-level agent of a kind per scope (one orchestrator per resource/network, one manager, one builder).
CREATE UNIQUE INDEX IF NOT EXISTS uq_agents_top_scope ON agents (kind, scope, COALESCE(scope_id, '')) WHERE parent_id IS NULL;
-- One child of each kind per parent (planner / executor / reviewer / idea_reviewer under an orchestrator).
CREATE UNIQUE INDEX IF NOT EXISTS uq_agents_child_kind ON agents (parent_id, kind) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agents_scope ON agents (scope, scope_id);

-- Old handles keep resolving for 30 days after a rename.
CREATE TABLE IF NOT EXISTS agent_handle_aliases (
  handle     TEXT PRIMARY KEY,
  agent_id   UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE editor_runs ADD COLUMN IF NOT EXISTS agent_id UUID;
CREATE INDEX IF NOT EXISTS idx_editor_runs_agent ON editor_runs (agent_id, started_at DESC);

-- ── skills ──────────────────────────────────────────────────────────────────
-- builtin = editor-skills/*.md synced at boot; global = owner-written for every agent;
-- agent = an agent's own skill or its override of a builtin of the same name.
CREATE TABLE IF NOT EXISTS skills (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL CHECK (name ~ '^[a-z0-9-]{3,48}$'),
  scope           TEXT NOT NULL CHECK (scope IN ('builtin','global','agent')),
  agent_id        UUID REFERENCES agents(id) ON DELETE CASCADE,
  description     TEXT NOT NULL,
  applies_to      TEXT[] NOT NULL DEFAULT '{}',
  body            TEXT NOT NULL,
  locked          BOOLEAN NOT NULL DEFAULT false,
  safety          BOOLEAN NOT NULL DEFAULT false,
  current_version INT NOT NULL DEFAULT 1,
  -- For an agent override of a builtin: the builtin version it was forked from ("base changed" banner).
  base_version    INT,
  created_by      TEXT NOT NULL CHECK (created_by IN ('repo','owner','agent')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((scope = 'agent') = (agent_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_skills_name_owner
  ON skills (name, COALESCE(agent_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE IF NOT EXISTS skill_versions (
  id              BIGSERIAL PRIMARY KEY,
  skill_id        UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version         INT NOT NULL,
  body            TEXT NOT NULL,
  description     TEXT NOT NULL,
  applies_to      TEXT[] NOT NULL DEFAULT '{}',
  author          TEXT NOT NULL CHECK (author IN ('repo','owner','agent')),
  author_agent_id UUID,
  reason          TEXT,
  kpi_baseline    JSONB,
  review_at       TIMESTAMPTZ,
  outcome         TEXT CHECK (outcome IN ('pending','kept','rolled_back','superseded')),
  outcome_detail  JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (skill_id, version)
);
CREATE INDEX IF NOT EXISTS idx_skill_versions_pending ON skill_versions (review_at) WHERE outcome = 'pending';

CREATE TABLE IF NOT EXISTS agent_skills (
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  skill_id UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  enabled  BOOLEAN NOT NULL DEFAULT true,
  inline   BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (agent_id, skill_id)
);

-- Owner inbox: notifications that need a look or a decision (until the 012 bot exists).
CREATE TABLE IF NOT EXISTS agent_inbox (
  id          BIGSERIAL PRIMARY KEY,
  agent_id    UUID REFERENCES agents(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  ref_type    TEXT,
  ref_id      TEXT,
  severity    TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','action','critical')),
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_inbox_unread ON agent_inbox (created_at DESC) WHERE read_at IS NULL;

-- ── system agents ───────────────────────────────────────────────────────────
INSERT INTO agents (kind, scope, scope_id, name, handle, emoji, description, mode, created_by)
VALUES
  ('manager', 'system', NULL, 'Manager', 'manager', '🧭', 'Бачить усю мережу, читає KPI і дає директиви оркестраторам.', 'off', 'migration'),
  ('builder', 'system', NULL, 'ai0', 'ai0', '🛠', 'Створює й змінює агентів у чаті.', 'live', 'migration')
ON CONFLICT DO NOTHING;

-- Agents may read the registry and skills (no secrets there).
DO $$
DECLARE
  t TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'editor_ro') THEN
    FOREACH t IN ARRAY ARRAY['agents','skills','skill_versions','agent_skills'] LOOP
      EXECUTE format('GRANT SELECT ON public.%I TO editor_ro', t);
    END LOOP;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'editor_ro grants skipped (insufficient privilege)';
END $$;

INSERT INTO schema_migrations (version) VALUES ('049_agents')
  ON CONFLICT (version) DO NOTHING;
