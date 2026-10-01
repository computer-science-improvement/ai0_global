-- 045_scheduled_publications_unknown.sql — new status 'unknown' for scheduled posts.
--
-- A row stuck in 'sending' (the process died or hung between claiming it and
-- recording the Telegram message id) may or may not have been delivered. The
-- worker used to flip such rows back to 'pending' and send them again, which
-- can publish a duplicate. It now marks them 'unknown' and alerts the owner.
--
-- Idempotent: drops and re-adds the status CHECK (the inline constraint from
-- 014 has the default name scheduled_publications_status_check).
ALTER TABLE scheduled_publications
  DROP CONSTRAINT IF EXISTS scheduled_publications_status_check;
ALTER TABLE scheduled_publications
  ADD CONSTRAINT scheduled_publications_status_check
  CHECK (status IN ('pending','sending','sent','failed','canceled','unknown'));

INSERT INTO schema_migrations (version) VALUES ('045_scheduled_publications_unknown')
  ON CONFLICT (version) DO NOTHING;
