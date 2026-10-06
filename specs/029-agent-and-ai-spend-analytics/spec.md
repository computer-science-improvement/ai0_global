# 029: Agent activity and AI spend analytics: tokens and money across every LLM call, on Overview and a Spend page

**Status:** SPEC · **Depends on:** 006, 017, 021 · **Migration:** `061_llm_usage.sql`
**Owner comments addressed:** #16 (plans/brd-comments-2026-10-06.md)

## Why
The owner wants the Overview to show how the agents are working and the **total tokens and money** spent on AI (#16).
Today the only number is "AI spend today", and it counts editor runs alone. Strategies, DM triage, the ROI analyzer,
recipe translation, topic-digest rewriting, semantic dedup and topic routing all call paid models (Anthropic, OpenAI,
Perplexity, Grok, the Claude Agent SDK). None of that is costed anywhere, so the owner sees a fraction of the real bill
and cannot tell which agent, resource or feature is expensive. This spec puts every LLM call into one costed ledger
shown on the Overview and on a new Spend page.

## Current state (as-is)
- **Overview** (`apps/dashboard/src/routes/app.index.tsx`, docs/brd/01 §3.4): 5 stat tiles (subscribers, Meta followers,
  active strategies, errors) plus `components/agents/NetworkHealth.tsx`. Its "AI spend today" meter is
  `SUM(cost_usd)` of `editor_runs` for the Kyiv day against `EDITOR_DAILY_BUDGET_USD` (BR-CORE-34, digest field
  `budget.spentTodayUsd` in `editor/manager/kpi-digest.service.ts`). No agent activity stats; no tokens; no 7/30-day view.
- **Editor ledger** (`database/migrations/042_editor.sql`): `editor_runs` (status, prompt/completion tokens, `cost_usd`)
  and `editor_run_steps` (per LLM step and per paid tool step, BR-EDT-26). Cost comes from OpenRouter `usage.cost`,
  with a fallback estimate from the hard-coded `PRICES` map in `editor/llm/model-registry.ts`
  (`editor/llm/openrouter.client.ts`). Cached tokens are not captured.
- **Budgets** (`editor/harness/budget.service.ts`): global, per-channel and per-agent daily caps checked before every
  editor LLM call, reading `editor_run_steps` (BR-EDT-18, BR-EDT-50, BR-AGT-25). Alerts are deduped in memory only.
- **Spend API:** `GET /api/editor/spend?days=` (`editor/api/editor-ops.service.ts`, `editor-runs.repository.ts#spendByDay`):
  editor-only, by day and `channel_key` (BR-EDT-06). The Agents page sums "Spend today" per root agent (BR-AGT-04).
- **Untracked LLM calls.** All of these go through `common/ai/agents/*` or the Agent SDK and write only `ai_logs`
  (`database/init.sql`: agent, model, status, prompt, output, duration, **no tokens, no cost**; `common/ai/ai-logger.service.ts`):
  - `ClaudeAgent` (`@anthropic-ai/sdk`): post generation (`common/ai/post-generation.agent.ts`, `POST_GEN_MODEL`);
    recipe translation (`strategies/recipes`, `RECIPE_TRANSLATE_MODEL`); topic-digest rewriting; review agent;
    summarizer and formatter; log analyzer; DM triage and chat classifier (`agent/agent-triage.service.ts`,
    BR-EDT-52); ROI analyzer `claude-haiku-4-5` (`tracking/processors/roi-analyzer.service.ts`, BR-INT-32, BR-CHN-32).
  - `OpenAiCompatibleAgent` subclasses `OpenAiAgent`, `PerplexityAgent` and `GrokAgent`, used by strategies.
  - Agent SDK `query()`: `common/dedup/semantic-dedup.service.ts` and `common/routing/topic-router.service.ts`,
    logged with `model: 'agent-sdk'`.
  - `ai_logs.agent` is the provider (`'claude'`), not the feature, so even the call count per feature is lost.

## Functional requirements
| ID | Requirement |
|----|-------------|
| FR-001 | **Migration `061_llm_usage.sql`.** <br>• `llm_usage(id bigserial pk, at timestamptz default now(), provider text check in (openrouter, anthropic, openai, perplexity, xai, agent_sdk, tool), model text, kind text check in (llm, tool) default 'llm', feature text not null, agent_id uuid null references agents on delete set null, root_agent_id uuid null, agent_handle text null, role text null, run_id uuid null references editor_runs on delete set null, step_idx int null, resource_ref text null, tokens_in int, tokens_out int, tokens_cached_read int, tokens_cached_write int, cost_usd numeric(12,6), cost_source text check in (provider, estimate, unpriced, backfill), latency_ms int, attempts smallint default 1, status text check in (ok, error, timeout), error_code text, shadow bool default false)`. <br>• Indexes on `(at)`, `(root_agent_id, at)`, `(feature, at)`, and a unique `(run_id, step_idx) where run_id is not null` for idempotent backfill. <br>• `llm_prices(provider, model, in_per_m, out_per_m, cached_read_per_m, cached_write_per_m, per_request_usd, effective_from date, pk(provider, model, effective_from))`, seeded with the models in use. <br>• `llm_usage_daily(day date, provider, model, feature, root_agent_id, role, resource_ref, calls, errors, tokens_in, tokens_out, tokens_cached, cost_usd, estimated_usd, unpriced_calls, shadow_usd)` with a unique index over the dimensions (`COALESCE` on nullables). <br>• `llm_budgets(id, scope_kind check in (global, feature_prefix, provider), scope_key, daily_usd, monthly_usd, alert_pct int default 80, enforce bool default true, updated_at)`. No prompt or output text is stored in any of these tables. |
| FR-002 | **One usage wrapper** (`common/ai/usage/llm-usage.service.ts`). `LlmUsageService.record(entry)` is the only writer of `llm_usage`. Attribution comes from an `AsyncLocalStorage` context: `withLlmContext({feature, agentId, runId, stepIdx, resourceRef, shadow}, fn)`. Explicit fields on a call override the context. With no context the feature is `unattributed`. Writes are batched (flush every 2 s or 50 rows) and best-effort: a failed write is logged and never fails the LLM call. |
| FR-003 | **Every provider client reports usage.** <br>• `OpenRouterClient`: tokens, `usage.cost` (source `provider`), `prompt_tokens_details.cached_tokens`. <br>• `ClaudeAgent`: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, priced from `llm_prices` (source `estimate`). <br>• `OpenAiCompatibleAgent`: `usage.prompt_tokens`, `completion_tokens`, `prompt_tokens_details.cached_tokens`, plus Perplexity's per-request fee. <br>• Agent SDK `query()`: the result message's `total_cost_usd` (source `provider`) and its `usage`. <br>• Paid editor tools (`_costUsd`, BR-EDT-26): `kind='tool'`, `provider='tool'`, `model=<tool name>`. <br>A failed or timed-out call writes a row with status `error`/`timeout`, the tokens if the provider returned them, otherwise null tokens and cost 0. One row per logical call; retries increment `attempts` instead of adding rows. |
| FR-004 | **Feature taxonomy** (code registry `common/ai/usage/features.ts`): `editor.<role>` (planner, executor, reviewer, checker, composer, orchestrator, idea_reviewer, manager, builder, chat); `strategy.<ext_id>.generate`; `strategy.recipes.translate`; `strategy.topic_digest.rewrite`; `review.post`; `dm.triage`; `dm.classify`; `tracking.roi`; `dedup.novelty`; `routing.topic`; `logs.analyze`; `text.summarize`; `text.format`; `tool.<name>`. `resource_ref` is `telegram:<channel_key>`, `meta:<id>`, `tiktok:<id>` or `strategy:<id>`. The strategy runner, `AgentLoop`, DM poller, ROI processor, dedup and router each open a context at their entry point. |
| FR-005 | **Price table.** `PriceService.price(provider, model, at)` picks the latest `effective_from ≤ at`. Model ids are normalised (strip date suffixes such as `-20251001`, and an alias map). An unknown model gives `cost_source='unpriced'`, `cost_usd=null`, and one admin alert per model per day. The `PRICES` map in `model-registry.ts` becomes a fallback read from `llm_prices`. Seed values come from the provider pricing pages on the implementation date; the owner edits rows on the Spend page (FR-010). Historical rows are **not** repriced automatically; an owner action "Reprice estimates for the last N days" re-costs `estimate` and `unpriced` rows only. |
| FR-006 | **Backfill and cutover.** The migration backfills `llm_usage` from `editor_run_steps` (LLM steps and steps with `cost_usd`), joined to `editor_runs` and `agents`, with `cost_source='backfill'`, `ON CONFLICT (run_id, step_idx) DO NOTHING`. After deploy the recorder writes both `editor_run_steps` (the trace) and `llm_usage`. `ai_logs` history has no tokens and is **not** backfilled; its rows are counted only as "calls before ledger" on the Spend page. |
| FR-007 | **Daily rollup** (`LlmUsageRollupJob`, every 5 min plus 00:10 Kyiv). It recomputes `llm_usage_daily` for today and yesterday (Kyiv days) with delete-and-insert in one transaction. Reports over more than 2 days read the rollup; today's numbers on the Overview read the rollup row for today (at most 5 min stale). **Retention:** raw `llm_usage` 90 days (`LLM_USAGE_RETENTION_DAYS`), rollup forever; a nightly prune deletes in 10k-row batches. |
| FR-008 | **Budgets reuse `BudgetService`.** <br>• Its spend query moves from `editor_run_steps` to `llm_usage` (same scopes; parity test on fixtures). <br>• New `checkFeature(feature, provider)` evaluates matching `llm_budgets` rows (`feature_prefix` matches by prefix, e.g. `strategy.`). It alerts at `alert_pct` and at 100 %, deduped through a persisted key (`app_settings`/Redis) so a restart does not re-alert. <br>• **Blocking by default (owner decision 2026-10-06).** `enforce` defaults to `true`. Over the cap the wrapper refuses the call (`BudgetExceededError`), and the caller's existing null-result path runs (agent runs end `budget_exceeded`, strategies skip the post, DM triage leaves the message unclassified). Each block sends one Telegram alert and an Inbox entry `budget_blocked` (scope, spent, cap, "raise cap" link); work resumes at Kyiv midnight or as soon as the owner raises the cap. <br>• **Caps, all blocking:** total `AI_DAILY_BUDGET_USD` (default $3, all LLM spend), agents `EDITOR_DAILY_BUDGET_USD` (default $2, `editor.*`), per resource `EDITOR_CHANNEL_DAILY_BUDGET_USD` (default $0.30) and the per-agent `daily_budget_usd`. The env values only seed the `llm_budgets` rows; after that the owner edits caps on the Budgets tab without a restart. <br>• An owner-initiated chat message over the cap is refused with a message that names the cap and links to the Budgets tab (no silent failure). <br>• The owner may set `enforce=false` on a row to make it alert-only. |
| FR-009 | **Overview cards** (`/app`, `GET /api/overview/agents` and `GET /api/spend/summary`, refetch 60 s). <br>• **Agents:** root agents by mode (off/shadow/live) and paused; runs today and 7d (`editor_runs`); success rate = ok / (finished − disabled) over 7d; posts published vs shadowed today and 7d (`editor_slots`, `platform_posts`); directives open / applied / worked over 30d (`agent_directives`). Each number links to its page. <br>• **AI spend:** USD and tokens (in/out/cached) for today, 7d and 30d with Δ against the previous period; budget bars for the editor cap, `AI_DAILY_BUDGET_USD` and the 3 most-used `llm_budgets`, coloured as in BR-CORE-34; top 5 agents and top 5 features by 7d cost; a "% estimated" note when estimated or unpriced rows are over 10 %. <br>• The "AI spend today" meter in `NetworkHealth` is replaced by a link to the card. |
| FR-010 | **Spend page `/app/spend`** (sidebar: Analytics → Spend). <br>• Range: today, 7d, 30d, month to date, custom ≤ 366 days. <br>• A stacked daily bar chart coloured by provider or feature. <br>• Group-by tabs: day, agent (rolled up to root, expandable to role), role, resource, provider, model, feature. Each row shows calls, errors, tokens in/out/cached, USD, % of total, avg latency and an estimated/unpriced flag. <br>• Filters: agent, feature prefix, provider, shadow only. Rows with a `run_id` link to `/app/editor/run/$id`. <br>• **CSV export** `GET /api/spend/export.csv?from&to&groupBy` with the same columns (raw rows for ranges within retention). <br>• Price table and budgets tabs: edit `llm_prices` and `llm_budgets` (zod-validated, confirm dialog). |
| FR-011 | **API.** `GET /api/spend/summary?range=`, `GET /api/spend/breakdown?from&to&groupBy&filters`, `GET /api/spend/export.csv`, `GET/PUT /api/spend/prices`, `GET/PUT/DELETE /api/spend/budgets`, `GET /api/overview/agents`, all behind `TrackingAuthGuard`. `GET /api/editor/spend` keeps its response shape for the MCP tool, sourced from `llm_usage` with `feature LIKE 'editor.%'`. The KPI digest `budget` block reads the same source. |

## Corner cases
- **Provider omits usage** (Agent SDK error before the result message, network timeout) → a row with null tokens and cost
  0, status `timeout`/`error`; the Spend page shows "N calls without usage".
- **OpenRouter bills a timed-out request** that we never saw → not capturable; the monthly OpenRouter invoice can
  differ. A non-goal for reconciliation, noted on the page.
- **Unknown or renamed model** → `unpriced`, an alert, and the row is still counted in calls and tokens.
- **Price change mid-month** → a new `effective_from` row; old rows keep their cost unless the owner reprices.
- **Ledger write fails** (DB down) → the batch is retried once, then dropped with an error log; LLM work continues.
  Budget checks then under-count, which the existing `editor_run_steps` trace makes auditable.
- **Agent deleted or re-parented** → `agent_id` is set null; `agent_handle` and `root_agent_id` are snapshots, so
  history still groups correctly.
- **Shadow runs** cost real money → counted in totals, and shown separately as "shadow spend".
- **Concurrent calls near a cap** → the budget check is not transactional (as today); an overshoot of up to one call
  per worker is accepted.
- **Day boundary** → all days are Europe/Kyiv; the rollup job recomputes yesterday so late rows land correctly.

## Non-goals
- Reconciling against provider invoices or billing APIs.
- Currency other than USD (no UAH conversion).
- Storing prompts or outputs in the ledger (`ai_logs` keeps doing that; its retention is out of scope).
- Costing non-LLM paid APIs beyond editor tools that already report `_costUsd`.
- Per-tenant or white-label billing (#9 is a separate spec).

## Success criteria
- **Coverage:** after a 48 h soak, `unattributed` is ≤ 2 % of USD and of calls, and every provider client has a
  unit test asserting one ledger row per call (success, error, timeout).
- **Parity:** for editor features, `llm_usage` USD per day equals `editor_runs.cost_usd` within $0.0001 on fixtures
  and on the backfilled history. `BudgetService` verdicts are unchanged on the existing test suite.
- **Accuracy:** for Anthropic and OpenAI the estimate matches a hand-calculated fixture (with cache-read and
  cache-write tokens) exactly.
- **Performance:** `/api/spend/summary` p95 < 150 ms and a 30-day breakdown p95 < 300 ms with 1M raw rows (PG test
  seed). Ledger writes add < 2 ms p95 to a call.
- **UI:** the Overview shows both cards with empty states (no agents; ledger empty) and no layout shift on mobile
  (≤ 600 px); the Spend page CSV opens in Sheets with correct totals.
- **Alerts:** a feature budget at 80 % and at 100 % fires exactly once per day each, also across a restart.

## Open questions for the owner
1. ~~Should the global editor cap include non-editor spend?~~ **Decided 2026-10-06:** a total cap `AI_DAILY_BUDGET_USD`
   covers all spend, and it blocks (FR-008).
2. ~~Should feature budgets block calls?~~ **Decided 2026-10-06:** yes, every cap blocks by default; alert-only is an
   explicit per-row opt-out.
3. **Raw retention.** Default 90 days raw, rollup forever.
4. **Should DM triage and ROI count against an agent?** Default: no agent (system features). They appear under
   features and resources only.
5. **Show UAH next to USD?** Default: no (non-goal); it can be added with a fixed rate in settings.
6. **Who sees the Spend page?** Default: everyone logged in (single-owner deployment), the same as Agents.

## Cost estimate (measured, 2026-10)
Source: 110 eval runs on the default model `z-ai/glm-5.3-flash` ($0.15 in / $0.50 out per 1M tokens; the idea reviewer
uses `z-ai/glm-5.3`, $0.22 / $3.39), `apps/automation/evals/results/*.json`.

| Run | Average | Max | Typical tokens (in/out) |
|---|---|---|---|
| planner | $0.0022 | $0.0042 | 25k / 2k |
| orchestrator | $0.0015 | $0.0018 | 14k / 1k |
| executor (writes a post) | $0.0031 | $0.0087 | 47k / 1.4k |
| reviewer | $0.0029 | $0.0053 | 35k / 1.7k |
| idea reviewer | $0.0079 | $0.0115 | 17k / 0.8k |
| manager | $0.0010 | $0.0013 | 14k / 0.6k |
| composer (one chat reply) | $0.0020 | $0.0034 | 35k / 0.4k |

**One resource, per day:**
- 1 post, no chat: about $0.02.
- 2 posts plus about 10 chat replies (approval period): about $0.05.
- Worst case (2 posts, every post rewritten once, max-cost runs, 20 chat replies): about $0.15.

Per month that is about $0.60–1.50 per resource, at most about $4.50. Ten resources cost about $0.25–0.50 per day.
No paid image generation runs in the agent path. Legacy strategies (Claude through the Agent SDK) are not in these numbers;
FR-002 starts measuring them. A stronger model multiplies the cost: Claude Sonnet ($3 / $15 per 1M) makes an executor run
about $0.16, so one resource would cost about $0.50–1.00 per day.

## Task breakdown

### T1: Add the ledger schema, the price table and the backfill
**Scope:** `061_llm_usage.sql` (FR-001, FR-006), seed `llm_prices`, `PriceService` with normalisation and aliases
(FR-005), and the repositories.
**Acceptance:** the migration is idempotent on a scratch PG with production-shaped data; the backfill row count
equals the LLM and costed tool steps; the parity query passes; `PriceService` unit tests cover effective dates,
date-suffixed ids and unknown models.
**Size:** M
**Depends on:** —

### T2: Build the usage wrapper and attribution context
**Scope:** `LlmUsageService` (batched, best-effort writes), `withLlmContext` (AsyncLocalStorage), the feature
registry (FR-002, FR-004), and the unpriced-model alert.
**Acceptance:** unit tests for context nesting and override, the `unattributed` fallback, batch flush on size and
time, a write failure not throwing, and context surviving `await` chains and BullMQ processors.
**Size:** M
**Depends on:** T1

### T3: Instrument every provider client and entry point
**Scope:** `OpenRouterClient` and `PgRunRecorder` (editor features, run and step ids, shadow flag); `ClaudeAgent`;
`OpenAiCompatibleAgent` (OpenAI, Perplexity, Grok); Agent SDK callers (dedup, router); paid tool steps. Open contexts
in the strategy runner, `AgentLoop`, the DM poller and triage, the ROI processor, recipe translation, topic digest,
the summarizer, formatter and log analyzer (FR-003, FR-004).
**Acceptance:** one row per call for each client (success, error, timeout) in unit tests; a 48 h staging soak meets
the coverage criterion; `ai_logs` behaviour is unchanged.
**Size:** L
**Depends on:** T2

### T4: Add the rollup, retention and feature budgets
**Scope:** `LlmUsageRollupJob` and the prune (FR-007); `BudgetService` reading `llm_usage`, `checkFeature`,
blocking `AI_DAILY_BUDGET_USD` and caps seeded into `llm_budgets` (editable without restart), the `budget_blocked`
Inbox entry, and persisted alert dedupe (FR-008); the digest `budget` block and `GET /api/editor/spend`
switched to the ledger.
**Acceptance:** the existing budget tests stay green, plus new parity tests; the rollup equals a raw aggregate on
fixtures; alerts fire once per threshold per day across a restart; enforcement returns the caller's null path.
**Size:** M
**Depends on:** T3

### T5: Build the spend and agent-stats API
**Scope:** `SpendController` and `OverviewController` endpoints (FR-011), CSV streaming, and price and budget CRUD
with zod.
**Acceptance:** controller tests for every endpoint and validation error; the performance criterion holds on a
1M-row PG seed; CSV totals equal the breakdown totals.
**Size:** M
**Depends on:** T4

### T6: Add the Agents and AI spend cards to the Overview
**Scope:** the two cards in `app.index.tsx` (FR-009), removing the meter from `NetworkHealth`, empty states, and
the mobile layout.
**Acceptance:** component tests for loading, empty, error and over-budget colours; links resolve; `tsc` passes
without `as any` link casts.
**Size:** S
**Depends on:** T5

### T7: Build the `/app/spend` page and add it to the sidebar
**Scope:** range picker, daily stacked chart, group-by tabs, filters, run drill-down, CSV button, and the Prices and
Budgets tabs (FR-010); a sidebar entry under Analytics.
**Acceptance:** a browser check in the dev preview at desktop and 375 px; editing a price with "reprice estimates"
changes the totals only for estimated rows; the export downloads with the selected range.
**Size:** L
**Depends on:** T5
