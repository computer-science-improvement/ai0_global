# 064 — Ops batch from review 3

Status: done · Builds on 040 (loop guards), 049 (keeper), 053 (token economy), 054 (loadout), 055 (@sysadmin) · No migration

## Why

Review 3 (`docs/reviews/2026-10-22-agent-review-3.md`) left a set of small, independent defects (P2/P3) that spoil logs, cost turns or mislead the owner. This spec fixes them in one batch.

## What

### FR-001 Rollup lock

`LlmUsageRollup` fails every night at 00:10 Kyiv with duplicate key `uq_llm_usage_daily`. The `*/5` job (`common/ai/usage/llm-usage.module.ts:44`) and the midnight cron (`:55`) fire in the same second, and `llm-usage-rollup.ts:31-42` does DELETE+INSERT without a lock.

Fix: `pg_advisory_xact_lock(<const>)` at the start of the rollup transaction. Keep both schedules. Add a PG test that runs two rollups concurrently.

### FR-002 Error text never empty

Warnings «owner bot: message not sent: » and «Meta collector … verify failed: » print an empty reason. `??` does not catch `''` (`owner-bot/owner-text.ts:38-46`, `meta-graph.client.ts:104`).

Fix: a shared `errText(err)` that returns `message || code || cause?.code || name || String(err)`. Use it at these sites and any other `err.message ??` / `String(e.message)` log sites in `src/editor` and `src/stats`. Add a test.

### FR-003 Planner and orchestrator schema friction

- **Grace turns on `plan_invalid`.** The planner hit `max_steps` 4 times on `plan_invalid` at its last turn (`agent-loop.ts` ~293/400). Like `critic_revise`, a terminal-tool error on the last turn grants 1 extra turn (`_grantSteps`), at most 2 per run.
- **Nullable `series`.** `submit_plan` accepts `series: null` (`.nullish()`).
- **Long text is cut, not rejected.** Long free text (`brief`, `topic`, `finish_orchestration.summary`, `submit_critique.notes`) is truncated with « …(скорочено)» instead of rejected. The limit is stated in the tool description.
- **Explain bad JSON.** `invalid_args` for a JSON string that cannot be parsed includes the `JSON.parse` message.
- **`ilike` with only `%`.** In `query_data`, `ilike` with only `%` means "any" (no filter) instead of `invalid_value`.

### FR-004 Circuit breaker keyed by host

After 3 `host_blocked` on one host, the breaker drops all of `web_fetch` for the run (`agent-loop.ts:376-380`). The breaker key for `web_fetch`/`fetch_feed` errors that carry a host becomes `tool + host`: other hosts stay reachable. Add a test.

### FR-005 Elision stub carries the gist

The 053 elision stub (`context-trim.ts:17`) says "call the tool again", and the model re-fetches. Instead, the stub keeps the URL/args and a one-line gist (the first ~160 chars of the output, or its title), and says «повторний виклик лише якщо потрібні деталі». Add a test.

### FR-006 Executor loadout trim

- `lint_post` and `preview_post` are removed from the executor role default. `publish_post` lints itself since 053 T1. Check that no executor prompt tells it to call them.
- `propose_skill_edit` is removed from the orchestrator role default. It stays on the manager.
- The 054 loadout catalogue must stay consistent: role defaults, the "unused" suggestions, and the tests.

### FR-007 Tool result cap includes the wrapper

Results over 8 KB still occur (max 9,053 chars) because the cap counts rows and the wrapper adds up to 13%. Cap the serialised result, including the wrapper, at the 053 limit, trimming rows until it fits and noting how many were dropped.

### FR-008 Sub-agent modes say who governs

Child agents (planner, executor, ideas of a channel) shown as `off` still run, because the orchestrator's or channel's mode governs (`card.ts:25`, `schedule.service.ts:410`). In the dashboard the mode control on a role child is replaced by a read-only "Follows @<orchestrator> (<mode>)" badge with a tooltip. The API rejects a mode change on a role child with a clear error. All UI text is English.

### FR-009 @sysadmin checks stored owner rules

The 047 write-time rule lint (unknown skill named, pointer-only rule, rule that only asks to update something) runs over **stored active** owner rules in the weekly audit. Each hit is a finding with the `memory_retire` fix (spec 055 fix kinds). Rules #10, #14 and #15 on stage are the expected hits. Add a test with fixtures.

### FR-010 Meta insights backoff

4 of 5 Meta insight metrics return 400 every hour (FB `page_impressions`, `page_impressions_unique`, `page_views_total`; IG `impressions`, `profile_views`). A metric that returns a "metric not supported / deprecated" 400 is remembered per account for 7 days and not requested. A per-account in-memory map is enough. Log once per day, not per hour.

## Acceptance

Unit tests for each FR, a PG test for FR-001, and dashboard tests for FR-008. No paid calls.
