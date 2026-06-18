-- 031_mtproto_sessions.sql — MTProto (user-account) tracking/stats sessions.
--
-- The session string is the user-account login the tracker and stats clients
-- use to read per-post views/reactions (the Bot API cannot). Historically this
-- lived only in .env (TELEGRAM_SESSION_STRING / TELEGRAM_TRACKING_SESSION_STRING).
-- This table lets operators manage sessions from the dashboard like the other
-- connections. The session string is stored ENCRYPTED (enc:v1:...) via
-- SecretsService — never in plaintext, never logged, never returned by the API.
-- apiId/apiHash stay in env (they are app-level, shared across all sessions).
--
-- The tracker/stats clients prefer the first `active` row; with no active row
-- they fall back to the existing .env behavior (zero-config compatibility).
CREATE TABLE IF NOT EXISTS mtproto_sessions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label            TEXT NOT NULL,
  -- Encrypted session string (enc:v1:...). Never stored or logged in plaintext.
  session_enc      TEXT NOT NULL,
  active           BOOLEAN NOT NULL DEFAULT true,
  -- Display identity captured on verify (getMe). Safe to show; not secret.
  username         TEXT,
  phone            TEXT,
  tg_user_id       TEXT,
  last_verified_at TIMESTAMPTZ,
  verify_error     TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (version) VALUES ('031_mtproto_sessions') ON CONFLICT DO NOTHING;
