-- Down for 090_setup_proposal_expired.sql (spec 057): expired proposals go back to `discarded`, then the old status list returns.
UPDATE channel_setup_proposals SET status = 'discarded' WHERE status = 'expired';
ALTER TABLE channel_setup_proposals DROP CONSTRAINT IF EXISTS channel_setup_proposals_status_check;
ALTER TABLE channel_setup_proposals ADD CONSTRAINT channel_setup_proposals_status_check CHECK (status IN (
  'queued','collecting','analyzing','ready','applied','partially_applied','discarded','superseded','failed','no_access','too_few_posts'));
DELETE FROM schema_migrations WHERE version = '090_setup_proposal_expired';
