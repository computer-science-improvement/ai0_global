-- Down for 080_channel_setup.sql (spec 042).
DROP TABLE IF EXISTS channel_setup_proposals;
DELETE FROM schema_migrations WHERE version = '080_channel_setup';
