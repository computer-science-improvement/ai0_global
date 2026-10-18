-- 084_artifacts.sql — artifacts (spec 048 FR-001, FR-005).
--
-- • artifact_versions: versions of the artifact types that have none of their own (setup proposals, steering sets, a
--   channel's owner rules). Skills, playbooks and resource profiles keep their own version tables. A version is written
--   on every change through the artifact API or an agent tool, and when a read sees a body that changed elsewhere.
-- • editor_chat_messages.artifacts: the artifacts a chat turn created or changed ([{type, id, version}]), for the chips.
--
-- Additive, non-destructive and idempotent (CI re-applies it).

CREATE TABLE IF NOT EXISTS artifact_versions (
  id         BIGSERIAL PRIMARY KEY,
  type       TEXT NOT NULL CHECK (type IN ('setup', 'steering', 'rules')),
  ref_id     TEXT NOT NULL,
  version    INT  NOT NULL,
  body       JSONB NOT NULL,
  author     TEXT NOT NULL CHECK (author IN ('owner', 'agent', 'system')),
  agent_id   UUID REFERENCES agents(id) ON DELETE SET NULL,
  reason     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (type, ref_id, version)
);

ALTER TABLE editor_chat_messages ADD COLUMN IF NOT EXISTS artifacts JSONB;
