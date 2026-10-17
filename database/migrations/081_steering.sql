-- 081_steering.sql — steering (spec 045).
--
-- • steering_sets: one reference resource that is not ours (`source_ref`, e.g. telegram:@ref) applied to one of our resources
--   (`target_ref`, e.g. telegram:@mine): a snapshot of the reference's last posts (`posts`, texts dropped once the set is
--   discarded or superseded), the metrics computed in code, a summary and up to 12 rules. The enabled, non-conflicting rules of
--   active sets are the lowest-priority rule source of the target's agent. Analysing again opens a new set; activating it
--   supersedes the old one.
--
-- Additive, non-destructive and idempotent (CI re-applies it).

CREATE TABLE IF NOT EXISTS steering_sets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_ref    TEXT NOT NULL,
  channel_key   TEXT,
  source_ref    TEXT NOT NULL,
  source_title  TEXT,
  status        TEXT NOT NULL DEFAULT 'queued',
  reason        TEXT,
  retry_at      TIMESTAMPTZ,
  posts         JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(posts) = 'array'),
  metrics       JSONB,
  summary       TEXT,
  rules         JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(rules) = 'array'),
  run_id        UUID,
  cost_usd      NUMERIC(12,6) NOT NULL DEFAULT 0,
  created_by    TEXT NOT NULL DEFAULT 'owner',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at  TIMESTAMPTZ
);

ALTER TABLE steering_sets DROP CONSTRAINT IF EXISTS steering_sets_status_check;
ALTER TABLE steering_sets ADD CONSTRAINT steering_sets_status_check CHECK (status IN (
  'queued','collecting','analyzing','ready','active','paused','discarded','superseded','failed','no_access','too_few_posts'));

CREATE INDEX IF NOT EXISTS idx_steering_sets_target ON steering_sets (target_ref, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_steering_sets_active ON steering_sets (target_ref) WHERE status = 'active';
-- One set in the making per (target, source): queued … ready. Active / paused sets live next to a new analysis until it is activated.
CREATE UNIQUE INDEX IF NOT EXISTS uq_steering_sets_pending ON steering_sets (target_ref, source_ref)
  WHERE status IN ('queued','collecting','analyzing','ready');

INSERT INTO schema_migrations (version) VALUES ('081_steering')
  ON CONFLICT (version) DO NOTHING;
