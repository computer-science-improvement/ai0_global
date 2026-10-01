-- 051_platform_posts.sql — native multi-platform publishing (spec 019).
--
-- Posts on Instagram / Facebook / Threads / TikTok / YouTube made by the agents
-- (not mirrors of Telegram), their metrics, per-resource daily stats, YouTube
-- accounts, TikTok accounts joining networks, and one read view over every
-- platform for the agents (network_posts).
--
-- Additive and idempotent.

CREATE TABLE IF NOT EXISTS platform_posts (
  id           BIGSERIAL PRIMARY KEY,
  resource_ref TEXT NOT NULL,
  platform     TEXT NOT NULL CHECK (platform IN ('telegram','instagram','facebook','threads','tiktok','youtube')),
  external_id  TEXT,
  url          TEXT,
  slot_id      UUID,
  idea_id      UUID,
  format       TEXT NOT NULL,
  caption      TEXT,
  spec         JSONB NOT NULL,
  source_ref   TEXT,
  status       TEXT NOT NULL CHECK (status IN ('published','shadowed','failed')),
  error        TEXT,
  agent_id     UUID,
  posted_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_posts_external ON platform_posts (platform, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_platform_posts_resource ON platform_posts (resource_ref, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_posts_slot ON platform_posts (slot_id);

CREATE TABLE IF NOT EXISTS platform_post_metrics (
  id          BIGSERIAL PRIMARY KEY,
  post_id     BIGINT NOT NULL REFERENCES platform_posts(id) ON DELETE CASCADE,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  views       INT,
  reach       INT,
  likes       INT,
  comments    INT,
  shares      INT,
  saves       INT,
  extra       JSONB
);
CREATE INDEX IF NOT EXISTS idx_platform_post_metrics_post ON platform_post_metrics (post_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS resource_daily_stats (
  resource_ref    TEXT NOT NULL,
  day             DATE NOT NULL,
  followers       INT,
  followers_delta INT,
  reach           INT,
  views           INT,
  engagement      INT,
  extra           JSONB,
  PRIMARY KEY (resource_ref, day)
);

CREATE TABLE IF NOT EXISTS youtube_accounts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id        TEXT NOT NULL UNIQUE,
  title             TEXT,
  access_token_enc  TEXT,
  refresh_token_enc TEXT,
  expires_at        TIMESTAMPTZ,
  scope             TEXT,
  group_id          UUID REFERENCES meta_account_groups(id) ON DELETE SET NULL,
  active            BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- TikTok accounts can belong to a network (account group) like Meta accounts.
ALTER TABLE tiktok_accounts ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES meta_account_groups(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tiktok_accounts_group ON tiktok_accounts (group_id) WHERE group_id IS NOT NULL;

-- Slots can target any resource of a network (spec 019/020).
ALTER TABLE editor_slots ADD COLUMN IF NOT EXISTS resource_ref  TEXT;
ALTER TABLE editor_slots ADD COLUMN IF NOT EXISTS platform_spec JSONB;

-- Every post of every platform, one shape for agents and the KPI digest.
CREATE OR REPLACE VIEW network_posts AS
SELECT 'telegram:' || p.channel_id                    AS resource_ref,
       'telegram'::text                               AS platform,
       p.message_id::text                             AS external_id,
       COALESCE(p.format, 'legacy')                   AS format,
       p.title                                        AS excerpt,
       p.source_url                                   AS source_ref,
       p.posted_at,
       s.views                                        AS views,
       COALESCE(s.forwards, 0) + COALESCE(s.reactions_total, 0) + COALESCE(s.replies, 0) AS engagement
  FROM published_posts p
  LEFT JOIN LATERAL (
    SELECT views, forwards, replies, reactions_total FROM post_stats_snapshots
     WHERE post_id = p.id ORDER BY captured_at DESC LIMIT 1
  ) s ON true
UNION ALL
SELECT pp.resource_ref, pp.platform, pp.external_id, pp.format, left(pp.caption, 200), pp.source_ref, pp.posted_at,
       COALESCE(m.views, m.reach),
       COALESCE(m.likes, 0) + COALESCE(m.comments, 0) + COALESCE(m.shares, 0) + COALESCE(m.saves, 0)
  FROM platform_posts pp
  LEFT JOIN LATERAL (
    SELECT views, reach, likes, comments, shares, saves FROM platform_post_metrics
     WHERE post_id = pp.id ORDER BY captured_at DESC LIMIT 1
  ) m ON true
 WHERE pp.status = 'published' AND pp.platform <> 'telegram';

DO $$
DECLARE
  t TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'editor_ro') THEN
    -- NOT youtube_accounts (tokens).
    FOREACH t IN ARRAY ARRAY['platform_posts','platform_post_metrics','resource_daily_stats','network_posts'] LOOP
      EXECUTE format('GRANT SELECT ON public.%I TO editor_ro', t);
    END LOOP;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'editor_ro grants skipped (insufficient privilege)';
END $$;

INSERT INTO schema_migrations (version) VALUES ('051_platform_posts')
  ON CONFLICT (version) DO NOTHING;
