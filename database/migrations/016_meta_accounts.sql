-- 016_meta_accounts.sql — Meta (Instagram / Facebook / Threads) connections.
-- Mirrors my_bots: the OAuth token NEVER lives in the DB — only the name of the
-- .env var that holds it (token_env). target_id is the publishable object id
-- (FB Page id / IG business-account id / Threads user id). Verify fills the
-- display fields used by the connection preview card.

CREATE TABLE IF NOT EXISTS meta_accounts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform         TEXT NOT NULL CHECK (platform IN ('instagram','facebook','threads')),
  account_id       TEXT NOT NULL,
  token_env        TEXT NOT NULL,
  target_id        TEXT NOT NULL,
  username         TEXT,
  display_name     TEXT,
  followers        INTEGER,
  picture_url      TEXT,
  active           BOOLEAN NOT NULL DEFAULT true,
  last_verified_at TIMESTAMPTZ,
  verify_error     TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform, account_id)
);

INSERT INTO schema_migrations (version) VALUES ('016_meta_accounts')
  ON CONFLICT (version) DO NOTHING;
