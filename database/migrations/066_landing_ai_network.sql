-- 066_landing_ai_network.sql — the public landing as an AI-run network (spec 026 FR-001).
--
-- • landing_leads: ad and white-label requests from the public page (T6). It holds
--   contact details, so it is deliberately NOT granted to editor_ro.
-- • landing_cta_daily: anonymous CTA click counters per day (T5). No IP is stored.
-- • youtube_accounts gains the landing columns the other platforms have (T4, FR-010).
-- • meta_account_groups (networks) gains an owner blurb and an order (T4, FR-006/007).
--
-- The DM templates and the ad username live in app_settings (`landing.*` keys), so
-- they need no schema. Additive and idempotent: CI re-applies this file.

CREATE TABLE IF NOT EXISTS landing_leads (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          TEXT NOT NULL CHECK (kind IN ('ad','white_label')),
  status        TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','qualified','won','lost','spam')),
  name          TEXT,
  contact       TEXT NOT NULL,
  contact_kind  TEXT CHECK (contact_kind IN ('telegram','email','phone','other')),
  company       TEXT,
  resources     JSONB NOT NULL DEFAULT '[]',
  platforms     TEXT[],
  audience_size TEXT CHECK (audience_size IN ('lt_10k','10k_100k','100k_1m','gt_1m','unknown')),
  service_mode  TEXT CHECK (service_mode IN ('dedicated','consult','unsure')),
  target        TEXT,
  message       TEXT,
  -- The landing ships in English only (owner decision 2026-10-06); 'uk' stays allowed for a later toggle.
  lang          TEXT NOT NULL DEFAULT 'en' CHECK (lang IN ('uk','en')),
  placement     TEXT,
  utm           JSONB,
  ip_hash       TEXT,
  consent_at    TIMESTAMPTZ NOT NULL,
  owner_note    TEXT,
  notified_at   TIMESTAMPTZ,
  purged_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_landing_leads_status ON landing_leads (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_landing_leads_ip     ON landing_leads (ip_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS landing_cta_daily (
  day       DATE NOT NULL,
  cta       TEXT NOT NULL,
  placement TEXT NOT NULL,
  lang      TEXT NOT NULL DEFAULT 'en',
  clicks    INT  NOT NULL DEFAULT 0,
  PRIMARY KEY (day, cta, placement, lang)
);

ALTER TABLE youtube_accounts ADD COLUMN IF NOT EXISTS handle          TEXT;
ALTER TABLE youtube_accounts ADD COLUMN IF NOT EXISTS subscribers     INT;
ALTER TABLE youtube_accounts ADD COLUMN IF NOT EXISTS landing_visible BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE youtube_accounts ADD COLUMN IF NOT EXISTS landing_order   INT NOT NULL DEFAULT 0;

ALTER TABLE meta_account_groups ADD COLUMN IF NOT EXISTS landing_blurb_uk TEXT;
ALTER TABLE meta_account_groups ADD COLUMN IF NOT EXISTS landing_blurb_en TEXT;
ALTER TABLE meta_account_groups ADD COLUMN IF NOT EXISTS landing_order    INT NOT NULL DEFAULT 0;

-- Leads carry personal data: make sure the agents' read-only role cannot read them,
-- even if a default privilege or a manual grant gave it access.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'editor_ro') THEN
    REVOKE ALL ON public.landing_leads FROM editor_ro;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'editor_ro revoke skipped (insufficient privilege)';
END $$;

INSERT INTO schema_migrations (version) VALUES ('066_landing_ai_network')
  ON CONFLICT (version) DO NOTHING;
