-- 032_mtproto_session_api_creds.sql — per-session MTProto app credentials.
--
-- Historically the Telegram app credentials (TELEGRAM_API_ID / TELEGRAM_API_HASH)
-- lived only in .env and were shared by every session. This moves them onto each
-- session row so operators manage them entirely from the dashboard:
--
--   api_id        — the numeric Telegram app id (not a secret; shown in the UI)
--   api_hash_enc  — the app api_hash, stored ENCRYPTED (enc:v1:...) via
--                   SecretsService. Never stored or logged in plaintext, never
--                   returned by the API.
--
-- Both are NULLable: a session without its own creds (e.g. rows created before
-- this migration) falls back to the .env TELEGRAM_API_ID / TELEGRAM_API_HASH, so
-- existing setups keep working with zero config.
ALTER TABLE mtproto_sessions
  ADD COLUMN IF NOT EXISTS api_id       TEXT,
  ADD COLUMN IF NOT EXISTS api_hash_enc TEXT;

INSERT INTO schema_migrations (version) VALUES ('032_mtproto_session_api_creds') ON CONFLICT DO NOTHING;
