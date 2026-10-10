-- 072_sponsor_fulfilment.sql — paid ad orders are never silently lost (spec 036).
--
-- • ad_orders.flag_reason / flagged_at: why a paid order cannot be (or was not)
--   published, set once per reason by the sponsor fulfilment tick, the cutover
--   check and the stuck-order check (each posts an Inbox action + admin-bot
--   alert when the reason is new). Cleared when the order is placed.
--
-- Additive, guarded and idempotent: CI re-applies this file.

DO $$
BEGIN
  IF to_regclass('public.ad_orders') IS NOT NULL THEN
    ALTER TABLE ad_orders ADD COLUMN IF NOT EXISTS flag_reason TEXT;
    ALTER TABLE ad_orders ADD COLUMN IF NOT EXISTS flagged_at  TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_ad_orders_open ON ad_orders (status, publish_at) WHERE status IN ('paid','scheduled');
  END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES ('072_sponsor_fulfilment')
  ON CONFLICT (version) DO NOTHING;
