-- 104_channel_slo.sql — the channel SLO controller (spec 091).
--
-- channel_slo        one row per channel and local day: the day's target (spec 091 FR-001), what was published, what is
--                    still planned, skips, replacement slots and recovery runs, and the state the controller computed
--                    (on_track / behind / recovering / starved / dark / held / met). Written by SloController each tick;
--                    read by /app/health (Channels), GET /api/editor/slo, the daily report, the KPI digest, silent days
--                    and escalation.
-- editor_slots.slo   set on a slot the controller inserted: {replaces, rung, cause, depth} (FR-003, FR-004). replacePlan
--                    keeps these slots; a replacement of a replacement stops at depth 2.
-- series_pauses      a whole-channel pause (`resource:telegram:<channel>`) is no longer created by the breaker (FR-002);
--                    the open ones the breaker made (cause other than `owner`) are closed with resumed_by = 'slo'.
--
-- Apply it with the deploy, after 103. The code that writes channel_slo swallows its errors, so before 104 the
-- controller only logs; the pause cleanup is idempotent.

CREATE TABLE IF NOT EXISTS channel_slo (
  channel_key    TEXT NOT NULL,
  day            DATE NOT NULL,
  target         INT  NOT NULL,
  published      INT  NOT NULL DEFAULT 0,
  planned_ahead  INT  NOT NULL DEFAULT 0,
  skipped        INT  NOT NULL DEFAULT 0,
  replacements   INT  NOT NULL DEFAULT 0,
  recovery_runs  INT  NOT NULL DEFAULT 0,
  state          TEXT NOT NULL CHECK (state IN ('on_track','behind','recovering','starved','dark','held','met')),
  reason         TEXT,
  last_post_at   TIMESTAMPTZ,
  dark_since     TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_key, day)
);
CREATE INDEX IF NOT EXISTS idx_channel_slo_day ON channel_slo (day DESC);

ALTER TABLE editor_slots ADD COLUMN IF NOT EXISTS slo JSONB;

UPDATE series_pauses SET resumed_at = now(), resumed_by = 'slo'
 WHERE resumed_at IS NULL AND series_key LIKE 'resource:telegram:%' AND cause <> 'owner';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'editor_ro') THEN
    EXECUTE 'GRANT SELECT ON public.channel_slo TO editor_ro';
  END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES ('104_channel_slo') ON CONFLICT DO NOTHING;
