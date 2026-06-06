-- 015_app_settings.sql
-- Runtime-editable overrides for a small set of env-class settings (the
-- Telegram "Відстеження" block on the Settings page). The effective value is
-- DB override ?? process.env ?? built-in default, so a row here wins over .env
-- and survives restarts. Only the keys the dashboard exposes are ever written.

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (version) VALUES ('015_app_settings')
  ON CONFLICT (version) DO NOTHING;
