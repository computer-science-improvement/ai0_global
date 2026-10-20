-- 090_setup_proposal_expired.sql — channel setup proposals expire (spec 057).
--
-- A proposal left `ready` / `partially_applied` for SETUP_PROPOSAL_TTL_DAYS becomes `expired` (final, like `discarded`):
-- the status check gets the new value. No data changes here — the hourly sweep in the editor does the closing.
--
-- Additive, non-destructive and idempotent (CI re-applies it).

ALTER TABLE channel_setup_proposals DROP CONSTRAINT IF EXISTS channel_setup_proposals_status_check;
ALTER TABLE channel_setup_proposals ADD CONSTRAINT channel_setup_proposals_status_check CHECK (status IN (
  'queued','collecting','analyzing','ready','applied','partially_applied','discarded','superseded','failed','no_access','too_few_posts','expired'));

INSERT INTO schema_migrations (version) VALUES ('090_setup_proposal_expired') ON CONFLICT DO NOTHING;
