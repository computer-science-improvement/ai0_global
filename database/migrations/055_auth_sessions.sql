-- 055_auth_sessions.sql — revocable dashboard sessions and the auth audit log (spec 028).
--
-- auth_sessions is one row per dashboard login. The session cookie is a short
-- JWT that carries the row id (`sid`); the row decides whether the session is
-- still alive (revoked, idle window, absolute cap), so the owner can revoke one
-- session or all of them from Settings → Security.
-- auth_events records every login attempt, logout, revoke and lockout.
--
-- Neither table ever stores a token, a token prefix or a Telegram widget hash:
-- only the method, the Telegram user id/name, the client IP and the User-Agent.
-- Not granted to editor_ro (the agents have no business reading login history).
--
-- Additive and idempotent.

CREATE TABLE IF NOT EXISTS auth_sessions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  method         TEXT NOT NULL CHECK (method IN ('token','telegram','link')),
  subject_id     BIGINT NOT NULL,
  first_name     TEXT,
  username       TEXT,
  ip             INET,
  user_agent     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at     TIMESTAMPTZ,
  revoked_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_live ON auth_sessions (revoked_at, last_seen_at);

CREATE TABLE IF NOT EXISTS auth_events (
  id         BIGSERIAL PRIMARY KEY,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind       TEXT NOT NULL CHECK (kind IN ('login_ok','login_failed','rate_limited','locked_out','logout','revoked','revoke_all','expired')),
  method     TEXT,
  code       TEXT,
  subject_id BIGINT,
  session_id UUID,
  ip         INET,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_events_at ON auth_events (at DESC);
-- New-device check: recent successful logins.
CREATE INDEX IF NOT EXISTS idx_auth_events_login_ok ON auth_events (at DESC) WHERE kind = 'login_ok';

INSERT INTO schema_migrations (version) VALUES ('055_auth_sessions')
  ON CONFLICT (version) DO NOTHING;
