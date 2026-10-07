-- 059_schedule_rules.sql — owner schedule rules and series slots (spec 023 FR-001, T4).
--
-- • schedule_rules: the owner's schedule commitments per resource of an agent:
--     pin       — a fixed post at a local time (materialised as an editor_slots row, idempotent per rule and date);
--     blackout  — no planned post between at_local and until_local (may wrap past midnight);
--     frequency — per_day_min / per_day_max override the playbook per_day and the card's posts per day.
--   Times are local to the rule's resource (resource_tz()); days: 0 = Sunday, NULL = every day.
-- • editor_slots: schedule_rule_id (the pin a slot materialises), rule_date (its local date; the idempotency
--   key with schedule_rule_id) and series_name (the playbook series the slot is an instance of).
-- • strategy_bindings: retirement columns for the binding migration (T6).
-- • playbooks.created_by also allows 'migration' (T6 migration drafts).
--
-- Additive and idempotent.

CREATE TABLE IF NOT EXISTS schedule_rules (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  resource_ref TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('pin','blackout','frequency')),
  days         SMALLINT[],
  at_local     TEXT CHECK (at_local IS NULL OR at_local ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  until_local  TEXT CHECK (until_local IS NULL OR until_local ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  window_min   INT NOT NULL DEFAULT 20 CHECK (window_min BETWEEN 0 AND 120),
  format       TEXT,
  series_name  TEXT,
  brief        TEXT,
  source       JSONB,
  per_day_min  INT CHECK (per_day_min IS NULL OR per_day_min BETWEEN 0 AND 24),
  per_day_max  INT CHECK (per_day_max IS NULL OR per_day_max BETWEEN 0 AND 24),
  valid_from   DATE,
  valid_until  DATE,
  active       BOOLEAN NOT NULL DEFAULT true,
  created_by   TEXT NOT NULL DEFAULT 'owner' CHECK (created_by IN ('owner','chat')),
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT schedule_rules_days_chk CHECK (days IS NULL OR (cardinality(days) BETWEEN 1 AND 7 AND days <@ ARRAY[0,1,2,3,4,5,6]::smallint[])),
  CONSTRAINT schedule_rules_valid_chk CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_from <= valid_until),
  CONSTRAINT schedule_rules_kind_chk CHECK (
       (kind = 'pin'       AND at_local IS NOT NULL)
    OR (kind = 'blackout'  AND at_local IS NOT NULL AND until_local IS NOT NULL AND at_local <> until_local)
    OR (kind = 'frequency' AND (per_day_min IS NOT NULL OR per_day_max IS NOT NULL)
                           AND (per_day_min IS NULL OR per_day_max IS NULL OR per_day_min <= per_day_max))
  )
);
CREATE INDEX IF NOT EXISTS idx_schedule_rules_agent    ON schedule_rules (agent_id, active);
CREATE INDEX IF NOT EXISTS idx_schedule_rules_resource ON schedule_rules (resource_ref) WHERE active;

-- ── series and pin slots ────────────────────────────────────────────────────
ALTER TABLE editor_slots ADD COLUMN IF NOT EXISTS schedule_rule_id UUID REFERENCES schedule_rules(id) ON DELETE SET NULL;
ALTER TABLE editor_slots ADD COLUMN IF NOT EXISTS rule_date        DATE;
ALTER TABLE editor_slots ADD COLUMN IF NOT EXISTS series_name      TEXT;
-- A pin is materialised once per (rule, local date); a skipped or published pin is never re-created.
CREATE UNIQUE INDEX IF NOT EXISTS uq_editor_slots_rule_date ON editor_slots (schedule_rule_id, rule_date)
  WHERE schedule_rule_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_editor_slots_series ON editor_slots (series_name, scheduled_at) WHERE series_name IS NOT NULL;

-- ── strategy binding retirement (T6) ────────────────────────────────────────
ALTER TABLE strategy_bindings ADD COLUMN IF NOT EXISTS retired_at     TIMESTAMPTZ;
ALTER TABLE strategy_bindings ADD COLUMN IF NOT EXISTS retired_reason TEXT;
ALTER TABLE strategy_bindings ADD COLUMN IF NOT EXISTS migrated_to    JSONB;

-- ── playbooks.created_by += migration ───────────────────────────────────────
ALTER TABLE playbooks DROP CONSTRAINT IF EXISTS playbooks_created_by_check;
ALTER TABLE playbooks ADD CONSTRAINT playbooks_created_by_check CHECK (created_by IN ('orchestrator','owner','migration'));
