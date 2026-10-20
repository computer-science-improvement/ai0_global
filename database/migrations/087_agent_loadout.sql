-- 087_agent_loadout.sql — agent loadout (spec 054): which tools an agent is offered.
--
-- • agents.loadout_mode: 'role' = the role default (as before; every existing agent keeps it), 'custom' = only the tools
--   enabled in agent_tools. A new agent is created 'custom' (core tools + what its resource needs + what its peers use);
--   registry sync never changes an existing agent's loadout.
-- • agent_tools: the agent's tool rows. created_by says who put the row: the owner (the Loadout tab), the creation
--   profile, or an applied suggestion ('recommend'). Names are not a foreign key: a renamed or removed tool is reported
--   as stale and ignored at run time.
-- • editor_runs.tools_offered: the tool names offered to a run, written once when the run starts (the list is fixed
--   for the whole run, 053 FR-002). NULL on runs from before this migration.
--
-- Additive, non-destructive and idempotent (CI re-applies it).

ALTER TABLE agents ADD COLUMN IF NOT EXISTS loadout_mode TEXT NOT NULL DEFAULT 'role';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agents_loadout_mode_check') THEN
    ALTER TABLE agents ADD CONSTRAINT agents_loadout_mode_check CHECK (loadout_mode IN ('role','custom'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS agent_tools (
  agent_id   UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  tool_name  TEXT NOT NULL,
  enabled    BOOLEAN NOT NULL DEFAULT true,
  created_by TEXT NOT NULL DEFAULT 'owner' CHECK (created_by IN ('owner','creation','recommend')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, tool_name)
);

ALTER TABLE editor_runs ADD COLUMN IF NOT EXISTS tools_offered TEXT[];
