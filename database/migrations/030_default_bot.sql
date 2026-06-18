-- 030_default_bot.sql — mark one bot as the default publisher.
--
-- A Telegram bot can be flagged `is_default`. At publish time, when a channel
-- has no specific bot bound (tracked_channels.bot_id IS NULL), publishing falls
-- back to the default bot. The partial unique index enforces at most one default
-- at the DB level — toggling a new default must clear the old one first (done in
-- the repository's setDefault() transaction).

ALTER TABLE my_bots ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_my_bots_one_default
  ON my_bots ((is_default)) WHERE is_default;

INSERT INTO schema_migrations (version) VALUES ('030_default_bot') ON CONFLICT DO NOTHING;
