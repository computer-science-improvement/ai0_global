# 003: Tasks

Test: `cd apps/automation && npx tsx --test "src/editor/**/*.test.ts"`. Type-check: `npx tsc --noEmit`.

## Phase 1: Setup
- [x] T001 Add `zod@4.3.6` to automation dependencies (it is already in the lockfile).
- [x] T002 Write migration `database/migrations/042_editor.sql` per data-model.md: tables, views, the `editor_ro` role and guarded grants. Make it idempotent and have it record its own version.
- [x] T003 Add env docs to `.env.example`: `EDITOR_ENABLED`, `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`, `EDITOR_MODEL_*`, `EDITOR_DAILY_BUDGET_USD`, `EDITOR_CHANNEL_DAILY_BUDGET_USD`.

## Phase 2: LLM (US1)
- [x] T004 [P] `llm/llm.types.ts`.
- [x] T005 [P] Test first, then `llm/model-registry.ts`.
- [x] T006 Test first, then `llm/openrouter.client.ts`: request shape, tool-call parsing, `usage.cost`, price fallback, retry on 429/5xx, no retry on 4xx, timeout.

## Phase 3: Harness (US2, US3, US4)
- [x] T007 [P] Test first, then `harness/truncate.ts`.
- [x] T008 [P] `harness/tool.ts` (`defineTool` and `toToolSpec` via `z.toJSONSchema`), with a test.
- [x] T009 Test first, then `harness/tool-registry.ts`: role filter, allowlist filter, unknown tool.
- [x] T010 `harness/run-recorder.ts`: start, llmStep, toolStep, finish (SQL), with a test against a fake pool.
- [x] T011 Test first, then `harness/budget.service.ts`: per-channel and global, Kyiv day boundary, alert once.
- [x] T012 Test first, then `harness/agent-loop.ts`: covers all SC-1 cases.

## Phase 4: Read surface (US5)
- [x] T013 [P] Test first, then `db/readonly-sql.ts` (classifier + wrapper), followed by `db/readonly-query.service.ts`.
- [x] T014 [P] Test first, then `net/ssrf-guard.ts`.
- [x] T015 `skills/skill-library.ts` with a test; loads from `apps/automation/editor-skills`.
- [x] T016 Read tools, each with a test:
  - `get_channel_stats`
  - `get_recent_posts`
  - `get_top_posts`
  - `sql_readonly`
  - `search_library`
  - `web_fetch`
  - `fetch_feed`
  - `check_similarity`
  - `list_skills` and `load_skill`
- [x] T017 `editor.module.ts`: wire the providers and the `EDITOR_TOOLS` multi-provider, and register the module in `app.module.ts` behind `EDITOR_ENABLED`. The module is always imported, and the loop refuses to run when disabled.

## Done when
SC-1, SC-2 and SC-3 all pass, the full automation suite is green, and `tsc` is clean.
