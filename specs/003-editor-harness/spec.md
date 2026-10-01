# 003: Editor harness core

**Status:** In progress · **Branch:** feat/editor-agent

## Why
Today, 18 hard-coded strategies pull from pre-generated content pools on fixed crons. Nothing decides
anything, and the stats that get collected are never used. The owner wants each channel run by an
**agent** that reads the database (read-only), its own publication history and its stats, and then decides what to
publish. Content is generated or fetched at decision time. This feature builds the reusable **harness**: the
LLM client, the tool-calling loop, the tool registry, budget enforcement and a full trace. Specs 004 and 005
build on it.

## User stories
- **US1 (owner):** I want a cheap model (GLM 5.3 Flash via OpenRouter) to drive agents, with the model
  configurable per role, so that I control cost and quality.
- **US2 (owner):** I want every agent run recorded step by step (LLM turns, tool calls, tokens, $), so that I
  can audit why the agent posted something and replay it.
- **US3 (owner):** I want hard daily budgets, per channel and global, so that a runaway loop cannot burn money.
- **US4 (agent):** I want typed tools with clear schemas and errors returned as data, so that I can recover
  from bad calls instead of crashing.
- **US5 (agent):** I want read-only access to the database, so that I can answer questions the typed tools
  don't cover. I must never be able to read secrets or write.

## Functional requirements
| ID | Requirement |
|----|-------------|
| FR-001 | `OpenRouterClient.chat(req)` POSTs to `${OPENROUTER_BASE_URL:-https://openrouter.ai/api/v1}/chat/completions` with `model`, `messages`, `tools`, `tool_choice`, `response_format`, `max_tokens` and `temperature`. It returns `{message, toolCalls[], finishReason, usage{promptTokens, completionTokens, costUsd}}`. Cost comes from `usage.cost`; if that is absent, it is computed from the model registry price. Timeout is 60 s. It retries twice (backoff 1 s/3 s) on 429/5xx/network errors and does not retry on 4xx. |
| FR-002 | The model registry maps each role (`planner`, `executor`, `reviewer`, `checker`) to `{model, inPerM, outPerM, maxTokens, temperature}`. The default model is `z-ai/glm-5.3-flash` ($0.15/$0.50 per 1M tokens). Precedence: env `EDITOR_MODEL_<ROLE>`, then the per-channel override (from 005), then the default. |
| FR-003 | A tool is `{name, description, input: zod schema, kind: 'read'\|'act'\|'terminal', roles[], execute(input, ctx)}`. Its JSON Schema for the LLM is derived with `z.toJSONSchema`. |
| FR-004 | The tool registry lists the tools allowed for `(role, channel allowlist)`. Unknown or disallowed tool calls return `{error:'tool_not_allowed'}` to the model; they never throw. |
| FR-005 | `AgentLoop.run({role, channelKey, slotId?, system, user, tools, maxSteps, terminalTools})`: <br>• calls the LLM; <br>• runs each tool call (args parsed with JSON then zod; validation errors and thrown errors become `{error, details}` tool results; per-tool timeout 30 s); <br>• appends the results and repeats. <br>It stops when a `terminal` tool succeeds, when the model answers without tool calls, at `maxSteps` (default 12), or on budget exhaustion. It returns `{status, terminalResult?, finalText?, runId}`. |
| FR-006 | `BudgetService.check(channelKey)` runs before **every** LLM call. It compares today's spent USD (Kyiv day) per channel against `EDITOR_CHANNEL_DAILY_BUDGET_USD` (default 0.50) and globally against `EDITOR_DAILY_BUDGET_USD` (default 3.00). If either is exceeded, the run ends with status `budget_exceeded`, and an alert fires once per day per scope. |
| FR-007 | Every run is persisted in `editor_runs`, with each LLM turn and tool call in `editor_run_steps`. Inputs and outputs are truncated to 8 KB per field. Spent tokens and cost are summed onto the run. A crash leaves the run as `running` and the stale sweeper (005) marks it `error`. |
| FR-008 | `sql_readonly(query)` accepts a single `SELECT` or `WITH` statement only; a classifier rejects `;`-chained statements, DDL, DML and `COPY`. It runs inside `BEGIN READ ONLY; SET LOCAL ROLE editor_ro; SET LOCAL statement_timeout='3s'`, wraps the query as `SELECT * FROM (<q>) _q LIMIT 50`, and rolls back afterwards. Role `editor_ro` (migration) has SELECT only on content, stat and editor tables plus the views. It has **no** grant on any table that holds secrets. |
| FR-009 | Read tools shipped in 003: `get_channel_stats`, `get_recent_posts`, `get_top_posts`, `sql_readonly`, `search_library`, `web_fetch` (SSRF-filtered, text extraction, 12 KB cap), `fetch_feed` (RSS through `RssFetcherService`), `check_similarity` (trigram/shingle similarity of a draft against the channel's last 60 posts), `load_skill`, `list_skills`. |
| FR-010 | Harness kill switch: when `EDITOR_ENABLED !== 'true'`, the loop refuses to start, with status `disabled`. |

## Non-functional
- No new runtime dependencies beyond `zod` (already in the lockfile).
- 100% offline unit tests: the LLM is faked through a `LlmClient` interface, HTTP is faked, and DB is faked or behind a pg interface.
- Expected cost: about $0.006 per executor run on the default model.

## Out of scope (other specs)
PostSpec, rendering and lint (004). Roles, scheduling, plans, slots and channel cards (005). REST, dashboard and MCP (006).

## Success criteria
- SC-1: The loop test suite covers: terminal stop, max steps, budget stop mid-run, invalid args recovered, tool throw recovered, and unknown tool.
- SC-2: The `sql_readonly` classifier test rejects `DELETE`, `UPDATE`, `INSERT`, `DROP`, `;`-chains, `COPY` and `SET ROLE`, and accepts `SELECT` and `WITH`.
- SC-3: The OpenRouter client test covers request shape, tool-call parsing, cost from usage, cost fallback, retry on 429, and no retry on 400.
