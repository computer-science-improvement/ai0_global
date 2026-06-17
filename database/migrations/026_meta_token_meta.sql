-- 026_meta_token_meta.sql — access-token metadata for Meta connections.
-- Verify runs Graph `debug_token` (self-inspection) and persists the DERIVED
-- metadata only — the token value NEVER lands in the DB (mirrors 016: only the
-- env-var name is stored). Lets the operator see token type / expiry / scopes
-- and get a heads-up before a Page token (~2 months) lapses.
--   token_type                   USER | PAGE | SYSTEM_USER | null
--   token_expires_at             null = never-expires OR unknown
--                                (disambiguate via token_checked_at)
--   token_data_access_expires_at data-access expiry (separate clock)
--   token_scopes                 granted permissions
--   token_checked_at             when debug_token last ran (null = never)

ALTER TABLE meta_accounts ADD COLUMN IF NOT EXISTS token_type                   TEXT;
ALTER TABLE meta_accounts ADD COLUMN IF NOT EXISTS token_expires_at             TIMESTAMPTZ;
ALTER TABLE meta_accounts ADD COLUMN IF NOT EXISTS token_data_access_expires_at TIMESTAMPTZ;
ALTER TABLE meta_accounts ADD COLUMN IF NOT EXISTS token_scopes                 TEXT[];
ALTER TABLE meta_accounts ADD COLUMN IF NOT EXISTS token_checked_at             TIMESTAMPTZ;

INSERT INTO schema_migrations (version) VALUES ('026_meta_token_meta') ON CONFLICT DO NOTHING;
