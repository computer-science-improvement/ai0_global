-- 022_meta_account_insights.sql
-- Daily account-level Meta insights (Phase B): reach / impressions / profile views.
-- One row per account per day, upserted idempotently (the current day firms up as
-- it accrues). Metrics are nullable — a platform that doesn't expose one stores NULL
-- (e.g. Threads has no reach/profile_views).
CREATE TABLE IF NOT EXISTS meta_account_insights (
  id            BIGSERIAL PRIMARY KEY,
  account_id    UUID NOT NULL REFERENCES meta_accounts(id) ON DELETE CASCADE,
  day           DATE NOT NULL,
  reach         INT,
  impressions   INT,
  profile_views INT,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, day)
);
CREATE INDEX IF NOT EXISTS idx_meta_insights_account_day
  ON meta_account_insights (account_id, day DESC);
