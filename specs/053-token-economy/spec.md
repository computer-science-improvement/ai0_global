# 053 Token economy

**Epic:** AI0-226 (T1–T10 = AI0-227…236) · **Priority:** P1 · **Depends on:** 038, 041, 046 · **Status:** done 2026-10-18 (deltas in [tasks.md](tasks.md)) · **Applies to:** both workspaces (OpenRouter and Anthropic)

## Why

On 2026-10-17 the agents spent **$8.57** in one day against a $3/day target. The data comes from `scripts/llm-cost-report.sh 2` on the dev stage, run before 046 was deployed.

| Feature | Model | $ (2 days) | Of which cache writes | Notes |
|---|---|---|---|---|
| editor.manager | Opus | 4.27 | $2.12 | 4 runs a day, up to 39 steps, prompt 22k → 49k tokens, ~8.7k output (thinking) per run |
| editor.executor | Sonnet | 3.74 | $2.70 (72%) | first step already 42k prompt tokens; ~8.2k written to cache per call |
| editor.checker | Opus | 1.93 | $1.39 (72%) | one call per pass: the cache is written and never read |
| orchestrator / idea_reviewer / planner | Sonnet | 1.71 | | Haiku roles by 046 defaults |

**Root cause.**
- Cache reads are cheap. Executor reads cost $0.50 of the $3.74.
- What costs money is **cache writes of a large prefix that no later run reads back**. Runs are 30–60 minutes apart and the 5-minute cache has expired by then, so each run writes its whole prefix again:
  - about 20k tokens of tool schemas (the 16k-character PostSpec schema appears three times);
  - a system prompt of about 12k tokens.

**Other waste:**
- On the last step the loop swaps the tool list for the terminal tools, so the whole cache is rewritten at the longest context.
- Old tool results are never dropped.
- The idea reviewer makes 9.6 `sql_readonly` calls per run and judges ideas one at a time (8.4 `review_idea` calls per run).
- The manager's KPI digest is both in its system prompt and returned again by `get_kpi_digest`.
- `list_directives` returns about 11.5 KB.

**Not in scope, owner actions.** These come from the 046 runbook and need no code:
- remove the Opus agent models (manager, weekly reviewers);
- clear the Anthropic critic and default models;
- check that no orchestrator has Sonnet, because its children inherit it.

With these done, the estimate is $3–3.5 a day. This epic targets **≤ $2 a day at the same number of posts**.

## Requirements

### FR-001 Small executor prefix (T1, AI0-227)

**PostSpec schema:**
- The full PostSpec JSON schema is sent once, on `publish_post`.
- `lint_post` and `preview_post` take `spec` without a schema ("same shape as publish_post.spec"). The server still validates with Zod.
- Alternatively, both become `publish_post({dry_run: true})`.
- The schema the model sees is slimmed: no min/max, patterns or defaults that Zod already enforces.

**Tool allowlist per executor kind.** A Telegram slot does not get:
- `lint_platform_post`, `sql_readonly`, `edit_data_schema`, legacy `search_library`;
- `get_channel_card`, `get_channel_memory`, `list_skills` (already in the prompt);
- `get_network_highlights`;
- `fetch_api`, unless the slot is an api or live slot.

**System prompt:**
- `cardSummary` without `TELEGRAM_CAPABILITIES` (lint enforces it) and without pretty-printing.
- The skill list is names only, plus the `format-*` skill of the slot's format.
- Memory: 15 entries. Owner preferences: 10. Both with a per-entry character cap.

**Workflow skill:** `editor-executor-workflow.md` no longer requires a `lint_post` step, since `publish_post` lints.

**Acceptance:**
- The executor's first-step prompt is ≤ 22k tokens (now 42k), measured by the `s0_1` column of report section 5.
- The executor's cache writes per call are halved.

### FR-002 Cache hygiene (T2, AI0-228)

- **Stable tool list.**
  - The tool list stays the same for a whole run.
  - On the last step the nudge is text only, with no tool swap.
  - A tool the circuit breaker drops stays in the list and returns an error instead of being removed.
- **No cache breakpoints on single-call requests.** This covers the critic, a steering pass, and the onboarder's first call. A `cache: false` request option means no `cache_control` is sent.
- **Critic timeout.** A timed-out critic run is cancelled (AbortSignal), not left running beside the retry.

**Acceptance:**
- Checker cache writes are 0.
- No run has a cache write larger than its previous step's prompt growth, except on step 0.

### FR-003 Tool results do not pile up (T3, AI0-229)

- **Eliding old results.**
  - Once a run's history passes a threshold (e.g. 60k tokens), or a result is more than N steps old, results are replaced with a stub, e.g. `[web_fetch <url>: 11.8k chars, elided]`.
  - This happens in one batch, so the cache prefix breaks once.
  - The latest result of each tool is kept.
- **Valid JSON when cut.** Results are cut by rows, never by a raw string slice (`harness/truncate.ts`).
- **Lower caps:**

  | Tool | Change |
  |---|---|
  | `web_fetch` text | 12k → 6k characters |
  | `get_network_posts` | default limit 40 → 15; text 400 → 200 characters |
  | `fetch_feed` | default 10 → 6 items |
  | `list_directives`, `list_ideas` | compact rows (id, status, title, the one key field) |

**Acceptance:**
- No tool result over 8 KB in report section 10, except `load_skill`.
- Manager and orchestrator prompts at step 20 or later are ≤ 35k tokens.

### FR-004 Idea reviewer in a few steps (T4, AI0-230)

- A batch tool `review_ideas([{id, verdict, note}])` replaces one call per idea.
- **Checks move into code.** Novelty against recent posts (the `add_idea` similarity and excerpt checks), the 30-day topics and the source check are computed in code. Each idea line carries the scores.
- `sql_readonly` and `get_network_posts` are removed from the role.
- `STEPS.ideaReview` 25 → 6. The second batch only runs when the first one moved the backlog.
- The reviewer runs only when there are at least 3 new ideas or a pending playbook.

**Acceptance:** idea_reviewer averages ≤ 4 steps and no `sql_readonly` calls.

### FR-005 Orchestrator only when there is work (T5, AI0-231)

- **No LLM call when there is nothing to do.** The daily run skips the LLM when the idea quota is 0, no directive is open and no playbook is pending. It records a code-only "nothing to do" run.
- **Pre-computed stats.** A per-resource stats summary goes into the user message (last 7 days: posts, reach, best format) instead of `get_network_posts` / `get_platform_stats` calls.
- **Prompt and tools agree.** Remove mentions of tools the orchestrator does not have (`get_format_performance`, `fetch_api`) from its prompt, or grant them.
- **Tool allowlist.** Drop `get_playbook` (already rendered in the prompt), `sql_readonly`, `edit_data_schema` and `search_library`.
- **Steps:** `STEPS.orchestrate` 30 → 15.

**Acceptance:** orchestrator averages ≤ 10 steps. Days with nothing to do cost $0.

### FR-006 Manager (T6, AI0-232)

- `get_kpi_digest` requires `resource`. The network digest is already in the system prompt.
- **Tool allowlist:** digest, directives, playbook (read), ideas, `explain_decision`. Drop `query_data`, `sql_readonly`, `web_fetch`, `fetch_feed`, `search_library`, `library_catalog` and `edit_data_schema`.
- `kpi-reading` is loaded on demand, not inlined.
- **Steps:** the step cap is 12, and is enforced including granted steps. One run on 2026-10-17 took 39 steps.
- **Effort:** `low` by default.

**Acceptance:** manager ≤ $0.25 a run on Sonnet, ≤ 12 steps.

### FR-007 Fewer re-runs (T7, AI0-233)

- **Critic passes per slot.** They are counted across the 15-minute retry and the fallback ladder (stored on the slot), not per executor call.
- **Content failures.** No slot retry after a content failure (critic reject, lint, guard). The retry stays for crashes and timeouts only.
- **Fallback ladder.** At most one extra step after the first attempt.
- **Budget pre-check.** It uses the run's provider instead of the hard-coded `'openrouter'` (`editor.module.ts`).

### FR-008 Shared static prefix, measured (T8, AI0-234)

- **Ordering.** Order the executor prefix so that the tools and the static part of the system prompt are identical across channels. The channel-specific part comes after the breakpoint.
- **1-hour cache (`ttl: 1h`, 2× write price).** Use it only on that static block, and only if the report shows at least 2 reuses per hour. Decide on the numbers after T1.
- **Haiku price.** Model the Haiku price tier above 100K prompt tokens in `llm_prices`.

### FR-009 Same economics on OpenRouter (T9, AI0-235)

All of FR-001…FR-007 live in the loop, the tools, the prompts and the schedulers, so they are provider-neutral and apply to both workspaces (`ai.workspace` openrouter | anthropic). On OpenRouter the step count matters even more: on 2026-10-16/17, GLM runs took about 2–3× the steps of Sonnet runs for the same role.

| Role on GLM | Avg steps | Max steps | Avg prompt per run |
|---|---|---|---|
| idea_reviewer | 36 | 50 (cap 25) | 511k |
| orchestrator | 26 | — | 203k |
| executor | 19.8 | — | 346k |

**Additional work for OpenRouter (`llm/openrouter.client.ts`):**
- **Explicit cache breakpoints for models that need them.** Anthropic (`anthropic/*`) and Google Gemini models on OpenRouter cache only with `cache_control` markers. The OpenRouter client sends the same three breakpoints as the Anthropic client: the system prompt, the last tool and the newest message block. It follows the FR-002 rules: none on single-call requests, and a stable tool list. Today a Claude model picked in the OpenRouter workspace pays full input price on every step.
- **Implicit caching.** Other models (GLM, DeepSeek, OpenAI) cache automatically when the prefix stays the same, so FR-001 and FR-002 (a small, byte-stable prefix) are what make them cache.
- **Cache writes in the ledger.** Record `prompt_tokens_details.cache_write_tokens` (when OpenRouter returns it) into `tokens_cached_write`, so report sections 1 and 6 compare both providers.
- **Step caps.** Step caps and granted steps are enforced the same way on both providers. The GLM idea reviewer reached 50 steps against a cap of 25; find out why.

**Acceptance:**
- The FR-001…FR-007 acceptance numbers hold in a 2-day OpenRouter window as well as in an Anthropic one.
- On OpenRouter with a Claude model, the cache read share is ≥ 70%.

### FR-010 Measurement (T10, AI0-236)

- `scripts/llm-cost-report.sh` (read-only, 12 sections) is committed and documented in the runbook.
- **Acceptance check:** two 2-day windows, before and after deploy, for each workspace in use. The README of this spec records:
  - $ per feature;
  - executor `s0_1`;
  - cache writes per call;
  - steps per role.

## Out of scope

- The model choices (046 runbook, owner).
- The Batch API: the loop roles cannot batch, and the critic is on the publish path.
- Changing post volume or channel count.
