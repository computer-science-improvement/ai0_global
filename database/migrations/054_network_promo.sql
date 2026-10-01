-- 054_network_promo.sql — cross-promo and reposts between own resources, tracked
-- links and the transitions KPI (spec 022).
--
-- Additive and idempotent.

CREATE TABLE IF NOT EXISTS tracked_links (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           TEXT NOT NULL CHECK (kind IN ('tg_invite','utm')),
  target_ref     TEXT NOT NULL,
  source_ref     TEXT NOT NULL,
  slot_id        UUID,
  directive_id   UUID,
  url            TEXT NOT NULL UNIQUE,
  code           TEXT UNIQUE,
  tg_invite_name TEXT,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tracked_links_target ON tracked_links (target_ref, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tracked_links_name ON tracked_links (tg_invite_name);

-- Joins (Telegram invite links) and clicks (UTM redirects). Only a salted hash of a user id is kept.
CREATE TABLE IF NOT EXISTS link_joins (
  id           BIGSERIAL PRIMARY KEY,
  link_id      UUID NOT NULL REFERENCES tracked_links(id) ON DELETE CASCADE,
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  tg_user_hash TEXT,
  count        INT NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_link_joins_link ON link_joins (link_id, joined_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_link_joins_user ON link_joins (link_id, tg_user_hash) WHERE tg_user_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS promo_pairs (
  source_ref     TEXT NOT NULL,
  target_ref     TEXT NOT NULL,
  last_promo_at  TIMESTAMPTZ,
  count_30d      INT NOT NULL DEFAULT 0,
  relevance      SMALLINT,
  relevance_at   TIMESTAMPTZ,
  PRIMARY KEY (source_ref, target_ref)
);

-- Promo metadata on a reserved slot: { kind: cross_promo|repost, source_ref, target_ref, tracked_link_id, directive_id, post_ref? }.
ALTER TABLE editor_slots ADD COLUMN IF NOT EXISTS promo JSONB;

DO $$
DECLARE
  t TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'editor_ro') THEN
    FOREACH t IN ARRAY ARRAY['tracked_links','promo_pairs'] LOOP
      EXECUTE format('GRANT SELECT ON public.%I TO editor_ro', t);
    END LOOP;
    -- link_joins: counts only through tracked_links joins in views; the hashes stay private.
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'editor_ro grants skipped (insufficient privilege)';
END $$;

INSERT INTO schema_migrations (version) VALUES ('054_network_promo')
  ON CONFLICT (version) DO NOTHING;
