-- 021_meta_follower_history.sql
-- Hourly follower-count snapshots per Meta account (Phase A stats), mirroring
-- tracked_subs_history for Telegram channels. Instagram/Facebook only — Threads
-- has no follower count without a gated insights scope, so it simply accrues no rows.

CREATE TABLE IF NOT EXISTS meta_follower_history (
  account_id   UUID        NOT NULL REFERENCES meta_accounts(id) ON DELETE CASCADE,
  snapshot_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  followers    INTEGER     NOT NULL,
  PRIMARY KEY (account_id, snapshot_at)
);

CREATE INDEX IF NOT EXISTS idx_meta_follower_history_account_time
  ON meta_follower_history (account_id, snapshot_at DESC);
