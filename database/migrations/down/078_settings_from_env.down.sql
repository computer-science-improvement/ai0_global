-- Down for 078_settings_from_env.sql (spec 039). The imported values stay in app_settings; without this table the next start
-- imports .env again for the keys that have no app_settings row.
DROP TABLE IF EXISTS app_settings_env_imports;
DELETE FROM schema_migrations WHERE version = '078_settings_from_env';
