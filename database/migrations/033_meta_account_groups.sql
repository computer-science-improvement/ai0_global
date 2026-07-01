-- 033_meta_account_groups.sql — group related Meta accounts (the same brand's
-- Facebook + Instagram + Threads) so a strategy that publishes to the Facebook
-- account can fan the SAME post out to its Instagram + Threads siblings.
--
-- A group holds AT MOST ONE account per platform (partial unique index below),
-- so "the IG sibling / the Threads sibling" of a Facebook account is
-- unambiguous. group_id is nullable — an ungrouped account behaves exactly as
-- before (single-destination publishing, no fan-out).
CREATE TABLE IF NOT EXISTS meta_account_groups (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE meta_accounts
  ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES meta_account_groups(id) ON DELETE SET NULL;

-- At most one account per platform within a group → unambiguous fan-out target.
CREATE UNIQUE INDEX IF NOT EXISTS meta_accounts_group_platform_uq
  ON meta_accounts (group_id, platform) WHERE group_id IS NOT NULL;

INSERT INTO schema_migrations (version) VALUES ('033_meta_account_groups') ON CONFLICT DO NOTHING;
