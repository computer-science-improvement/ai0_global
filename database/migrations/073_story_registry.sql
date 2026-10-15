-- 073_story_registry.sql — the story registry: one story, one post; back only with new facts (spec 037 T2, AI0-96).
--
-- The DEV channels told the same story again and again (Apple hub ×4, Out of Sight ×3, the same Steam deals twice in
-- 1 h 43 min, the Gemini agent in both AI channels on one morning). The publish guard now matches a post's entities
-- with the resource's posts of 14 days (code: story/story-match.ts); this registry keeps what the matching found, so
-- the planner and the writer see the active stories, the critic sees the story's earlier posts and a follow-up can go
-- out as a reply to its original.
--
-- • editor_stories: one story per scope — the owner's network (`network`: every channel the editor runs; a brand group
--   holds one Telegram channel only, migration 034) or a resource (`telegram:<channel_key>`) — with its key, title, entities
--   ({entities: [{key, kind, text, weight}], stems: [...]}), status, first and last post, `event_at` (T3: the
--   announced event) and key facts (the follow-ups' new facts). kind `evergreen` = an evergreen topic (30-day
--   no-repeat, T10).
-- • editor_story_posts: the posts of a story — a slot (written / waiting / published) or a published post (backfill)
--   — with the resource, role (original | followup | reminder | roundup | repost | evergreen), the Telegram message
--   id (the reply target of a follow-up; the forwarded message of a repost), the cross-channel decision
--   (own_angle / repost) and its reason, and for a repost the sibling's original it forwards.
-- • published_posts.strategy_type 'repost' marks a native forward of a network sibling's post (spec 022 repost and
--   T2 story_repost): counted separately from own posts, left out of the KPI samples (kpiSampleFilter).
--
-- Additive, guarded and idempotent: CI re-applies this file. Down: database/migrations/down/073_story_registry.down.sql.

CREATE TABLE IF NOT EXISTS editor_stories (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_ref     TEXT NOT NULL,
  story_key     TEXT NOT NULL,
  title         TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'news' CHECK (kind IN ('news', 'evergreen')),
  entities      JSONB NOT NULL DEFAULT '{}'::jsonb,
  key_facts     JSONB NOT NULL DEFAULT '[]'::jsonb,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  event_at      TIMESTAMPTZ,
  first_post_at TIMESTAMPTZ NOT NULL,
  last_post_at  TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scope_ref, story_key)
);
CREATE INDEX IF NOT EXISTS idx_editor_stories_scope_last ON editor_stories (scope_ref, last_post_at DESC);

CREATE TABLE IF NOT EXISTS editor_story_posts (
  id                BIGSERIAL PRIMARY KEY,
  story_id          UUID NOT NULL REFERENCES editor_stories(id) ON DELETE CASCADE,
  resource_ref      TEXT NOT NULL,
  role              TEXT NOT NULL CHECK (role IN ('original', 'followup', 'reminder', 'roundup', 'repost', 'evergreen')),
  slot_id           UUID,
  published_post_id BIGINT,
  message_id        BIGINT,
  posted_at         TIMESTAMPTZ NOT NULL,
  lead              TEXT,
  facts             JSONB NOT NULL DEFAULT '[]'::jsonb,
  decision          TEXT CHECK (decision IN ('own_angle', 'repost')),
  reason            TEXT,
  repost_of         BIGINT REFERENCES editor_story_posts(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_editor_story_posts_slot ON editor_story_posts (story_id, slot_id) WHERE slot_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_editor_story_posts_published
  ON editor_story_posts (story_id, published_post_id) WHERE published_post_id IS NOT NULL AND slot_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_editor_story_posts_resource ON editor_story_posts (resource_ref, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_editor_story_posts_story ON editor_story_posts (story_id, posted_at);

DO $$
DECLARE
  t TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'editor_ro') THEN
    FOREACH t IN ARRAY ARRAY['editor_stories', 'editor_story_posts'] LOOP
      EXECUTE format('GRANT SELECT ON public.%I TO editor_ro', t);
    END LOOP;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'editor_ro grants skipped (insufficient privilege)';
END $$;

INSERT INTO schema_migrations (version) VALUES ('073_story_registry')
  ON CONFLICT (version) DO NOTHING;
