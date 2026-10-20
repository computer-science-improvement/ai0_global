# 054 tasks

Linear epic: AI0-246.

- [x] T1 FR-001, FR-002: migration `087_agent_loadout.sql`, `LoadoutService.toolsAllow`, wiring in the four `forRole` callers (runner, network runner, chat, manager), `editor_runs.tools_offered`, unit tests, PG test for the repository.
- [x] T2 FR-003, FR-004 API: `loadout-profiles.ts` (core per role) with a registry test, the loadout at creation (builder + sync, new agents only), `GET/PUT/POST /api/agents/:handle/loadout…`, usage queries with a PG test.
- [x] T3 FR-004 UI: the Loadout tab (tools, skills summary, rules summary), API client, lib helpers with tests, mocks, browser check.
- [x] T4 FR-005: `loadoutSuggestions` (pure, tested), apply, the manager digest block, the weekly inbox note.
- [x] T5: runbook section, specs README row, spec status.

## Status

Done 2026-10-20: T1 722a0546, T2 44fe89db, T3 c1d1f7c2, T4 61359a57, T5 with the docs.

## Deltas from the spec

- **Loadout applies when the agent's own role is the run's role.** In the chat, tools outside the agent's role universe (the composer and chat-only tools) stay offered; only its own role's optional tools are narrowed.
- **Empty intersection.** `forRole` treats `[]` as "no limit", so an empty custom set is passed as the sentinel `(none)`; it can only happen when `tools_allow` and the loadout share nothing.
- **Missing-tool text.** The harness's refusal is `{ error: 'tool_not_allowed', details: 'unknown or disallowed tool "X"' }` (from `AgentLoop.runTool`); the usage queries match `output->>'error' = 'tool_not_allowed'`. A refused call is not counted as a use of the tool.
- **Terminal tools are stored and always offered**; a PUT does not need to name them. Hard-excluded tools (the writer's `EXECUTOR_DENY`, the orchestrator's exclusions, the idea reviewer's non-review tools) are accepted by a PUT but shown `available: false` and never offered.
- **Orchestrator core has no `fetch_api`**: the orchestrator role does not have that tool.
- **Peers at creation need 5+ peer runs** (`PEER_MIN_RUNS`), so one busy agent cannot set the loadout of every new agent.
- **`agent_tools.setTools` keeps dropped tools as disabled rows** (remembering what the owner dropped) instead of deleting them; reset deletes the rows.
- **Manager role-default tokens count only `MANAGER_TOOLS`.**
- **Apply also takes `disableSkills`** (the spec's `{ add, remove }` covers tools only): the *skill unused* suggestion switches the agent's own `agent_skills` toggle off. Safety and voice skills are refused (`safety_skill`); a skill not of the agent's role is `unknown_skill`. A skill-only apply leaves the mode as it is.
- **Skills never suggested as unused:** inline skills, safety skills, `*-workflow`, `voice-core`, `tone-*`, `agent-*` and the protected set, because their text is already in the prompt and a missing `load_skill` says nothing.
- **Suggestions are calculated per view** (peer rates: 2 queries per agent). The digest and the weekly note reuse one scan, cached for 10 minutes.
- **Digest hash is unchanged**: the `loadout` block is advice only and does not force a manager review. The manager skill text does not mention it; it is just another block of the digest.
- **Weekly note** runs Mondays 09:30 (server time) from `AgentsUpkeep`; the dashboard inbox shows an "Open loadout" link for the kind. Title is the spec's Ukrainian text; the body is Ukrainian too.
- **PG tests build their own database per file** (`t054_*`, init.sql plus every migration, dropped after), so they never touch the shared test database.
- **Not verified in a browser** (the implementing agent had none): the Loadout tab, the toggles, the reset and apply confirms, the suggestions list, the 404 empty state, the rules links to `/app/artifacts?type=…&agent=…`, and the inbox "Open loadout" link.
- **Risk:** a Telegram-only agent created before its channel joined a network has no `lint_platform_post`; the *Missing* suggestion catches it after two refused calls.
