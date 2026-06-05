-- 013_tracking_status.sql
-- Per-channel tracking reachability for the MTProto session. When the session
-- account isn't a member / can't resolve the channel, poll-meta marks it
-- 'not_subscribed' so the dashboard can prompt "subscribe to track" instead of
-- spamming errors. 'ok' on a successful poll; 'unknown' until first poll.
ALTER TABLE tracked_channels
  ADD COLUMN IF NOT EXISTS tracking_status     TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS tracking_checked_at TIMESTAMPTZ;

INSERT INTO schema_migrations (version) VALUES ('013_tracking_status')
  ON CONFLICT (version) DO NOTHING;
