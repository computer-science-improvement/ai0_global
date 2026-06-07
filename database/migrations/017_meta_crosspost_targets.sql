-- 017_meta_crosspost_targets.sql — per-strategy Meta cross-post targets.
-- When a strategy publishes to its Telegram channel, each enabled target here
-- cross-posts to a Meta account: 'mirror' (same content) or 'teaser' (short
-- promo + link to the TG post). strategy_bindings is left untouched.

CREATE TABLE IF NOT EXISTS meta_crosspost_targets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  binding_id      UUID NOT NULL REFERENCES strategy_bindings(id) ON DELETE CASCADE,
  platform        TEXT NOT NULL CHECK (platform IN ('instagram','facebook','threads')),
  meta_account_id UUID NOT NULL REFERENCES meta_accounts(id) ON DELETE CASCADE,
  mode            TEXT NOT NULL CHECK (mode IN ('mirror','teaser')),
  enabled         BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (binding_id, platform, meta_account_id)
);
CREATE INDEX IF NOT EXISTS idx_meta_crosspost_binding ON meta_crosspost_targets (binding_id);

INSERT INTO schema_migrations (version) VALUES ('017_meta_crosspost_targets')
  ON CONFLICT (version) DO NOTHING;
