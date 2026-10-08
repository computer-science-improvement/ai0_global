-- 064_network_offers.sql — owner offers to convert a legacy auto-duplicate network (spec 024 T5, FR-010).
--
-- One row per (group, kind): the once-per-group housekeeping step inserts it
-- with ON CONFLICT DO NOTHING, so the Inbox item `network_independent_offer`
-- is written once. `had_playbook` records whether the anchor orchestrator had
-- an active playbook when it was offered; the offer is repeated once when a
-- first playbook is approved later (`reoffered_at`). The owner's answer is
-- `status`: switched (the network went independent) or kept (never offered again).
--
-- Additive and idempotent.

CREATE TABLE IF NOT EXISTS network_offers (
  group_id     UUID NOT NULL REFERENCES meta_account_groups(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  agent_id     UUID REFERENCES agents(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'switched', 'kept')),
  had_playbook BOOLEAN NOT NULL DEFAULT false,
  checklist    JSONB,
  inbox_id     BIGINT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  reoffered_at TIMESTAMPTZ,
  decided_at   TIMESTAMPTZ,
  decided_by   TEXT,
  PRIMARY KEY (group_id, kind)
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'editor_ro') THEN
    GRANT SELECT ON public.network_offers TO editor_ro;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'editor_ro grants skipped (insufficient privilege)';
END $$;

INSERT INTO schema_migrations (version) VALUES ('064_network_offers')
  ON CONFLICT (version) DO NOTHING;
