# 064 tasks

- [x] T1 Rollup advisory lock (PG test); shared `errText` at the log sites; Meta insights metric backoff; tests.
- [ ] T2 Loop: planner grace turns on terminal-tool errors, `series` nullish, truncate long free text, JSON parse message, `ilike '%'`; breaker keyed by host; elision stub with gist; result cap with wrapper; tests.
- [ ] T3 Loadout trims (executor lint/preview, orchestrator propose_skill_edit); sub-agent mode badge + API guard (dashboard, English); @sysadmin finding for stored owner rules (memory_retire); tests; docs (runbook §, specs README row 064 DONE, spec status done).

## Status

- T1 — done (commit `064 T1`)

## Deltas from the spec

- FR-002: `errText` lives in `src/common/err-text.ts`. It was applied across `src/editor` and `src/stats` log sites that used `err?.message ?? err` (55 files, a mechanical swap), except `editor.module.ts`, `editor.scheduler.ts`, `chat/`, `critic/`, `harness/`, `tools/`, `llm/`, `mcp/`, which other parallel specs touch (they keep their `??` sites; the helper is there for them). Three files that already had a private `errText` import the shared one as `errMessage`.
- FR-001: the PG test builds its own throwaway database with only `llm_usage` and `llm_usage_daily`, taking the DDL from the 056 migration.
- FR-010: the backoff lives in `src/config/meta-insight-backoff.ts` and is called from `MetaGraphClient.fetchInsights` (in-memory per client instance, key `platform:target:metric`). A 400 counts as "unsupported" when Graph code is 100 or the message says unsupported/deprecated/invalid metric. The collector itself is untouched, apart from `errText` in its log lines.
