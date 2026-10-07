-- 062_resource_formatting.sql — derived posts and agent-owned formatting (spec 024 T3, T4, T8).
--
-- • media_holds: hosted slides of a source slot that has derived (duplicate /
--   adapt) slots still pending; deleted after the last derived slot finishes or
--   after 24 h (FR-007).
-- • content_decisions.call_id: one repurpose_post call (its targets share it);
--   the orchestrator's daily cap counts calls (FR-008).
-- • network_posts gains post_ref ('tg:<published_posts.id>' / 'pp:<platform_posts.id>')
--   so an agent can name a repurpose_post source (appended column; same rows).
-- • resource_profile_versions: every change of a resource profile and of its
--   format_prefs (who, when, why, diff) — owner edits and the agents'
--   update_resource_format (≤ 3 a day per resource) (FR-013).
--
-- Additive and idempotent.

-- ── delayed media cleanup (T3) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS media_holds (
  slot_id    UUID PRIMARY KEY REFERENCES editor_slots(id) ON DELETE CASCADE,
  paths      TEXT[] NOT NULL DEFAULT '{}',
  urls       TEXT[] NOT NULL DEFAULT '{}',
  hold_until TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_media_holds_until ON media_holds (hold_until);

-- ── repurpose_post calls (T4) ────────────────────────────────────────────────
ALTER TABLE content_decisions ADD COLUMN IF NOT EXISTS call_id UUID;
CREATE INDEX IF NOT EXISTS idx_content_decisions_call ON content_decisions (agent_id, created_at) WHERE call_id IS NOT NULL;

CREATE OR REPLACE VIEW network_posts AS
SELECT 'telegram:' || p.channel_id                    AS resource_ref,
       'telegram'::text                               AS platform,
       p.message_id::text                             AS external_id,
       COALESCE(p.format, 'legacy')                   AS format,
       p.title                                        AS excerpt,
       p.source_url                                   AS source_ref,
       p.posted_at,
       s.views                                        AS views,
       COALESCE(s.forwards, 0) + COALESCE(s.reactions_total, 0) + COALESCE(s.replies, 0) AS engagement,
       'tg:' || p.id                                  AS post_ref
  FROM published_posts p
  LEFT JOIN LATERAL (
    SELECT views, forwards, replies, reactions_total FROM post_stats_snapshots
     WHERE post_id = p.id ORDER BY captured_at DESC LIMIT 1
  ) s ON true
UNION ALL
SELECT pp.resource_ref, pp.platform, pp.external_id, pp.format, left(pp.caption, 200), pp.source_ref, pp.posted_at,
       COALESCE(m.views, m.reach),
       COALESCE(m.likes, 0) + COALESCE(m.comments, 0) + COALESCE(m.shares, 0) + COALESCE(m.saves, 0),
       'pp:' || pp.id
  FROM platform_posts pp
  LEFT JOIN LATERAL (
    SELECT views, reach, likes, comments, shares, saves FROM platform_post_metrics
     WHERE post_id = pp.id ORDER BY captured_at DESC LIMIT 1
  ) m ON true
 WHERE pp.status = 'published' AND pp.platform <> 'telegram';

-- ── profile / format_prefs versions (T8) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS resource_profile_versions (
  id           BIGSERIAL PRIMARY KEY,
  resource_ref TEXT NOT NULL,
  version      INT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('profile','format')),
  changed_by   TEXT NOT NULL CHECK (changed_by IN ('owner','builder','agent','system')),
  agent_id     UUID REFERENCES agents(id) ON DELETE SET NULL,
  reason       TEXT,
  diff         JSONB NOT NULL DEFAULT '{}',
  profile      JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (resource_ref, version)
);
CREATE INDEX IF NOT EXISTS idx_resource_profile_versions_ref ON resource_profile_versions (resource_ref, created_at DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'editor_ro') THEN
    GRANT SELECT ON public.resource_profile_versions TO editor_ro;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'editor_ro grants skipped (insufficient privilege)';
END $$;

INSERT INTO schema_migrations (version) VALUES ('062_resource_formatting')
  ON CONFLICT (version) DO NOTHING;
