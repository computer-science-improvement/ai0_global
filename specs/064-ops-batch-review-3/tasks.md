# 064 tasks

- [x] T1 Rollup advisory lock (PG test); shared `errText` at the log sites; Meta insights metric backoff; tests.
- [x] T2 Loop: planner grace turns on terminal-tool errors, `series` nullish, truncate long free text, JSON parse message, `ilike '%'`; breaker keyed by host; elision stub with gist; result cap with wrapper; tests.
- [x] T3 Loadout trims (executor lint/preview, orchestrator propose_skill_edit); sub-agent mode badge + API guard (dashboard, English); @sysadmin finding for stored owner rules (memory_retire); tests; docs (runbook §, specs README row 064 DONE, spec status done).

## Status

- T1 — done (commit `064 T1`)
- T2 — done (commit `064 T2`)
- T3 — done (commit `064 T3`)

## Deltas from the spec

- FR-002: `errText` lives in `src/common/err-text.ts`. It was applied across `src/editor` and `src/stats` log sites that used `err?.message ?? err` (55 files, a mechanical swap), except `editor.module.ts`, `editor.scheduler.ts`, `chat/`, `critic/`, `harness/`, `tools/`, `llm/`, `mcp/`, which other parallel specs touch (they keep their `??` sites; the helper is there for them). Three files that already had a private `errText` import the shared one as `errMessage`.
- FR-001: the PG test builds its own throwaway database with only `llm_usage` and `llm_usage_daily`, taking the DDL from the 056 migration.
- FR-010: the backoff lives in `src/config/meta-insight-backoff.ts` and is called from `MetaGraphClient.fetchInsights` (in-memory per client instance, key `platform:target:metric`). A 400 counts as "unsupported" when Graph code is 100 or the message says unsupported/deprecated/invalid metric. The collector itself is untouched, apart from `errText` in its log lines.
- FR-003: `series: null` is accepted as-is (`.nullish()`); the downstream types took `string | null`. Long text is cut by `longText(min, max)` (`harness/clip-text.ts`, a zod transform, so the JSON schema loses `maxLength`; the limit is stated in the field description instead). Applied to slot `topic` (300), `finish_orchestration.summary` (1500), `submit_critique.notes` (800) and the series `brief` (600, `define_series` / `update_series` tools). The spec's `brief` is read as the series brief: it is the only tool field called `brief` the agents fill. An `invalid_json` error now carries the `JSON.parse` message; the «JSON string that does not parse» note is added to the matching `invalid_args` issue.
- FR-003 grace turns: a terminal-tool error on the *last* turn adds one turn, at most 2 per run (`MAX_TERMINAL_ERROR_GRANTS`); it is independent of the one-time `_grantSteps` grant, which wins when a tool sets it.
- FR-004: the host comes from the call's `url` argument (`web_fetch`, `fetch_feed`), not from the error: `host_blocked` carries no host field and `net/host-failures.ts` is 061's file. The breaker key becomes `tool@host`; at 3 errors that host is answered `tool_dropped` for the rest of the run and the tool stays on the list. The recorder's `toolsDropped` lists `web_fetch@host` entries beside whole-tool drops.
- FR-007: the oversize results were the *stored* trace (`truncateJson` wrapped the cut JSON in a `preview` string, whose escapes added up to 13%). `truncateJson` now shrinks by rows first (valid JSON with «[N more items omitted]»), and only then wraps a preview sized so the wrapped, escaped form fits 8,000 (the 053 limit; it was 8,192). The model-facing `toToolContent` was already row-capped; its plain-cut fallback now counts its marker too.

- FR-006: the executor's default trim is the hard exclusion `EXECUTOR_DENY` in `roles/editor-runner.service.ts` (`sql_readonly`, `get_channel_card`, `get_channel_memory`, `list_skills`, `lint_post`, `preview_post`); only the channel's `tools_allow` overrides it. `propose_skill_edit` joined `ORCHESTRATOR_EXCLUDE` in `network/network-runner.ts`. The skill and derived-slot prompt texts no longer tell the executor to call the removed tools. `DUPLICATE_TOOLS.telegram` now lists `publish_post` and `skip_slot`.
- FR-008: spec 047 already had `effectiveMode` and a partial guard. The API now refuses any `mode` on a role child (`409 mode_follows_orchestrator`). The dashboard replaces the switch and the plain mode badge of a child with a read-only `FollowsBadge` (`components/agents/AgentsUi.tsx`, text from `lib/agent-mode.ts`).
- FR-009: the rule lint finding (`rule_lint`, spec 055) already existed without a fix. It now carries `memory_retire`, and `retireMemoryPort` (`sysadmin/audit-ports.ts`, wired in `editor.module.ts`) retires reviewer rows first, then owner rows.
- Runbook: `docs/runbooks/agent-platform.md` section 23.
