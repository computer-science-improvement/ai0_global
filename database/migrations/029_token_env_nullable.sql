-- 029_token_env_nullable.sql — allow a token VALUE without an env-var name.
--
-- The write path now accepts a plaintext token that is encrypted into
-- `token_enc` at save time (see 028_token_encryption.sql). When the operator
-- supplies a token value there is no env-var NAME to record, so `token_env`
-- must be allowed to be NULL. Existing env-var-only rows are unaffected — they
-- keep their NAME and the legacy resolver path. At least one of token_enc /
-- token_env is enforced in the API layer, not the schema.

ALTER TABLE meta_accounts      ALTER COLUMN token_env DROP NOT NULL;
ALTER TABLE my_bots            ALTER COLUMN token_env DROP NOT NULL;
ALTER TABLE telegraph_accounts ALTER COLUMN token_env DROP NOT NULL;

INSERT INTO schema_migrations (version) VALUES ('029_token_env_nullable') ON CONFLICT DO NOTHING;
