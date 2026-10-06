-- 056_llm_usage.sql — one costed ledger of every LLM call (spec 029).
--
--   llm_usage          one row per logical LLM call (or paid editor tool step); no prompt/output text
--   llm_prices         USD per 1M tokens per (provider, model, effective_from); estimates read it
--   llm_usage_daily    Kyiv-day rollup (LlmUsageRollupJob recomputes today + yesterday)
--   llm_budgets        daily caps (blocking unless enforce = false); rows are seeded at boot from env
--   llm_budget_alerts  persisted alert dedupe keys (once per scope/threshold per Kyiv day, across restarts)
--
-- Backfills llm_usage from editor_run_steps (LLM steps and costed tool steps) with cost_source 'backfill'.
-- Additive and idempotent.

CREATE TABLE IF NOT EXISTS llm_usage (
  id                  BIGSERIAL PRIMARY KEY,
  at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider            TEXT NOT NULL CHECK (provider IN ('openrouter','anthropic','openai','perplexity','xai','agent_sdk','tool')),
  model               TEXT NOT NULL,
  kind                TEXT NOT NULL DEFAULT 'llm' CHECK (kind IN ('llm','tool')),
  feature             TEXT NOT NULL,
  agent_id            UUID REFERENCES agents(id) ON DELETE SET NULL,
  -- Snapshots: history keeps grouping after an agent is deleted or re-parented.
  root_agent_id       UUID,
  agent_handle        TEXT,
  role                TEXT,
  run_id              UUID REFERENCES editor_runs(id) ON DELETE SET NULL,
  step_idx            INT,
  resource_ref        TEXT,
  -- tokens_in is ALL prompt tokens, cached ones included; tokens_cached_* are subsets of it.
  tokens_in           INT,
  tokens_out          INT,
  tokens_cached_read  INT,
  tokens_cached_write INT,
  cost_usd            NUMERIC(12,6),
  cost_source         TEXT NOT NULL CHECK (cost_source IN ('provider','estimate','unpriced','backfill')),
  latency_ms          INT,
  attempts            SMALLINT NOT NULL DEFAULT 1,
  status              TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','error','timeout')),
  error_code          TEXT,
  shadow              BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_llm_usage_at         ON llm_usage (at);
CREATE INDEX IF NOT EXISTS idx_llm_usage_root_agent ON llm_usage (root_agent_id, at);
CREATE INDEX IF NOT EXISTS idx_llm_usage_feature    ON llm_usage (feature, at);
-- Idempotent backfill and dual-write from the editor recorder.
CREATE UNIQUE INDEX IF NOT EXISTS uq_llm_usage_run_step ON llm_usage (run_id, step_idx) WHERE run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS llm_prices (
  provider           TEXT NOT NULL,
  model              TEXT NOT NULL,
  in_per_m           NUMERIC(10,4) NOT NULL CHECK (in_per_m >= 0),
  out_per_m          NUMERIC(10,4) NOT NULL CHECK (out_per_m >= 0),
  cached_read_per_m  NUMERIC(10,4) CHECK (cached_read_per_m >= 0),
  cached_write_per_m NUMERIC(10,4) CHECK (cached_write_per_m >= 0),
  per_request_usd    NUMERIC(10,6) CHECK (per_request_usd >= 0),
  effective_from     DATE NOT NULL DEFAULT '2026-01-01',
  note               TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, model, effective_from)
);

-- Seed prices (USD per 1M tokens) for the models found in code on 2026-10-06.
-- OWNER: VERIFY these against the provider pricing pages and edit the rows (Spend page → Prices);
-- they were not fetched from the providers. Anthropic cache: read 0.1×, write 1.25× of input.
-- Perplexity sonar-pro and xAI grok-3 are best-known list prices — verify them first.
INSERT INTO llm_prices (provider, model, in_per_m, out_per_m, cached_read_per_m, cached_write_per_m, per_request_usd, note) VALUES
  ('openrouter', 'z-ai/glm-5.3-flash',  0.15, 0.50, NULL, NULL, NULL, 'seed 2026-10-06; verify'),
  ('openrouter', 'z-ai/glm-5.3-flashx', 0.37, 1.25, NULL, NULL, NULL, 'seed 2026-10-06; verify'),
  ('openrouter', 'z-ai/glm-5.3',        0.22, 3.39, NULL, NULL, NULL, 'seed 2026-10-06; verify'),
  ('anthropic',  'claude-haiku-4-5',    1.00, 5.00,  0.10, 1.25, NULL, 'seed 2026-10-06; verify'),
  ('anthropic',  'claude-sonnet-4-5',   3.00, 15.00, 0.30, 3.75, NULL, 'seed 2026-10-06; verify'),
  ('anthropic',  'claude-sonnet-4-6',   3.00, 15.00, 0.30, 3.75, NULL, 'seed 2026-10-06; verify'),
  ('openai',     'gpt-4o',              2.50, 10.00, 1.25, NULL, NULL, 'seed 2026-10-06; verify'),
  ('perplexity', 'sonar-pro',           3.00, 15.00, NULL, NULL, 0.006, 'seed 2026-10-06; per-request fee depends on search context size; verify'),
  ('xai',        'grok-3',              3.00, 15.00, NULL, NULL, NULL, 'seed 2026-10-06; verify')
ON CONFLICT (provider, model, effective_from) DO NOTHING;

CREATE TABLE IF NOT EXISTS llm_usage_daily (
  day           DATE NOT NULL,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  feature       TEXT NOT NULL,
  root_agent_id UUID,
  role          TEXT,
  resource_ref  TEXT,
  calls         INT NOT NULL DEFAULT 0,
  errors        INT NOT NULL DEFAULT 0,
  tokens_in     BIGINT NOT NULL DEFAULT 0,
  tokens_out    BIGINT NOT NULL DEFAULT 0,
  tokens_cached BIGINT NOT NULL DEFAULT 0,
  cost_usd      NUMERIC(14,6) NOT NULL DEFAULT 0,
  estimated_usd NUMERIC(14,6) NOT NULL DEFAULT 0,
  unpriced_calls INT NOT NULL DEFAULT 0,
  shadow_usd    NUMERIC(14,6) NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_llm_usage_daily ON llm_usage_daily (
  day, provider, model, feature,
  COALESCE(root_agent_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(role, ''), COALESCE(resource_ref, '')
);

-- scope_kind: global (scope_key '' = all LLM spend), feature_prefix ('editor.', 'strategy.' …),
-- provider ('anthropic' …) and resource ('*' = the default cap of every resource, or one resource_ref).
CREATE TABLE IF NOT EXISTS llm_budgets (
  id           BIGSERIAL PRIMARY KEY,
  scope_kind   TEXT NOT NULL CHECK (scope_kind IN ('global','feature_prefix','provider','resource')),
  scope_key    TEXT NOT NULL DEFAULT '',
  daily_usd    NUMERIC(10,4) CHECK (daily_usd >= 0),
  monthly_usd  NUMERIC(10,4) CHECK (monthly_usd >= 0),
  alert_pct    INT NOT NULL DEFAULT 80 CHECK (alert_pct BETWEEN 1 AND 100),
  enforce      BOOLEAN NOT NULL DEFAULT true,
  seeded_from  TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_llm_budgets_scope ON llm_budgets (scope_kind, scope_key);

CREATE TABLE IF NOT EXISTS llm_budget_alerts (
  key        TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Backfill from the editor trace ──────────────────────────────────────────
INSERT INTO llm_usage (at, provider, model, kind, feature, agent_id, root_agent_id, agent_handle, role,
                       run_id, step_idx, resource_ref, tokens_in, tokens_out, cost_usd, cost_source,
                       latency_ms, status, shadow)
SELECT s.created_at,
       CASE WHEN s.type = 'llm' THEN 'openrouter' ELSE 'tool' END,
       CASE WHEN s.type = 'llm' THEN r.model ELSE COALESCE(s.tool_name, 'unknown') END,
       s.type,
       'editor.' || r.role,
       a.id, COALESCE(a.parent_id, a.id), a.handle, r.role,
       r.id, s.idx,
       CASE WHEN r.channel_key IS NOT NULL THEN 'telegram:' || r.channel_key END,
       s.prompt_tokens, s.completion_tokens, COALESCE(s.cost_usd, 0), 'backfill',
       s.duration_ms,
       CASE WHEN s.is_error THEN 'error' ELSE 'ok' END,
       COALESCE(sl.status = 'shadowed', false)
  FROM editor_run_steps s
  JOIN editor_runs r      ON r.id = s.run_id
  LEFT JOIN agents a      ON a.id = r.agent_id
  LEFT JOIN editor_slots sl ON sl.id = r.slot_id
 WHERE s.type = 'llm' OR s.cost_usd IS NOT NULL
ON CONFLICT DO NOTHING;

-- One-time rollup of the backfilled history (the job keeps today and yesterday current afterwards).
INSERT INTO llm_usage_daily (day, provider, model, feature, root_agent_id, role, resource_ref, calls, errors,
                             tokens_in, tokens_out, tokens_cached, cost_usd, estimated_usd, unpriced_calls, shadow_usd)
SELECT (at AT TIME ZONE 'Europe/Kyiv')::date, provider, model, feature, root_agent_id, role, resource_ref,
       COUNT(*), COUNT(*) FILTER (WHERE status <> 'ok'),
       COALESCE(SUM(tokens_in), 0), COALESCE(SUM(tokens_out), 0), COALESCE(SUM(tokens_cached_read), 0),
       COALESCE(SUM(cost_usd), 0),
       COALESCE(SUM(cost_usd) FILTER (WHERE cost_source = 'estimate'), 0),
       COUNT(*) FILTER (WHERE cost_source = 'unpriced'),
       COALESCE(SUM(cost_usd) FILTER (WHERE shadow), 0)
  FROM llm_usage
 GROUP BY 1, 2, 3, 4, 5, 6, 7
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations (version) VALUES ('056_llm_usage')
  ON CONFLICT (version) DO NOTHING;
