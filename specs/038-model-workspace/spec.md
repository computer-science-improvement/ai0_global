# 038: Model workspace — OpenRouter or Anthropic

**Status:** DONE (built 2026-10-15) · **Priority:** P1 · **Linear:** AI0-113 (T1–T6: AI0-114…119) · **Depends on:** 035 (model picker),
029 (llm_usage, llm_prices, budgets) · **Migration:** `077_model_workspace.sql`

**Owner request (2026-10-15):** keep switching models through OpenRouter as now, and add Anthropic directly — a separate setting one
level above the models on the Models page, named **Workspace** (OpenRouter / Anthropic). In the chosen workspace the owner picks the
models of the agents as now. Reason: a Claude Max 5x plan gives $100 of API credits every month (Max 20x: $200); they expire at the
end of each billing cycle and apply only to the Claude API with a key of the Console organization linked to the plan.

## Built (FRs)
- **FR-001 Workspace.** `app_settings` `ai.workspace` = `anthropic`, absent = `openrouter` (`WorkspaceStore`, in-process cache like
  `ModelDefaultsStore`; `ai.*` keys are never env overrides). Switching to Anthropic needs a key on the server
  (`EDITOR_ANTHROPIC_API_KEY`, else `ANTHROPIC_API_KEY`) → else 400 `anthropic_key_missing`.
- **FR-002 Choices per workspace.** Each workspace keeps its own choices, so switching back and forth loses nothing:
  default `ai.default_model` | `ai.anthropic.default_model`; critic `ai.critic_model` | `ai.anthropic.critic_model`
  (`WorkspaceModelStore`); agent `agents.model` | `agents.anthropic_model` (`agentModelIn`). Reasoning effort is shared.
- **FR-003 Precedence on Anthropic.** The agent's own Anthropic model (role agents inherit their orchestrator's) → env
  `EDITOR_ANTHROPIC_MODEL_<ROLE>` → `ai.anthropic.default_model` → built-in `claude-sonnet-5-5`. The channel cards' legacy `models`
  are OpenRouter ids and are skipped. OpenRouter precedence is unchanged (spec 035).
- **FR-004 Bound to the run.** `resolveModel` returns `ModelProfile.workspace`; the AgentLoop sends `LlmRequest.provider` and checks
  provider-scoped budget caps for it; `RoutingLlmClient` sends the request to `OpenRouterClient` or `AnthropicClient`. A switch in the
  middle of a run never mixes providers. Every runner reads the workspace and its default once per run (`readModelContext`): roles,
  network runner, MANAGER, critic, editor chat (composer, @ai0 / @manager).
- **FR-005 AnthropicClient** (`editor/llm/anthropic.client.ts`, Messages API over axios, `anthropic-version: 2023-06-01`):
  leading system messages → top-level `system`, later ones → a user text note; tools → `input_schema`; tool results (and the user text
  after them) merge into one user turn; the assistant's raw content blocks (`providerContent`: thinking with its signature, text,
  tool_use) go back verbatim; `output_config.effort` from the role / agent effort on the models that take it; no temperature
  (thinking is on by default on the 5.x models); `max_tokens` ≥ 16 000 (thinking counts toward it); prompt-cache breakpoints on the
  system prompt, the last tool and the newest block; retries on 429 / 5xx / 529 / network, other 4xx (an exhausted credit balance)
  throw at once with the API message; `stop_reason` → finish reason (`max_tokens` → `length`). Cost: `llm_prices` (`anthropic`) with
  cache read / write rates, else the static `ANTHROPIC_PRICES`; one `llm_usage` row per call, provider `anthropic`.
- **FR-006 Catalog.** Anthropic workspace: the static price list (Opus 5.5, Sonnet 5.5, Haiku 5.5, Opus 5, Sonnet 5, Haiku 4.5) merged
  with the live `GET /v1/models` list when a key is set (24 h cache, Claude 2 / 3 left out, unknown prices null). Without a key, the
  price list only and no network call.
- **FR-007 API.** `GET /api/models/workspace` → `{active, anthropicKey (bool only), switchable, workspaces: [{id, defaultModel,
  agentsWithOwnModel}]}`; `PUT /api/models/workspace {workspace}`. `GET /api/models`, `overview`, `PUT default`, `PUT critic`,
  `POST bulk` and `PATCH /api/agents/:handle {model}` act on the active workspace (its store / column, its catalog for validation, its
  provider for prices). `overview.channelOverrides` is empty on Anthropic.
- **FR-008 Page.** `/app/models`: a **Workspace** card on top — segmented OpenRouter / Anthropic, key badge, what the workspace means
  (credits expire monthly; runs fail when they run out), each workspace's default and own-model count, a confirm naming the models
  agents move to; setup steps when there is no key. Below it everything edits the active workspace. The agent profile's model field
  edits the active workspace's model.
- **FR-009 Migration 077.** `agents.anthropic_model`; `llm_prices` rows for the Anthropic models (2026-10-15 list prices, cache read
  0.05× input on Opus / Sonnet 5.5, 0.1× elsewhere, 5-min cache write 1.25×).

## Decisions
- The plan's credits are not visible through the API: the spend page shows the list-price cost of Anthropic runs (provider
  `anthropic`); the blocking budgets (spec 029) still apply — raise the agents' cap to fit ~$3.3/day if the credits are the budget.
- No automatic fallback to OpenRouter when the credits run out (not requested): runs fail with the API message until the next grant.
- The legacy Agent SDK features (`common/ai`) are out of scope; they keep `ANTHROPIC_API_KEY`.

## Verification
Unit: `anthropic.client.test.ts` (request shape, tool loop with thinking, cost, retries, routing), `models.workspace.test.ts`
(registry, helpers, catalog, service, agent PATCH), agent-loop provider test, dashboard `models.test.ts`. PG:
`models-workspace.pg.test.ts` (migration twice, prices, workspace, per-workspace defaults, bulk on the Anthropic column only). UI:
temporary vite harness at 375 px and desktop. No paid call, no real data.
