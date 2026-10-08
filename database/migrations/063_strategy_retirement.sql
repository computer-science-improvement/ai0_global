-- 063_strategy_retirement.sql — retiring strategy bindings after their migration to agent series (spec 023 T6).
--
-- 059 already added strategy_bindings.retired_at / retired_reason / migrated_to and widened
-- playbooks.created_by with 'migration'; this file re-asserts both idempotently (a database that skipped
-- 059's tail still converges) and adds the guards the cutover relies on:
-- • a retired binding stays disabled: re-enabling it must clear the retirement in the same UPDATE
--   (the rollback card does; anything else fails, the API answers 409 binding_retired first);
-- • a retirement always names its reason ('migrated' for a cutover, 'owner' reserved for a manual retire);
-- • migrated_to is an object ({agent_id, handle, playbook_id, series[]}) when present.
--
-- Additive and idempotent.

ALTER TABLE strategy_bindings ADD COLUMN IF NOT EXISTS retired_at     TIMESTAMPTZ;
ALTER TABLE strategy_bindings ADD COLUMN IF NOT EXISTS retired_reason TEXT;
ALTER TABLE strategy_bindings ADD COLUMN IF NOT EXISTS migrated_to    JSONB;

ALTER TABLE strategy_bindings DROP CONSTRAINT IF EXISTS strategy_bindings_retired_chk;
ALTER TABLE strategy_bindings ADD CONSTRAINT strategy_bindings_retired_chk CHECK (
  (retired_at IS NULL AND retired_reason IS NULL)
  OR (retired_at IS NOT NULL AND enabled = false AND retired_reason IN ('migrated', 'owner'))
);

ALTER TABLE strategy_bindings DROP CONSTRAINT IF EXISTS strategy_bindings_migrated_to_chk;
ALTER TABLE strategy_bindings ADD CONSTRAINT strategy_bindings_migrated_to_chk CHECK (
  migrated_to IS NULL OR jsonb_typeof(migrated_to) = 'object'
);

CREATE INDEX IF NOT EXISTS idx_strategy_bindings_retired ON strategy_bindings (retired_at) WHERE retired_at IS NOT NULL;

-- playbooks.created_by: the migration draft of a strategy migration (T1–T3 notes: "the DB check that allows
-- created_by='migration' comes with T6").
ALTER TABLE playbooks DROP CONSTRAINT IF EXISTS playbooks_created_by_check;
ALTER TABLE playbooks ADD CONSTRAINT playbooks_created_by_check CHECK (created_by IN ('orchestrator','owner','migration','directive'));
-- 'directive' comes with 065_directive_binding; listed here too so a re-run of 063 never narrows the check.

INSERT INTO schema_migrations (version) VALUES ('063_strategy_retirement')
  ON CONFLICT (version) DO NOTHING;
