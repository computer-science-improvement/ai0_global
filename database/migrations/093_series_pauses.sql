-- 093_series_pauses.sql — the dead-series breaker (spec 060).
--
-- series_pauses: a series (or an owner pin, or a resource without a series) whose last N closed slots all skipped for
-- the same cause (no material, or the source is unreachable) is paused by code: the planner stops planning it, planned
-- slots of it are skipped with `series_paused` ($0), and the owner gets one note and one card. One open pause per
-- (channel_key, series_key); a resumed pause stays as history (resumed_at, resumed_by).
--
--   series_key  'series:<name>' | 'rule:<schedule_rule_id>' | 'resource:<resource_ref>' (slots with neither)
--   label       what the owner reads (the series name, or the resource)
--   cause       'no_material' | 'source_unreachable' | 'owner' (the owner paused it from a card)
--   reason      the last skip reason, one line
--   streak      how many skips in a row led to the pause (0 for an owner pause)
--
-- agent_inbox.subject / agent_inbox.parts (spec 060 FR-003): what a note is about (one problem: 'silent:<resource>:miss',
-- 'resource:<ref>', …) and what it said (the causes and numbers as short strings, e.g. 'streak:3'). The memory of a note
-- across days lives in these rows: a note fires again only when it says something its last note did not (a part that is
-- new), or once per OWNER_NOTE_REPEAT_DAYS as "still"; a newer note of the same subject supersedes the older unread ones.
-- NULL for every note that does not use the rule.
--
-- agent_inbox.actions (spec 060 FR-004): the buttons the note's owner-bot card gets before Read / Open, as a JSON list of
-- {key, label} (resume / keep / pause series / mute health). NULL for a note without actions.
--
-- Additive and idempotent (CI re-applies it).

CREATE TABLE IF NOT EXISTS series_pauses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_key TEXT NOT NULL,
  series_key  TEXT NOT NULL,
  label       TEXT NOT NULL,
  cause       TEXT NOT NULL CHECK (cause IN ('no_material', 'source_unreachable', 'owner')),
  reason      TEXT NOT NULL DEFAULT '',
  streak      INT  NOT NULL DEFAULT 0,
  paused_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resumed_at  TIMESTAMPTZ,
  resumed_by  TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_series_pauses_open ON series_pauses (channel_key, series_key) WHERE resumed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_series_pauses_channel ON series_pauses (channel_key, paused_at DESC);

ALTER TABLE agent_inbox ADD COLUMN IF NOT EXISTS subject TEXT;
ALTER TABLE agent_inbox ADD COLUMN IF NOT EXISTS parts   TEXT[];
ALTER TABLE agent_inbox ADD COLUMN IF NOT EXISTS actions JSONB;
CREATE INDEX IF NOT EXISTS idx_agent_inbox_subject ON agent_inbox (subject, created_at DESC) WHERE subject IS NOT NULL;

INSERT INTO schema_migrations (version) VALUES ('093_series_pauses') ON CONFLICT DO NOTHING;
