-- 086_channel_launches.sql — channel launch (spec 052).
--
-- • channel_launches: one launch of a new channel from a brief and 1–3 references —
--   - the references (steering sets, 045) and the checked launch plan;
--   - the last computed checklist and whether the owner asked to start;
--   - when it started, the graduation state and the promos filed for it.
--   At most one open launch per channel (not graduated, discarded or failed).
--
-- Additive, non-destructive and idempotent (CI re-applies it).

CREATE TABLE IF NOT EXISTS channel_launches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_key     TEXT NOT NULL,
  target_ref      TEXT NOT NULL,
  title           TEXT,
  brief           TEXT NOT NULL,
  refs            JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(refs) = 'array'),
  status          TEXT NOT NULL DEFAULT 'queued',
  reason          TEXT,
  retry_at        TIMESTAMPTZ,
  plan            JSONB,
  checklist       JSONB,
  start_requested BOOLEAN NOT NULL DEFAULT false,
  started_at      TIMESTAMPTZ,
  graduation      JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(graduation) = 'object'),
  promo           JSONB,
  subs_at_start   INTEGER,
  bot_checked_at  TIMESTAMPTZ,
  bot_state       JSONB,
  agent_id        UUID REFERENCES agents(id) ON DELETE SET NULL,
  run_id          UUID,
  cost_usd        NUMERIC(12,6) NOT NULL DEFAULT 0,
  created_by      TEXT NOT NULL DEFAULT 'owner',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  graduated_at    TIMESTAMPTZ
);

ALTER TABLE channel_launches DROP CONSTRAINT IF EXISTS channel_launches_status_check;
ALTER TABLE channel_launches ADD CONSTRAINT channel_launches_status_check CHECK (status IN (
  'queued','preparing','analyzing','ready','running','graduated','failed','discarded'));

CREATE INDEX IF NOT EXISTS idx_channel_launches_channel ON channel_launches (channel_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_channel_launches_status ON channel_launches (status, updated_at);
-- At most one open launch per channel.
CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_launches_open ON channel_launches (channel_key)
  WHERE status IN ('queued','preparing','analyzing','ready','running');

INSERT INTO schema_migrations (version) VALUES ('086_channel_launches')
  ON CONFLICT (version) DO NOTHING;
