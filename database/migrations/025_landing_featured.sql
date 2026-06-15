-- 025_landing_featured.sql — landing-page "featured" flags on the three resource tables.
-- An operator marks which channels / meta accounts / tiktok accounts appear on the public
-- landing page and in what order. Featured = landing_visible AND <activeness predicate>:
--   meta_accounts / tiktok_accounts → active
--   tracked_channels               → is_mine (no `active` column on this table)

ALTER TABLE tracked_channels ADD COLUMN IF NOT EXISTS landing_visible BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tracked_channels ADD COLUMN IF NOT EXISTS landing_order   INTEGER NOT NULL DEFAULT 0;

ALTER TABLE meta_accounts ADD COLUMN IF NOT EXISTS landing_visible BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE meta_accounts ADD COLUMN IF NOT EXISTS landing_order   INTEGER NOT NULL DEFAULT 0;

ALTER TABLE tiktok_accounts ADD COLUMN IF NOT EXISTS landing_visible BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tiktok_accounts ADD COLUMN IF NOT EXISTS landing_order   INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_meta_accounts_landing   ON meta_accounts   (landing_order) WHERE landing_visible AND active;
CREATE INDEX IF NOT EXISTS idx_tiktok_accounts_landing  ON tiktok_accounts  (landing_order) WHERE landing_visible AND active;
CREATE INDEX IF NOT EXISTS idx_tracked_channels_landing ON tracked_channels (landing_order) WHERE landing_visible AND is_mine;

INSERT INTO schema_migrations (version) VALUES ('025_landing_featured') ON CONFLICT DO NOTHING;
