-- 105_mcp_connector.sql — the Claude connector (spec 103): remote MCP with OAuth 2.1, and posts the automation never
-- overwrites.
--
-- editor_slots.created_via  'connector' for a slot made through the connector (prepare_post / plan_post). It only
--                           labels where the slot came from; it never changes behaviour.
-- editor_slots.locked_by    'connector' | 'owner' — a locked slot is the owner's: replans keep it and plan around it,
--                           the SLO controller never replaces it, pre-flight and the config gate never rewrite it, pause
--                           and mode sweeps leave it (publish-time guards still apply). The owner can unlock it.
-- editor_slots.locked_at    when it was locked.
-- editor_chats.created_via  'connector' for an owner chat started from Claude.
-- mcp_oauth_*               the authorization server's state. Every token, code and consent id is stored as a
--                           SHA-256 hash only. mcp_audit is the connector's activity log (no post text).
--
-- Apply it with the deploy, after 104. Nothing reads the new tables while MCP_CONNECTOR is off (the default).

ALTER TABLE editor_slots ADD COLUMN IF NOT EXISTS created_via TEXT;
ALTER TABLE editor_slots ADD COLUMN IF NOT EXISTS locked_by   TEXT;
ALTER TABLE editor_slots ADD COLUMN IF NOT EXISTS locked_at   TIMESTAMPTZ;
ALTER TABLE editor_chats ADD COLUMN IF NOT EXISTS created_via TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'editor_slots_created_via_chk') THEN
    ALTER TABLE editor_slots ADD CONSTRAINT editor_slots_created_via_chk CHECK (created_via IS NULL OR created_via IN ('connector'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'editor_slots_locked_by_chk') THEN
    ALTER TABLE editor_slots ADD CONSTRAINT editor_slots_locked_by_chk CHECK (locked_by IS NULL OR locked_by IN ('connector','owner'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'editor_chats_created_via_chk') THEN
    ALTER TABLE editor_chats ADD CONSTRAINT editor_chats_created_via_chk CHECK (created_via IS NULL OR created_via IN ('connector'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_editor_slots_locked ON editor_slots (channel_key, scheduled_at) WHERE locked_by IS NOT NULL;

-- OAuth clients: a Client ID Metadata Document URL (cimd) or a dynamically registered client (dcr).
CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      TEXT NOT NULL UNIQUE,
  kind           TEXT NOT NULL CHECK (kind IN ('cimd','dcr')),
  name           TEXT NOT NULL,
  redirect_uris  JSONB NOT NULL DEFAULT '[]',
  metadata       JSONB NOT NULL DEFAULT '{}',
  created_ip     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at   TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ
);

-- A pending authorization request, waiting for the owner's consent (10 minutes). id_hash = sha256(request id).
CREATE TABLE IF NOT EXISTS mcp_oauth_requests (
  id_hash         TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL,
  redirect_uri    TEXT NOT NULL,
  code_challenge  TEXT NOT NULL,
  scope           TEXT NOT NULL,
  state           TEXT,
  resource        TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  decided_at      TIMESTAMPTZ,
  decision        TEXT CHECK (decision IS NULL OR decision IN ('allow','deny'))
);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_requests_expires ON mcp_oauth_requests (expires_at);

-- One grant per successful code exchange; revoking it kills every token issued under it.
CREATE TABLE IF NOT EXISTS mcp_oauth_grants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       TEXT NOT NULL,
  scope           TEXT NOT NULL,
  resource        TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at    TIMESTAMPTZ,
  last_ip         TEXT,
  revoked_at      TIMESTAMPTZ,
  revoked_reason  TEXT
);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_grants_client ON mcp_oauth_grants (client_id);

-- Codes, access and refresh tokens (hash only). A code carries what the token request must match; a used refresh
-- token points at its successor (rotation, reuse detection).
CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
  token_hash      TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('code','access','refresh')),
  grant_id        UUID REFERENCES mcp_oauth_grants(id) ON DELETE CASCADE,
  client_id       TEXT NOT NULL,
  scope           TEXT NOT NULL,
  resource        TEXT NOT NULL,
  redirect_uri    TEXT,
  code_challenge  TEXT,
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ,
  replaced_by     TEXT,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_grant ON mcp_oauth_tokens (grant_id);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_expires ON mcp_oauth_tokens (expires_at);

-- The connector's activity: tool calls and OAuth events. Argument summaries never hold post text.
CREATE TABLE IF NOT EXISTS mcp_audit (
  id           BIGSERIAL PRIMARY KEY,
  at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  event        TEXT NOT NULL,
  grant_id     UUID,
  client_id    TEXT,
  tool         TEXT,
  ok           BOOLEAN,
  error        TEXT,
  duration_ms  INT,
  summary      TEXT,
  ip           TEXT
);
CREATE INDEX IF NOT EXISTS idx_mcp_audit_at ON mcp_audit (at DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'editor_ro') THEN
    EXECUTE 'REVOKE ALL ON public.mcp_oauth_clients, public.mcp_oauth_requests, public.mcp_oauth_grants, public.mcp_oauth_tokens, public.mcp_audit FROM editor_ro';
  END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES ('105_mcp_connector') ON CONFLICT DO NOTHING;
