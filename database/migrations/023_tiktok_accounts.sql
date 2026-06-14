-- 023_tiktok_accounts.sql — TikTok creator connections for the carousel publisher.
-- UNLIKE meta_accounts, the tokens live in the DB: TikTok access tokens expire (~24h)
-- and rotate on refresh, so a static env var cannot hold them. Plaintext for v1
-- (internal DB); tokens are never logged. client_key/secret stay in env.
CREATE TABLE IF NOT EXISTS tiktok_accounts (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  open_id                  TEXT NOT NULL UNIQUE,
  union_id                 TEXT,
  username                 TEXT,
  display_name             TEXT,
  avatar_url               TEXT,
  access_token             TEXT NOT NULL,
  refresh_token            TEXT NOT NULL,
  access_token_expires_at  TIMESTAMPTZ NOT NULL,
  refresh_token_expires_at TIMESTAMPTZ NOT NULL,
  scope                    TEXT,
  active                   BOOLEAN NOT NULL DEFAULT true,
  last_refreshed_at        TIMESTAMPTZ,
  refresh_error            TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (version) VALUES ('023_tiktok_accounts')
  ON CONFLICT (version) DO NOTHING;
