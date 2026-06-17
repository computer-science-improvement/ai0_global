-- 027_meta_token_valid.sql — record whether the token itself is valid.
-- debug_token only needs the token (not the target), so token validity can be
-- captured even when Verify fails for an unrelated reason (e.g. wrong target_id
-- → "Unsupported get request"). Lets the operator tell "token is dead" apart
-- from "token is fine but the target/permissions are wrong".
--   token_valid  TRUE | FALSE | null (never checked — token_checked_at is null)

ALTER TABLE meta_accounts ADD COLUMN IF NOT EXISTS token_valid BOOLEAN;

INSERT INTO schema_migrations (version) VALUES ('027_meta_token_valid') ON CONFLICT DO NOTHING;
