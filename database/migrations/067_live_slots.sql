-- 067_live_slots.sql — live news slots and the intra-day news watch (spec 034 FR-010, FR-011).
--
-- • editor_slots.topic_mode: 'fixed' (the planner chose the topic) or 'live' (the executor picks the
--   freshest item of the slot's source at slot time). Existing rows are 'fixed'.
-- • editor_slots.live_spec: what a live slot works from:
--   { sources: [feed URL | card source id | feed:<id> | api:<name>], brief, max_age_hours,
--     origin: 'planner' | 'news_watch' | 'pin', item?: { url, title, published_at } }.
-- • news_watch_log: the code-only feed check of news resources (no LLM) — why an item was added as a
--   live slot or ignored, and one 'checked' row per check (its summary).
--
-- Additive and idempotent: CI re-applies this file on top of the full schema.

ALTER TABLE editor_slots ADD COLUMN IF NOT EXISTS topic_mode TEXT NOT NULL DEFAULT 'fixed';
ALTER TABLE editor_slots ADD COLUMN IF NOT EXISTS live_spec  JSONB;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'editor_slots'::regclass AND conname = 'editor_slots_topic_mode_check') THEN
    ALTER TABLE editor_slots ADD CONSTRAINT editor_slots_topic_mode_check CHECK (topic_mode IN ('fixed', 'live'));
  END IF;
END $$;

-- The news watch looks up today's live slots of a channel by the item they were added for.
CREATE INDEX IF NOT EXISTS idx_editor_slots_live_item ON editor_slots (channel_key, (live_spec->'item'->>'url'))
  WHERE topic_mode = 'live';

CREATE TABLE IF NOT EXISTS news_watch_log (
  id           BIGSERIAL PRIMARY KEY,
  channel_key  TEXT NOT NULL,
  resource_ref TEXT NOT NULL,
  checked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 'checked': one row per check (reason = summary); 'added': a live slot was added; 'ignored': why not.
  decision     TEXT NOT NULL CHECK (decision IN ('checked', 'added', 'ignored')),
  reason       TEXT,
  item_url     TEXT,
  item_title   TEXT,
  item_at      TIMESTAMPTZ,
  feed         TEXT,
  score        NUMERIC(5, 3),
  slot_id      UUID REFERENCES editor_slots(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_news_watch_log_channel ON news_watch_log (channel_key, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_watch_log_item    ON news_watch_log (channel_key, item_url) WHERE item_url IS NOT NULL;

-- Read access for agent SQL (editor_ro, migration 042).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'editor_ro') THEN
    GRANT SELECT ON public.news_watch_log TO editor_ro;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'editor_ro grants skipped (insufficient privilege)';
END $$;

INSERT INTO schema_migrations (version) VALUES ('067_live_slots')
  ON CONFLICT (version) DO NOTHING;
