-- 061_independent_resources.sql — independent resources (spec 024 T1).
--
-- • Network modes: 'orchestrated' → 'independent', 'mirror' → 'legacy_duplicate'
--   (default 'independent'). Only the mode values are rewritten.
-- • editor_slots: per-resource content treatment (unique / duplicate / adapt),
--   its reason, the source slot of a derived post and a non-slot source post.
-- • content_decisions: one decision per (idea or source, resource) with a reason.
-- • resource_tz(ref): a resource's IANA zone — a Telegram channel's card zone,
--   else the resource profile's `timezone`, else Europe/Kyiv (an invalid stored
--   zone falls back to Kyiv).
-- • The automatic-duplication gate is pinned per anchor plan day
--   (auto_duplicate_day / auto_duplicate) so a change takes effect the next day.
-- • editor_channels.crosspost defaults to false for new cards (existing rows keep theirs).
--
-- Additive and idempotent.

-- ── network modes ───────────────────────────────────────────────────────────
ALTER TABLE meta_account_groups DROP CONSTRAINT IF EXISTS meta_account_groups_mode_chk;
UPDATE meta_account_groups SET mode = 'independent'      WHERE mode = 'orchestrated';
UPDATE meta_account_groups SET mode = 'legacy_duplicate' WHERE mode = 'mirror';
ALTER TABLE meta_account_groups ADD CONSTRAINT meta_account_groups_mode_chk
  CHECK (mode IN ('independent','legacy_duplicate'));
ALTER TABLE meta_account_groups ALTER COLUMN mode SET DEFAULT 'independent';

-- The gate value of the anchor's current plan day (NULL until first evaluated).
ALTER TABLE meta_account_groups ADD COLUMN IF NOT EXISTS auto_duplicate_day DATE;
ALTER TABLE meta_account_groups ADD COLUMN IF NOT EXISTS auto_duplicate     BOOLEAN;

-- ── slot treatment ──────────────────────────────────────────────────────────
ALTER TABLE editor_slots ADD COLUMN IF NOT EXISTS treatment            TEXT;
ALTER TABLE editor_slots ADD COLUMN IF NOT EXISTS treatment_reason     TEXT;
ALTER TABLE editor_slots ADD COLUMN IF NOT EXISTS derived_from_slot_id UUID REFERENCES editor_slots(id) ON DELETE SET NULL;
ALTER TABLE editor_slots ADD COLUMN IF NOT EXISTS source_post          JSONB;
DO $$
BEGIN
  ALTER TABLE editor_slots ADD CONSTRAINT editor_slots_treatment_chk
    CHECK (treatment IS NULL OR treatment IN ('unique','duplicate','adapt'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS idx_editor_slots_derived ON editor_slots (derived_from_slot_id) WHERE derived_from_slot_id IS NOT NULL;

-- ── content decisions ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS content_decisions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  idea_id      UUID REFERENCES content_ideas(id) ON DELETE SET NULL,
  source_key   TEXT,
  resource_ref TEXT NOT NULL,
  decision     TEXT NOT NULL CHECK (decision IN ('unique','duplicate','adapt','skip')),
  reason       TEXT NOT NULL,
  reason_code  TEXT,
  slot_id      UUID REFERENCES editor_slots(id) ON DELETE SET NULL,
  decided_by   TEXT NOT NULL CHECK (decided_by IN ('planner','orchestrator','executor','owner','system')),
  run_id       UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_content_decisions_idea   ON content_decisions (idea_id, resource_ref)    WHERE idea_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_content_decisions_source ON content_decisions (source_key, resource_ref) WHERE idea_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_content_decisions_agent ON content_decisions (agent_id, created_at DESC);

-- ── resource time zone ──────────────────────────────────────────────────────
-- Same order as editor/time/resource-time.ts: a Telegram channel's card zone is
-- authoritative; other resources use their profile zone; then Europe/Kyiv.
CREATE OR REPLACE FUNCTION resource_tz(ref TEXT) RETURNS TEXT
  LANGUAGE plpgsql STABLE
  SET search_path = public, pg_temp
AS $$
DECLARE
  tz TEXT;
BEGIN
  IF ref LIKE 'telegram:%' THEN
    SELECT NULLIF(btrim(c.timezone), '') INTO tz FROM editor_channels c WHERE c.channel_key = substr(ref, 10);
  END IF;
  IF tz IS NULL THEN
    SELECT NULLIF(btrim(p.profile->>'timezone'), '') INTO tz FROM resource_profiles p WHERE p.resource_ref = ref;
  END IF;
  IF tz IS NULL THEN
    RETURN 'Europe/Kyiv';
  END IF;
  BEGIN
    PERFORM now() AT TIME ZONE tz;
  EXCEPTION WHEN invalid_parameter_value THEN
    RETURN 'Europe/Kyiv';
  END;
  RETURN tz;
END $$;

-- ── cross-posting is opt-in for new cards ───────────────────────────────────
ALTER TABLE editor_channels ALTER COLUMN crosspost SET DEFAULT false;

-- ── grants ──────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'editor_ro') THEN
    GRANT SELECT ON public.content_decisions TO editor_ro;
    GRANT EXECUTE ON FUNCTION public.resource_tz(TEXT) TO editor_ro;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'editor_ro grants skipped (insufficient privilege)';
END $$;

INSERT INTO schema_migrations (version) VALUES ('061_independent_resources')
  ON CONFLICT (version) DO NOTHING;
