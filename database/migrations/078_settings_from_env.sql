-- 078_settings_from_env.sql — settings move from .env to the dashboard (spec 039, T1).
--
-- • app_settings_env_imports: the catalog keys whose .env value the service has already taken in at start. A key is imported
--   once (env value → app_settings row, secrets encrypted as enc:v1); after that the DB value wins and .env edits of it are
--   ignored. A key listed here without an app_settings row was reset on the dashboard → the code's built-in default applies.
-- • The values themselves stay in app_settings (key = the env name). No rows are written here: the import runs in the
--   service before Nest starts, which also creates this table when the migration has not run yet (first boot after deploy).
--
-- Additive, guarded and idempotent: CI re-applies this file.

CREATE TABLE IF NOT EXISTS app_settings_env_imports (
  key          TEXT PRIMARY KEY,
  imported_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  -- The read-only editor role never sees settings (secrets live in app_settings).
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'editor_ro') THEN
    REVOKE ALL ON app_settings_env_imports FROM editor_ro;
  END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES ('078_settings_from_env')
  ON CONFLICT (version) DO NOTHING;
