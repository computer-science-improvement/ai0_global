-- Down for 098_card_hashtag_default.sql (spec 073). The column default goes back to 1. The backfill is not undone: a
-- channel set to 0 stays at 0 (it had no vocabulary, so 0 is what it should have had). Idempotent.
ALTER TABLE editor_channels ALTER COLUMN hashtag_min SET DEFAULT 1;
DELETE FROM schema_migrations WHERE version = '098_card_hashtag_default';
