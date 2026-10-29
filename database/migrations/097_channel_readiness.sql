-- 097_channel_readiness.sql — the channel doctor's stored result (spec 072).
--
-- channel_readiness: one row per channel card (channel_key is the card's own spelling, e.g. '@pdr_dev_channel'). The doctor
-- (readiness/doctor.ts) runs in code at $0 on facts read in one place; this row is what it found, so the dashboard, the owner
-- bot and Start read it without running anything.
--
--   findings           the doctor's findings (Finding[] with link and firstSeenAt), errors first
--   blockers/warnings  counts of the open error / warn findings (info rows and 'auto_fixed' rows are in neither)
--   config_hash        sha256 of the config parts of the facts only (never counts, pauses, host blocks, slots or updated_at)
--   applied_hash       NULL until spec 074 writes the hash of the config it last repaired the plan for; 072 never writes it
--   checked_at         when the doctor last ran
--   notified_at        when the owner bot last got a card about the blockers (at most one a day per channel)
--   notified_blockers  sorted finding keys that card named; a different set makes a new card
--
-- Additive and idempotent (CI re-applies it).

CREATE TABLE IF NOT EXISTS channel_readiness (
  channel_key       TEXT PRIMARY KEY,
  findings          JSONB NOT NULL DEFAULT '[]'::jsonb,
  blockers          INT   NOT NULL DEFAULT 0,
  warnings          INT   NOT NULL DEFAULT 0,
  config_hash       TEXT  NOT NULL DEFAULT '',
  applied_hash      TEXT,
  checked_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified_at       TIMESTAMPTZ,
  notified_blockers JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_channel_readiness_open ON channel_readiness (checked_at) WHERE blockers > 0;

INSERT INTO schema_migrations (version) VALUES ('097_channel_readiness') ON CONFLICT DO NOTHING;
