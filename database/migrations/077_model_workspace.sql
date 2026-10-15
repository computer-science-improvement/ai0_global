-- 077_model_workspace.sql — the model workspace (spec 038, T1): agents run on OpenRouter (default) or on Anthropic directly.
--
-- • agents.anthropic_model: the agent's own model in the Anthropic workspace (agents.model stays the OpenRouter one),
--   so switching the workspace back and forth keeps both choices. NULL = follow the workspace default.
-- • llm_prices rows for the Anthropic models (USD per 1M; Anthropic pricing page 2026-10-15). Cache read is 0.05× input on
--   Opus 5.5 / Sonnet 5.5 and 0.1× elsewhere; a 5-minute cache write is 1.25× input. Haiku 5.5 is priced for prompts up to
--   100K tokens (the editor's prompts stay below that).
-- • The workspace itself is the app_settings row `ai.workspace` (absent = openrouter); the Anthropic defaults are
--   `ai.anthropic.default_model` / `ai.anthropic.critic_model`. No rows are written here.
--
-- Additive, guarded and idempotent: CI re-applies this file.

DO $$
BEGIN
  IF to_regclass('public.agents') IS NOT NULL THEN
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS anthropic_model TEXT;
  END IF;
  IF to_regclass('public.llm_prices') IS NOT NULL THEN
    INSERT INTO llm_prices (provider, model, in_per_m, out_per_m, cached_read_per_m, cached_write_per_m, per_request_usd, effective_from, note) VALUES
      ('anthropic', 'claude-opus-5-5',   4.00, 20.00, 0.20, 5.00,  NULL, '2026-10-15', 'Anthropic pricing 2026-10-15 (spec 038)'),
      ('anthropic', 'claude-sonnet-5-5', 2.00, 10.00, 0.10, 2.50,  NULL, '2026-10-15', 'Anthropic pricing 2026-10-15 (spec 038)'),
      ('anthropic', 'claude-haiku-5-5',  0.10, 0.50,  0.01, 0.125, NULL, '2026-10-15', 'Anthropic pricing 2026-10-15, prompts ≤ 100K (spec 038)'),
      ('anthropic', 'claude-opus-5',     5.00, 25.00, 0.50, 6.25,  NULL, '2026-10-15', 'Anthropic pricing 2026-10-15 (spec 038)'),
      ('anthropic', 'claude-sonnet-5',   2.00, 10.00, 0.20, 2.50,  NULL, '2026-10-15', 'Anthropic pricing 2026-10-15 (spec 038)'),
      ('anthropic', 'claude-haiku-4-5',  1.00, 5.00,  0.10, 1.25,  NULL, '2026-10-15', 'Anthropic pricing 2026-10-15 (spec 038)')
    ON CONFLICT (provider, model, effective_from) DO NOTHING;
  END IF;
END $$;

INSERT INTO schema_migrations (version) VALUES ('077_model_workspace')
  ON CONFLICT (version) DO NOTHING;
