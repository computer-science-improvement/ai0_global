# 005: Tasks

Constitution Check: I ✅ (every guard lives in `publish_post` and `submit_plan` code), III ✅ (shadow is the default path to live),
IV ✅, VI ✅ (fake clock, fake LLM).

## Phase 1: Repositories
- [ ] T001 `src/editor/repo/editor-channels.repository.ts`: card get, list and update; `toCard()` mapping. Test.
- [ ] T002 `src/editor/repo/editor-plans.repository.ts`: plans and slots. Covers create plan with slots (tx, supersede), claim due, mark status, sweep. Test.
- [ ] T003 `src/editor/repo/editor-memory.repository.ts`: list active, add, retire. Test.

## Phase 2: Tools
- [ ] T004 `get_channel_memory` and `get_format_performance` tools. Test.
- [ ] T005 `submit_plan` (planner terminal tool) with time and validation helpers in `src/editor/roles/plan-rules.ts`. Test (SC-1).
- [ ] T006 `publish_post` and `skip_slot` (executor) with guards in `src/editor/roles/publish-guards.ts`. Test (SC-2).
- [ ] T007 `add_memory`, `retire_memory`, `set_format_weights` and `finish_review` (reviewer). Test.

## Phase 3: Roles
- [ ] T008 `src/editor/roles/prompts.ts`: system and user prompt builders per role (skill list, card summary, memory, slot). Test.
- [ ] T009 `src/editor/roles/editor-runner.service.ts`: `runPlanner(channel)`, `runExecutor(slot)` and `runReviewer(channel)` over `AgentLoop`, with slot status transitions. Test.

## Phase 4: Scheduler and alerts
- [ ] T010 `src/editor/editor.scheduler.ts`: plan, execute, sweep and review ticks with a fake clock. Test (SC-3).
- [ ] T011 Alerts wiring (FR-008).

## Phase 5: E2E and docs
- [ ] T012 End-to-end scripted test (SC-4).
- [ ] T013 `docs/runbooks/editor-agent.md`: enable flags, example card SQL, shadow → live checklist, kill switch, budget.
