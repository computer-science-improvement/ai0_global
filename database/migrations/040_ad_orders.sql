-- SP3 ad orders / invoices: the owner creates an order, sends a LiqPay hosted
-- checkout link to the advertiser; a signed webhook marks it paid. No card data
-- is ever stored here — only the order metadata + its LiqPay order id.
CREATE TABLE IF NOT EXISTS ad_orders (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  advertiser       TEXT NOT NULL,
  channel_id       TEXT,
  amount           NUMERIC(12,2) NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'UAH',
  description      TEXT,
  status           TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','awaiting_payment','paid','scheduled','canceled')),
  liqpay_order_id  TEXT UNIQUE,
  action_id        UUID REFERENCES agent_actions(id) ON DELETE SET NULL,
  paid_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ad_orders_status ON ad_orders (status, created_at DESC);
