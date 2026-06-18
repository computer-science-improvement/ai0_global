-- 035_group_source_platform.sql — designate ONE member of a brand group as the
-- "source". Publishing to the source mirrors the same content to every other
-- member of the group. A group holds <=1 account per platform and <=1 Telegram
-- channel, so a single platform name unambiguously identifies the source member.
--
-- Default 'facebook' preserves the prior behaviour exactly: groups fanned out
-- from their Facebook account before this column existed.
ALTER TABLE meta_account_groups
  ADD COLUMN IF NOT EXISTS source_platform TEXT NOT NULL DEFAULT 'facebook';

ALTER TABLE meta_account_groups
  DROP CONSTRAINT IF EXISTS meta_account_groups_source_platform_chk;
ALTER TABLE meta_account_groups
  ADD CONSTRAINT meta_account_groups_source_platform_chk
  CHECK (source_platform IN ('facebook','instagram','threads','telegram'));

INSERT INTO schema_migrations (version) VALUES ('035_group_source_platform') ON CONFLICT DO NOTHING;
