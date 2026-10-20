# 054 Agent loadout

**Epic:** AI0-246 · **Priority:** P1 · **Depends on:** 017, 018, 040, 053 · **Status:** done (2026-10-20) · **Migration:** 087

## Why

Every agent of a role gets the same tools, typically 20–44 of them. On top of those come every builtin skill for that role, listed by name and description, and the channel's rules and memory.

Most agents never call most of these tools, but every tool schema still rides in every LLM call. That costs tokens and gives the model more ways to wander.

The owner asked (2026-10-20) for each agent to have its own **loadout**:
- It is formed when the agent is created.
- After that, the owner manages it.
- The manager points out what is missing and what is never used.

The owner skipped the brainstorm; each decision below marked **my call** is mine.

## What exists (facts)

- **Tools.** `ToolRegistry.forRole(role, allow, {chat})` (`harness/tool-registry.ts`) offers a tool when all of these hold:
  - its `roles` include the role;
  - it is not `chatOnly`, unless this is a chat turn;
  - the allowlist names it, unless the allowlist is `null`.
  - Terminal tools (`kind: 'terminal'`) always pass.

  The only allowlist today is per channel: `card.toolsAllow` (`editor_channels.tools_allow`). It narrows the role default and never adds. The callers are:
  - `roles/editor-runner.service.ts:327` (`executorTools`, then the excludes `EXECUTOR_DENY`, `TELEGRAM_ONLY`, `PLATFORM_ONLY`, `DUPLICATE_TOOLS`);
  - `network/network-runner.ts:118` (`ORCHESTRATOR_EXCLUDE`, `IDEA_REVIEW_TOOLS`);
  - `chat/editor-chat.service.ts:500` (allow `null`, `chat: true`);
  - `manager/manager-runner.ts:218` (`MANAGER_TOOLS`).
- **Skills.**
  - `agent_skills(agent_id, skill_id, enabled, inline)`.
  - `SkillStore.listForAgent(chain)` resolves the agent first, then its orchestrator. Builtins are enabled by default.
  - Enabled skills of the role are listed in the prompt as name + description. Inline ones (≤ 4000 chars, within `INLINE_SKILLS_BUDGET` 8000) are injected whole.
  - The dashboard Skills tab (`components/agents/AgentSkills.tsx`) already has the Enabled and "Always in context" toggles.
- **Rules.** Owner rules, memory, steering and playbook rules are **per channel**, not per agent, and they are binding. This spec does not make them per agent.
- **Usage.**
  - `editor_run_steps(run_id, type, tool_name, input, is_error, created_at)` joined to `editor_runs.agent_id`. A `load_skill` step has the skill name in `input->>'name'`.
  - Steps are kept 30 days by default. Runs are kept 180 days.
  - The set of tools *offered* to a run is not recorded today.
- **053 FR-002.** The tool list is fixed for the whole run, which keeps the prompt cache warm. This spec keeps it so.

## Requirements

### FR-001 Data (T1)

Migration `087_agent_loadout.sql`:

- `agent_tools(agent_id UUID REFERENCES agents ON DELETE CASCADE, tool_name TEXT, enabled BOOLEAN NOT NULL DEFAULT true, created_by TEXT NOT NULL DEFAULT 'owner' CHECK (created_by IN ('owner','creation','recommend')), updated_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (agent_id, tool_name))`.
- `agents.loadout_mode TEXT NOT NULL DEFAULT 'role' CHECK (loadout_mode IN ('role','custom'))`.
  - `role` means the role default, as today. Existing agents keep it, so nothing changes until the owner acts.
  - `custom` means the agent gets only the tools enabled in `agent_tools`.
- `editor_runs.tools_offered TEXT[]`: the names offered to the run, written once at run start.

### FR-002 Resolution (T1)

- `LoadoutService.toolsAllow(agentId)` returns:
  - `null` for mode `role`;
  - the enabled names for mode `custom`.
- The resolution is wired into all four `forRole` callers. The effective allowlist is `intersect(card.toolsAllow, agentAllow)`, where `null` means no limit. The per-run excludes still apply after it. Terminal tools stay exempt.
  - The chat caller narrows by the agent's loadout too, but chat-only tools stay available in chat (**my call**: the chat is the owner's own surface).
  - The manager caller intersects with `MANAGER_TOOLS`.
- The list is resolved once per run and recorded in `editor_runs.tools_offered`. Unknown names in `agent_tools` (a tool renamed or removed) are ignored and reported by FR-005.
- Unit tests cover:
  - `role` → unchanged;
  - `custom` → narrowed;
  - intersection with the card;
  - terminal kept;
  - unknown names ignored;
  - stable order.

### FR-003 Loadout at creation (T2)

- **Profiles.** `loadout-profiles.ts` defines, per role, the **core** tools: the ones every agent of that role needs. The terminal tools plus the few its workflow skill names.
  - The rest of the role's tools are **optional**.
  - Profiles are code. A test asserts every name exists in the registry and has that role.
- **Creation.** When `AgentCreator.create` (builder) or `AgentRegistrySync.ensureChildren` (sync) creates a **new** agent, the loadout is formed:
  - Mode `custom`. The core tools are added with `created_by='creation'`.
  - Optional tools are added when the resource needs them:
    - platform tools for a resource with non-Telegram platforms;
    - Telegram-only tools for Telegram.
    - The rule is the same as the existing `TELEGRAM_ONLY` / `PLATFORM_ONLY` logic, read from the card's platforms.
  - Plus the tools that the role's peers (same role, other agents) called in at least 20 % of their runs in the last 30 days.
- **Skills at creation.** Builtin skills whose `applies_to` includes the role stay enabled, as today. Optional `tone-*` skills keep the existing attach. Nothing more (**my call**: skill bodies are not in context unless inline, so the gain is small. The owner manages skills on the same tab.)
- **Sync never changes** the loadout of an existing agent.

### FR-004 Owner manages it (T2 API, T3 UI)

- **API** (TrackingAuthGuard; English errors):
  - `GET /api/agents/:handle/loadout` →
    ```
    { mode, tools: [{ name, kind, description, core, enabled, available, tokens, calls30d, errors30d, lastUsedAt }],
      skills: [{ name, scope, enabled, inline, loads30d, lastLoadedAt, chars }],
      rules: { ownerRules, memory, steeringSets, playbookRules, chars },
      tokens: { current, roleDefault }, suggestions: [...] }
    ```
    - `available`: the tool is in the role's set for this agent.
    - `tokens`: the size of the tool's schema, as `ceil(JSON.stringify({name, description, input_schema}).length / 4)`.
  - `PUT /api/agents/:handle/loadout/tools` with `{ tools: string[] }` sets mode `custom`. The enabled set = the given names. Core tools cannot be dropped: they are refused with `core_tool`. Unknown names are refused with `unknown_tool`.
  - `POST /api/agents/:handle/loadout/reset` returns to mode `role`.
  - `POST /api/agents/:handle/loadout/apply` with `{ add: string[], remove: string[] }` applies a suggestion.
- **Dashboard.** A **Loadout** tab on the agent page (`/app/agents/$handle`), next to Skills. Three sections:
  - **Tools.** A card-row per tool, grouped by kind (read · act · terminal).
    - Each row shows: the name, the description clamped to one line, a core badge, uses and errors in 30 days, last used, and the token size.
    - A toggle per optional tool. Core and terminal tools show a locked toggle.
    - At the top:
      - the mode;
      - "~N tokens per call (role default M)";
      - **Reset to role default**, behind a confirm;
      - **Use recommended**, which applies the suggestions.
  - **Skills.** Reuse the Skills tab list (the toggles stay there). Add a compact read-only summary here: enabled count, inline chars, the ones never loaded in 30 days, and a link to the Skills tab.
  - **Rules.** Read-only. Counts and total chars of owner rules, memory, steering sets and playbook rules for the agent's channel, each linking to where it is edited (Rules and Memory artifacts, Steering, Playbook). The note: "Rules belong to the channel and bind every agent on it."
- All text in English. Follow `apps/dashboard/CLAUDE.md`.

### FR-005 Suggestions: what is missing, what is unused (T4)

`loadoutSuggestions(agent, usage, profile)` is a pure function over the last 30 days. It returns:

- **unused**: an optional tool offered in at least 10 runs and never called. Suggest remove.
- **missing**: the agent's runs tried to call a tool it was not offered. These are tool steps with `is_error` whose output says the tool is unknown or not allowed (match the harness's own error text), at least 2 times. Suggest add when the tool is in the role's set.
- **peer**: a tool that peers of the same role call in at least 30 % of runs, which this agent lacks. Suggest add.
- **stale**: names in `agent_tools` that no longer exist. Suggest remove.
- **skills_unused**: an enabled non-inline skill never loaded in 30 days while the agent ran at least 10 times. Suggest disable (it only costs a description line).

Each suggestion has a stable `id`, `kind`, `tool|skill`, `reason` (English, one line) and `evidence` (counts).

They show:

- in the Loadout tab;
- in the manager's KPI digest as one block, `loadout`, with at most 5 lines across the network. The manager may mention it in advice, but it does **not** get a new directive kind (**my call**: changing tools is the owner's decision, and the tab applies it in one click);
- in a weekly owner inbox note, posted once per ISO week with `postOnce`, kind `loadout_suggestions`, severity `info`. It is in Ukrainian, because it reaches the owner bot: «Інструменти агентів: N пропозицій» plus a link to the first agent's Loadout tab. Only when there is at least one suggestion.

## Non-goals

- Per-agent rules. Rules stay per channel.
- An LLM deciding the loadout. Everything here is counted in code, no paid calls.
- A builder chat tool to edit loadouts. It can come later through an action card.
- Changing an existing agent's loadout without the owner. Mode `role` stays until the owner presses something.

## Tasks

- T1 FR-001, FR-002: migration 087, `LoadoutService`, wiring in the four callers, `tools_offered` recording, unit tests, a PG test for the repository.
- T2 FR-003, FR-004 API: profiles plus their registry test, loadout at creation, the controller, usage queries (one grouped query per section), a PG test for the usage queries.
- T3 FR-004 UI: the Loadout tab, the API client, lib helpers with tests, mocks and a browser check.
- T4 FR-005: suggestions (pure, tested), the apply endpoint, the digest block, the weekly inbox note.

Each task ends green:
- automation: `npm test` and `npm run build` on Node 20;
- dashboard: `npx tsc --noEmit`, `npm test` and `npm run build`.
