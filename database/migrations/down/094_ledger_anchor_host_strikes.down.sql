-- Down for 094_ledger_anchor_host_strikes.sql (spec 061). The old ledger has no anchored refs: those rows go (the
-- plain-URL rows stay).
DELETE FROM content_ledger WHERE anchor IS NOT NULL;
DROP INDEX IF EXISTS idx_content_ledger_anchor;
ALTER TABLE content_ledger DROP CONSTRAINT IF EXISTS content_ledger_anchor_ref;
DROP FUNCTION IF EXISTS content_ledger_record_anchored(text, text, text, text, text, bigint, bigint, uuid, timestamptz, text);
DROP FUNCTION IF EXISTS content_ref_anchored(text, text);
DROP FUNCTION IF EXISTS content_anchor_norm(text);
ALTER TABLE content_ledger DROP COLUMN IF EXISTS anchor;
ALTER TABLE source_host_failures DROP COLUMN IF EXISTS strikes;
ALTER TABLE source_host_failures DROP COLUMN IF EXISTS noted_at;
DELETE FROM schema_migrations WHERE version = '094_ledger_anchor_host_strikes';
