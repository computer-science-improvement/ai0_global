-- 046_editor_crosspost.sql — per-channel switch for editor cross-posting (spec 009 T003).
--
-- After a LIVE editor publish, the post is mirrored to the channel's Meta
-- cross-post targets (meta_crosspost_targets) and to the Meta members of its
-- account group, exactly like the legacy strategies do. `crosspost = false`
-- keeps a channel Telegram-only without touching those target rows.
--
-- Additive and idempotent: one column with a default, safe to apply twice.
ALTER TABLE editor_channels
  ADD COLUMN IF NOT EXISTS crosspost BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN editor_channels.crosspost IS
  'Mirror live editor posts to the channel''s Meta cross-post targets and account group (spec 009 T003)';

INSERT INTO schema_migrations (version) VALUES ('046_editor_crosspost')
  ON CONFLICT (version) DO NOTHING;
