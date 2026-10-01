-- 044_ad_revenue.sql
-- Revenue path (specs/008): price list, ad creative, order → reserved slot →
-- published post → advertiser report. Additive only: one new table, nullable
-- columns on ad_orders, and the ad_orders status CHECK widened with
-- 'published' and 'reported' (a superset of the old list, so no row can fail it).

-- ── T001 price list ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ad_prices (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_key TEXT NOT NULL,                       -- tracked_channels.channel_key, e.g. '@my_channel'
  format      TEXT NOT NULL CHECK (format IN ('post','pin_24h','digest_sponsor')),
  price_uah   INT  NOT NULL CHECK (price_uah > 0),
  active      BOOLEAN NOT NULL DEFAULT true,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One active price per channel + format; history stays as inactive rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ad_prices_active ON ad_prices (channel_key, format) WHERE active;

-- ── T001–T005 order lifecycle columns ────────────────────────────────────────
ALTER TABLE ad_orders ADD COLUMN IF NOT EXISTS price_id          UUID REFERENCES ad_prices(id) ON DELETE SET NULL;
ALTER TABLE ad_orders ADD COLUMN IF NOT EXISTS creative          JSONB;        -- SponsoredCreative (PostSpec subset)
ALTER TABLE ad_orders ADD COLUMN IF NOT EXISTS sponsor_label     TEXT;         -- optional "Реклама. Замовник: …" line
ALTER TABLE ad_orders ADD COLUMN IF NOT EXISTS publish_at        TIMESTAMPTZ;
ALTER TABLE ad_orders ADD COLUMN IF NOT EXISTS editor_slot_id    UUID;
ALTER TABLE ad_orders ADD COLUMN IF NOT EXISTS published_post_id BIGINT REFERENCES published_posts(id) ON DELETE SET NULL;
ALTER TABLE ad_orders ADD COLUMN IF NOT EXISTS thread_id         UUID REFERENCES agent_dm_threads(id) ON DELETE SET NULL;
ALTER TABLE ad_orders ADD COLUMN IF NOT EXISTS report            JSONB;        -- latest advertiser report (stage 24h → 72h)
ALTER TABLE ad_orders ADD COLUMN IF NOT EXISTS reported_at       TIMESTAMPTZ;  -- final (72h) report time
ALTER TABLE ad_orders ADD COLUMN IF NOT EXISTS report_token      TEXT UNIQUE;  -- public /report/:token

CREATE INDEX IF NOT EXISTS idx_ad_orders_slot ON ad_orders (editor_slot_id) WHERE editor_slot_id IS NOT NULL;

-- Widen the status CHECK (040 named it ad_orders_status_check). Only touched
-- when 'reported' is missing, so a second run is a no-op.
DO $$
DECLARE
  def TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
    FROM pg_constraint
   WHERE conrelid = 'ad_orders'::regclass AND conname = 'ad_orders_status_check';
  IF def IS NULL OR def NOT LIKE '%reported%' THEN
    IF def IS NOT NULL THEN
      ALTER TABLE ad_orders DROP CONSTRAINT ad_orders_status_check;
    END IF;
    ALTER TABLE ad_orders ADD CONSTRAINT ad_orders_status_check
      CHECK (status IN ('draft','awaiting_payment','paid','scheduled','published','reported','canceled'));
  END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES ('044_ad_revenue')
  ON CONFLICT (version) DO NOTHING;
