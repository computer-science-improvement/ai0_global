-- 068_critic.sql — the pre-publish critic (spec 034 FR-004, T2).
--
-- • editor_slots.critic: the critic's verdict of the post written for the slot —
--   {verdict: pass|revise|reject|error, scores{ai_likeness, sense, voice, grounding,
--   audience_asks, format_fit}, notes, model_verdict, reason, pass, slop_warnings,
--   model, run_id, cost_usd, at, final?, history?}. Shown on the approval card and
--   in the run trace; MANAGER (T4) and the plan view (T7) read it.
-- • editor_drafts.critic: the same, advisory, for a chat draft (on demand).
-- • A partial index for the verdict stats per channel and day (T4).
--
-- The critic model is an app_settings row (`ai.critic_model`), no schema.
-- Additive, guarded and idempotent: CI re-applies this file.

DO $$
BEGIN
  IF to_regclass('public.editor_slots') IS NOT NULL THEN
    ALTER TABLE editor_slots ADD COLUMN IF NOT EXISTS critic JSONB;
    CREATE INDEX IF NOT EXISTS idx_editor_slots_critic
      ON editor_slots (channel_key, ((critic->>'verdict')), updated_at DESC)
      WHERE critic IS NOT NULL;
  END IF;
  IF to_regclass('public.editor_drafts') IS NOT NULL THEN
    ALTER TABLE editor_drafts ADD COLUMN IF NOT EXISTS critic JSONB;
  END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES ('068_critic')
  ON CONFLICT (version) DO NOTHING;
