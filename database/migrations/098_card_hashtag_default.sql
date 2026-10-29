-- 098_card_hashtag_default.sql — a card with no hashtag vocabulary asks for no hashtags (spec 073 FR-013).
--
-- editor_channels.hashtag_min was DEFAULT 1 (042_editor.sql), so a channel created through the API with no vocabulary
-- demanded at least one hashtag it could not name: every post failed the count and the writer invented tags. The code
-- default (CARD_DEFAULTS.hashtagMin) is now 0 and so is the column default; a channel that has no vocabulary and a
-- minimum above 0 is set to 0. A channel with a vocabulary keeps its minimum.
--
-- Idempotent (CI re-applies it). The down file restores DEFAULT 1 only; the backfill is not undone.

ALTER TABLE editor_channels ALTER COLUMN hashtag_min SET DEFAULT 0;

UPDATE editor_channels SET hashtag_min = 0 WHERE cardinality(hashtags) = 0 AND hashtag_min > 0;

INSERT INTO schema_migrations (version) VALUES ('098_card_hashtag_default') ON CONFLICT DO NOTHING;
