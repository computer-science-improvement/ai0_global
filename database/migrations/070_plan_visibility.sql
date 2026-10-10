-- 070_plan_visibility.sql — the readable plan (spec 034 FR-012, T7).
--
-- • editor_slots.preview_draft: the owner's on-demand dry-run preview of a fixed
--   planned slot — {status: running|ready|rejected|skipped|failed, platform,
--   preview, spec, critic, reason, warnings, runId, costUsd, startedAt,
--   finishedAt}. A dry run never publishes, never creates an approval card and
--   never enters the content ledger, so it is kept apart from rendered_preview /
--   post_spec / critic (those hold what the real run wrote; the similarity and
--   repeat guards, MANAGER's critic stats and derived slots read them).
--
-- Additive, guarded and idempotent: CI re-applies this file.

DO $$
BEGIN
  IF to_regclass('public.editor_slots') IS NOT NULL THEN
    ALTER TABLE editor_slots ADD COLUMN IF NOT EXISTS preview_draft JSONB;
  END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES ('070_plan_visibility')
  ON CONFLICT (version) DO NOTHING;
