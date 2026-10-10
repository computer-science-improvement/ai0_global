-- 071_manager_quality.sql — MANAGER content-quality audit (spec 034 FR-006, T4).
--
-- • agent_directives.kind gains 'voice_fix' (playbook voice rules / example posts from real rejected posts)
--   and 'format_mix' (lower poll/quiz weights or caps, drop an unfitting format). The CHECK is replaced only
--   when it does not allow both yet, so a re-run never narrows a list a later migration widened.
-- • manager_reviews.quality_check: the per-resource content-quality checklist the MANAGER submits with every
--   review (submit_review refuses a review without it).
--
-- Additive, guarded and idempotent: CI re-applies this file.

DO $$
DECLARE
  r   RECORD;
  ok  BOOLEAN := false;
BEGIN
  IF to_regclass('public.agent_directives') IS NULL THEN
    RETURN;
  END IF;
  -- Any single-column CHECK on kind that already allows both new kinds (named or the 053 inline one) is kept.
  FOR r IN
    SELECT c.conname, pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.conrelid = 'public.agent_directives'::regclass AND c.contype = 'c'
       AND array_length(c.conkey, 1) = 1 AND a.attname = 'kind'
  LOOP
    IF r.def LIKE '%''voice_fix''%' AND r.def LIKE '%''format_mix''%' THEN
      ok := true;
    ELSE
      EXECUTE format('ALTER TABLE agent_directives DROP CONSTRAINT %I', r.conname);
    END IF;
  END LOOP;
  IF NOT ok THEN
    ALTER TABLE agent_directives ADD CONSTRAINT agent_directives_kind_check CHECK (kind IN (
      'advice','task','format_shift','frequency','repost','cross_promo','pause_series','experiment','pause_resource','strategy',
      'voice_fix','format_mix'));
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.manager_reviews') IS NOT NULL THEN
    ALTER TABLE manager_reviews ADD COLUMN IF NOT EXISTS quality_check JSONB;
  END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES ('071_manager_quality')
  ON CONFLICT (version) DO NOTHING;
