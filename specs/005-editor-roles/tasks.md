# 005: Tasks

Constitution Check: I ✅ (every guard lives in `publish_post` and `submit_plan` code), III ✅ (shadow is the default path to live),
IV ✅, VI ✅ (fake clock, fake LLM).

## Phase 1: Repositories
- [x] T001 `src/editor/repo/editor-channels.repository.ts`: card get, list and update; `toCard()` mapping. Test.
- [x] T002 `src/editor/repo/editor-plans.repository.ts`: plans and slots. Covers create plan with slots (tx, supersede), claim due, mark status, sweep. Test.
- [x] T003 `src/editor/repo/editor-memory.repository.ts`: list active, add, retire. Test.

## Phase 2: Tools
- [x] T004 `get_channel_memory` and `get_format_performance` tools. Test.
- [x] T005 `submit_plan` (planner terminal tool) with time and validation helpers in `src/editor/roles/plan-rules.ts`. Test (SC-1).
- [x] T006 `publish_post` and `skip_slot` (executor) with guards in `src/editor/roles/publish-guards.ts`. Test (SC-2).
- [x] T007 `add_memory`, `retire_memory`, `set_format_weights` and `finish_review` (reviewer). Test.

## Phase 3: Roles
- [x] T008 `src/editor/roles/prompts.ts`: system and user prompt builders per role (skill list, card summary, memory, slot). Test.
- [x] T009 `src/editor/roles/editor-runner.service.ts`: `runPlanner(channel)`, `runExecutor(slot)` and `runReviewer(channel)` over `AgentLoop`, with slot status transitions. Test.

## Phase 4: Scheduler and alerts
- [x] T010 `src/editor/editor.scheduler.ts`: plan, execute, sweep and review ticks with a fake clock. Test (SC-3).
- [x] T011 Alerts wiring (FR-008).

## Phase 5: E2E and docs
- [x] T012 End-to-end scripted test (SC-4).
- [x] T013 `docs/runbooks/editor-agent.md`: enable flags, example card SQL, shadow → live checklist, kill switch, budget.
