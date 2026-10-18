-- Down for 084_artifacts.sql (spec 048).
ALTER TABLE editor_chat_messages DROP COLUMN IF EXISTS artifacts;
DROP TABLE IF EXISTS artifact_versions;
DELETE FROM schema_migrations WHERE version = '084_artifacts';
