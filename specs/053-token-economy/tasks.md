# 053 Token economy — tasks

Implemented 2026-10-18. Every change is in the loop, the tools, the prompts or the schedulers, so it applies to both workspaces (OpenRouter and Anthropic). Deploy steps and how to measure: [runbook.md](runbook.md).

- [x] T1 (AI0-227) Small executor prefix: the PostSpec schema only on `publish_post` (`save_draft` in chat); `lint_post`, `preview_post` and `lint_platform_post` take `spec` without a schema and validate it themselves (`tools/spec-arg.ts`, with the loop's repairs). The schemas of the three check tools went from 35,292 to 1,550 characters. A Telegram slot no longer gets `lint_platform_post`. The executor loses `sql_readonly`, `get_channel_card`, `get_channel_memory` and `list_skills` unless the channel's `tools_allow` names them. The card is compact JSON. The writer gets 15 memory entries (≤ 300 characters each), 10 owner preferences and skill hints of ≤ 80 characters. `publish_post` lints itself, so the workflow skill and prompts no longer require `lint_post`.
- [x] T2 (AI0-228) Cache hygiene: one tool list for the whole run; the last turn keeps every tool, says in text that only a terminal tool counts, blocks other calls and grants one grace turn. The critic runs with `cache: false` and is cancelled (AbortSignal) when it times out. Anthropic and OpenRouter clients send no `cache_control` on a `cache: false` request and never retry a cancelled one.
- [x] T3 (AI0-229) Tool results: capped at 8,000 characters by rows (valid JSON with an "[N more items omitted]" marker), `load_skill` 12,000, `list_ideas` 16,000. Old results become stubs in one batch once a run's results pass 40,000 characters (down to 20,000); the newest turn and the newest result of each tool stay. `web_fetch` 6k characters, `get_network_posts` 15 rows × 200 characters, `fetch_feed` 6 items, compact `list_directives` (full rows by `ids`).
- [x] T4 (AI0-230) Idea reviewer: `review_ideas` batch tool; each idea line carries a novelty note computed by code (closest network post of 14 days, evergreen topic of 30 days); tools are `review_ideas`, `review_playbook`, `get_playbook`, `list_ideas`, `web_fetch`, `load_skill`, `finish_idea_review`; 6 turns; runs with ≥ 3 new ideas, a day-old idea or a pending playbook.
- [x] T5 (AI0-231) Orchestrator: no model call when no directive is open, the idea quota is 0 and nothing waits for revision (the upkeep and the idea review still run); a 7-day stats block in the message (`network/network-stats.ts`); the prompt no longer names `get_format_performance` / `fetch_api`; no `get_playbook`, `sql_readonly`, `edit_data_schema`, `search_library`; 15 turns.
- [x] T6 (AI0-232) Manager: `get_kpi_digest` requires `resource`; the scheduled review gets its own tool set (`MANAGER_TOOLS`); `kpi-reading` is listed, not inlined; 12 turns; effort `low` by default.
- [x] T7 (AI0-233) Fewer re-runs: critic passes count across the 15-minute retry (an attempt the critic read goes into the slot's trace; a slot at the cap is skipped before another run); no retry after a content failure; one ladder step by default (`EDITOR_LADDER_EXTRA_STEPS`, a lint failure tries the lighter format first); the budget pre-check uses the active workspace's provider.
- [x] T8 (AI0-234) The 1-hour tool cache is an option (`EDITOR_ANTHROPIC_TOOLS_CACHE_TTL=1h`), off until the numbers justify it. Haiku 5.5 pays 5× above 100K prompt tokens, in the ledger price and the static fallback.
- [x] T9 (AI0-235) OpenRouter parity: `cache_control` on the system message and the newest message for `anthropic/*` and `google/*` models; `cache_write_tokens` recorded as cache writes; step caps tested the same on both workspaces.
- [x] T10 (AI0-236) Measurement: [runbook.md](runbook.md); the report gained model turns per run (section 3) and cache shares for every provider (section 6).

## Deltas from the spec

- **FR-001.** The `publish_post` schema is not slimmed (min/max and patterns stay): the one remaining copy is the model's only guide to the shape. `fetch_api`, `search_library`, `get_network_highlights` and `edit_data_schema` stay with the executor: the workflow and the series sources use them. Capabilities stay in the card for quality. The skill list keeps a short description (≤ 80 characters) instead of names only.
- **FR-002.** A tool the circuit breaker drops still leaves the list: the 040 replays show a stubborn model keeps calling what it sees, and a drop is rare. Steering and the onboarder keep the cache: a retry after a bad submit reads it back.
- **FR-003.** Elision is by characters (40k → 20k of tool results), not 60k tokens.
- **FR-004.** `review_idea` stays registered but is not offered to the scheduled reviewer. The verdict keeps scores and a comment. Sources are not checked by code; `web_fetch` is kept for a doubtful source. A day-old idea is reviewed even when fewer than 3 wait.
- **FR-005.** A skipped orchestration records no run. An idea waiting for revision counts as work; a pending playbook does not (the reviewer handles it).
- **FR-006.** The manager also keeps `sql_readonly` (its workflow skill names it), `get_network_posts`, `get_platform_stats`, `list_series`, `list_agents`, `get_agent`, `propose_skill_edit` and `load_skill`.
- **FR-007.** The ladder step count is configurable; with the default of 1 the evergreen step only runs when the steps before it had no candidate.
- **FR-008.** The cross-channel static system block is not split out: the tool block already has its own breakpoint shared across channels, and the rest of the writer prompt is channel-specific. Revisit after the first measurement. The Haiku tier lives in code (`LONG_PROMPT_TIERS`), not as an `llm_prices` row: a row has one rate set.
- **FR-009.** Two breakpoints on OpenRouter (system, newest message): the system mark already covers the tools before it. The "50 steps against a cap of 25" was `editor_runs.steps`, which counts tool calls too; caps count model turns.

## Measurements

| Window | Workspace | $ / day (agents) | Executor `s0_1` | Cache writes / call (executor) | Turns: executor / idea_reviewer / orchestrator / manager |
|---|---|---|---|---|---|
| 2026-10-16…17 (before 046) | Anthropic | 8.57 | 42k | ~8.2k | — |
| after deploy | | | | | |
