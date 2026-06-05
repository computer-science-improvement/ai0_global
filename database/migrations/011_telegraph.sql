-- 011_telegraph.sql
-- Telegraph integration:
--   1. `telegraph_accounts` — DB-managed Telegraph sessions, mirroring the
--      `my_bots` pattern: the row stores the env-var NAME (`token_env`) that
--      holds the actual access token, plus verify metadata. Lets the operator
--      add / pause / verify Telegraph accounts from the dashboard just like
--      Telegram bots.
--   2. `recipes.telegraph_url` / `telegraph_path` — cache the Telegraph page
--      created for each recipe so the page is built exactly once (idempotent,
--      no duplicate pages, no extra API calls on re-runs).

CREATE TABLE IF NOT EXISTS telegraph_accounts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        TEXT UNIQUE NOT NULL,           -- logical name (operator-chosen)
  token_env         TEXT NOT NULL,                  -- env-var name holding the access token
  short_name        TEXT,                           -- filled by getAccountInfo on verify
  author_name       TEXT,
  author_url        TEXT,
  active            BOOLEAN NOT NULL DEFAULT true,
  last_verified_at  TIMESTAMPTZ,
  verify_error      TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE recipes
  ADD COLUMN IF NOT EXISTS telegraph_url  TEXT,
  ADD COLUMN IF NOT EXISTS telegraph_path TEXT;

-- Seed the default account: the operator-provided token lives in env as
-- TELEGRAPH_ACCESS_TOKEN. The row only references the name.
INSERT INTO telegraph_accounts (account_id, token_env, active)
VALUES ('default', 'TELEGRAPH_ACCESS_TOKEN', true)
ON CONFLICT (account_id) DO NOTHING;

INSERT INTO schema_migrations (version) VALUES ('011_telegraph')
  ON CONFLICT (version) DO NOTHING;
