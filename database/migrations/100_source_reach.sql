-- 100_source_reach.sql — sources proven from the server (spec 076, AI0-254).
--
-- source_probes          the last read of a source address from the server: what a probe saw (cached 6 h, spec 076 FR-001).
--                        One row per canonical URL; `invalid` (a bad or private address) is never stored.
-- source_host_failures   timeouts in a row become an `unreachable` strike (spec 076 FR-002). `consecutive_timeouts` /
--                        `timeouts_since` count them; `last_success_at` is when a fetch of the host last worked (074 reads it
--                        to lift a `source_unreachable` pause). `reason` has no CHECK (079), so `unreachable` needs no constraint.
--
-- Additive and idempotent. Apply it BEFORE the code that writes the new columns: PgHostFailures.record / succeeded swallow
-- their errors, so without it no block would be stored at all.

CREATE TABLE IF NOT EXISTS source_probes (
  url           TEXT PRIMARY KEY,            -- canonicalUrl of the probed address
  host          TEXT NOT NULL,
  ok            BOOLEAN NOT NULL,
  failure_class TEXT CHECK (failure_class IN ('timeout','refused','tls','dns','http','empty')),
  status        INT,
  kind          TEXT NOT NULL CHECK (kind IN ('rss','page')),
  feed_url      TEXT,
  items         INT NOT NULL DEFAULT 0,
  newest_at     TIMESTAMPTZ,
  sample_titles JSONB NOT NULL DEFAULT '[]'::jsonb,
  detail        TEXT NOT NULL DEFAULT '',
  ms            INT,
  via_proxy     BOOLEAN NOT NULL DEFAULT false,
  checked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ok OR failure_class IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_source_probes_host ON source_probes (host, checked_at DESC);

-- F13: timeouts in a row become an `unreachable` strike (FR-002). Existing rows start at 0.
ALTER TABLE source_host_failures ADD COLUMN IF NOT EXISTS consecutive_timeouts INT NOT NULL DEFAULT 0;
ALTER TABLE source_host_failures ADD COLUMN IF NOT EXISTS timeouts_since       TIMESTAMPTZ;
ALTER TABLE source_host_failures ADD COLUMN IF NOT EXISTS last_success_at      TIMESTAMPTZ;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'editor_ro') THEN
    EXECUTE 'GRANT SELECT ON public.source_probes TO editor_ro';
  END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES ('100_source_reach') ON CONFLICT DO NOTHING;
