-- 034_tracked_channel_group.sql — let a Telegram channel join a brand group.
--
-- A group (meta_account_groups) links a brand's accounts. It already holds the
-- brand's Facebook/Instagram/Threads accounts; this lets it ALSO reference the
-- brand's Telegram channel, so the whole brand is visible/managed in one place.
-- This is ORGANIZATIONAL only — it does not change publishing (Telegram still
-- posts via its own strategy binding; the FB→IG+Threads fan-out is untouched).
ALTER TABLE tracked_channels
  ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES meta_account_groups(id) ON DELETE SET NULL;

-- At most one Telegram channel per group (mirrors the one-account-per-platform
-- rule on meta_accounts) → an unambiguous "the group's Telegram channel".
CREATE UNIQUE INDEX IF NOT EXISTS tracked_channels_group_uq
  ON tracked_channels (group_id) WHERE group_id IS NOT NULL;

INSERT INTO schema_migrations (version) VALUES ('034_tracked_channel_group') ON CONFLICT DO NOTHING;
