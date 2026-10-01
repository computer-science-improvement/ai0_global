-- 050_agent_chat.sql — talking to agents by @handle and the @ai0 builder (spec 018).
--
-- Chat messages remember which agent wrote / was addressed; resource profiles
-- describe what an agent runs; pending_actions hold the confirmation cards of
-- every mutating builder/agent tool (applied only by an owner click).
--
-- Additive and idempotent.

ALTER TABLE editor_chats         ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES agents(id) ON DELETE SET NULL;
ALTER TABLE editor_chat_messages ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES agents(id) ON DELETE SET NULL;

-- What a resource is about (topic, audience, goals, tone, taboo, sources…) and its health (019).
CREATE TABLE IF NOT EXISTS resource_profiles (
  resource_ref    TEXT PRIMARY KEY,
  profile         JSONB NOT NULL DEFAULT '{}',
  resource_health JSONB,
  updated_by      TEXT NOT NULL DEFAULT 'owner' CHECK (updated_by IN ('owner','builder','agent','system')),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pending_actions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id     UUID REFERENCES editor_chats(id) ON DELETE SET NULL,
  agent_id    UUID REFERENCES agents(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL,
  payload     JSONB NOT NULL,
  summary     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','discarded','expired','failed')),
  result      JSONB,
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_pending_actions_chat ON pending_actions (chat_id, created_at);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'editor_ro') THEN
    EXECUTE 'GRANT SELECT ON public.resource_profiles TO editor_ro';
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'editor_ro grants skipped (insufficient privilege)';
END $$;

INSERT INTO schema_migrations (version) VALUES ('050_agent_chat')
  ON CONFLICT (version) DO NOTHING;
