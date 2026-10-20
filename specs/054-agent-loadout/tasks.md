# 054 tasks

Linear epic: AI0-246.

- [x] T1 FR-001, FR-002: migration `087_agent_loadout.sql`, `LoadoutService.toolsAllow`, wiring in the four `forRole` callers (runner, network runner, chat, manager), `editor_runs.tools_offered`, unit tests, PG test for the repository.
- [x] T2 FR-003, FR-004 API: `loadout-profiles.ts` (core per role) with a registry test, the loadout at creation (builder + sync, new agents only), `GET/PUT/POST /api/agents/:handle/loadout…`, usage queries with a PG test.
- [ ] T3 FR-004 UI: the Loadout tab (tools, skills summary, rules summary), API client, lib helpers with tests, mocks, browser check.
- [ ] T4 FR-005: `loadoutSuggestions` (pure, tested), apply, the manager digest block, the weekly inbox note.
- [ ] T5: runbook section, specs README row, spec status.
