-- 028_token_encryption.sql — store secret tokens ENCRYPTED at rest.
--
-- Adds a nullable `token_enc` column to the account tables that currently
-- reference a secret indirectly via `token_env` (an env-var NAME). When
-- token_enc holds an `enc:v1:...` blob it is the source of truth; when NULL the
-- legacy `token_env` → process.env path is used, so existing rows keep working
-- with zero config change. The single master key lives in .env as
-- TOKEN_ENCRYPTION_KEY.
--
-- TikTok is NOT touched here: it already has access_token / refresh_token
-- columns and stores secrets directly — those values simply become `enc:v1:`
-- strings on the next write (encryption is done in the token service).

ALTER TABLE meta_accounts      ADD COLUMN IF NOT EXISTS token_enc TEXT;
ALTER TABLE my_bots            ADD COLUMN IF NOT EXISTS token_enc TEXT;
ALTER TABLE telegraph_accounts ADD COLUMN IF NOT EXISTS token_enc TEXT;

INSERT INTO schema_migrations (version) VALUES ('028_token_encryption') ON CONFLICT DO NOTHING;
