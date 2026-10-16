-- 080_channel_setup.sql — channel setup from history (spec 042).
--
-- • channel_setup_proposals: one proposal per analysis of an own channel's last posts — the posts it read, the metrics computed
--   in code, the six proposed sections (brief_profile, formatting, format_mix, series_pillars, schedule, examples_voice), what each
--   section would replace when it was analysed (`baseline`, for the drift check at Apply) and each section's state.
--   A new run supersedes the channel's open proposal; proposals do not expire.
--
-- Additive, non-destructive and idempotent (CI re-applies it).

CREATE TABLE IF NOT EXISTS channel_setup_proposals (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_key    TEXT NOT NULL,
  resource_ref   TEXT NOT NULL,
  agent_id       UUID REFERENCES agents(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'queued',
  reason         TEXT,
  retry_at       TIMESTAMPTZ,
  post_ids       UUID[] NOT NULL DEFAULT '{}',
  metrics        JSONB,
  sections       JSONB,
  section_status JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(section_status) = 'object'),
  baseline       JSONB,
  run_id         UUID,
  cost_usd       NUMERIC(12,6) NOT NULL DEFAULT 0,
  created_by     TEXT NOT NULL DEFAULT 'owner',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at     TIMESTAMPTZ
);

ALTER TABLE channel_setup_proposals DROP CONSTRAINT IF EXISTS channel_setup_proposals_status_check;
ALTER TABLE channel_setup_proposals ADD CONSTRAINT channel_setup_proposals_status_check CHECK (status IN (
  'queued','collecting','analyzing','ready','applied','partially_applied','discarded','superseded','failed','no_access','too_few_posts'));

CREATE INDEX IF NOT EXISTS idx_channel_setup_proposals_channel ON channel_setup_proposals (channel_key, created_at DESC);
-- At most one open proposal per channel (queued … ready); a new run supersedes the old one first.
CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_setup_proposals_open ON channel_setup_proposals (channel_key)
  WHERE status IN ('queued','collecting','analyzing','ready');

INSERT INTO schema_migrations (version) VALUES ('080_channel_setup')
  ON CONFLICT (version) DO NOTHING;
