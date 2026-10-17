# 053 Token economy — tasks

Planned, not started. Every task applies to both workspaces (OpenRouter and Anthropic).

- [ ] T1 (AI0-227) Small executor prefix: PostSpec schema once (slimmed), executor tool allowlist, compact card / skill list / memory caps, no mandatory `lint_post`; first step ≤ 22k tokens
- [ ] T2 (AI0-228) Cache hygiene: stable tool list for a whole run (text-only last-step nudge, dropped tools return errors), `cache: false` on single-call requests (critic, steering, onboarder), cancel a timed-out critic run
- [ ] T3 (AI0-229) Tool results: elide old results into stubs in one batch, cut by rows (valid JSON), lower caps (web_fetch, get_network_posts, fetch_feed, list_directives, list_ideas)
- [ ] T4 (AI0-230) Idea reviewer: `review_ideas` batch tool, novelty / topic / source checks in code, no `sql_readonly`, ≤ 6 steps, runs only with ≥ 3 new ideas
- [ ] T5 (AI0-231) Orchestrator: no LLM call when there is nothing to do, pre-computed stats in the prompt, prompt and tools agree, tool allowlist, ≤ 15 steps
- [ ] T6 (AI0-232) Manager: `get_kpi_digest` requires a resource, tool allowlist, kpi-reading on demand, ≤ 12 steps enforced, effort low
- [ ] T7 (AI0-233) Fewer re-runs: critic passes per slot across retries, no retry after a content failure, ≤ 1 extra ladder step, budget pre-check uses the run's provider
- [ ] T8 (AI0-234) Shared static prefix across channels; 1-hour cache only if the numbers justify it; Haiku > 100K price tier
- [ ] T9 (AI0-235) OpenRouter parity: `cache_control` breakpoints for Anthropic / Gemini models on OpenRouter, cache writes in the ledger, step caps enforced the same way (GLM idea reviewer reached 50 steps against 25)
- [ ] T10 (AI0-236) Measurement: `scripts/llm-cost-report.sh` in the runbook; before / after 2-day windows per workspace recorded here
