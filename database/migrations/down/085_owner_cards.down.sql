-- Down for 085_owner_cards.sql (spec 012).
DROP TABLE IF EXISTS owner_reports;
DROP TABLE IF EXISTS owner_cards;
DELETE FROM schema_migrations WHERE version = '085_owner_cards';
