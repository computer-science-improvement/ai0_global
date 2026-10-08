# 035: Model picker (`/app/models`)

**Status:** DONE (built 2026-10-09) · **Priority:** P1 · **Linear:** AI0-92 · **Depends on:** 017 (agent registry), 029 (llm_prices, PriceService), 027 (navigation registry)
· **Migration:** none (the setting lives in `app_settings`; `068_model_picker.sql` stays unused)

**Owner request (2026-10-08):** a page where the owner picks the model of each agent from a list; the default is
`z-ai/glm-5.3-flash` for every agent.

## As-is (before)
- `resolveModel()` (`editor/llm/model-registry.ts`): per-channel / per-agent override → env `EDITOR_MODEL_<ROLE>` → a per-role default
  (`idea_reviewer` → `z-ai/glm-5.3`) → `z-ai/glm-5.3-flash`. The agent override was merged into the channel map, so the source of a
  choice was unknowable.
- Agents had `model` / `reasoning_effort` columns; the model was a free-text field on the agent profile, never validated; the agent's
  `reasoning_effort` was stored but never used by a run.

## Built (FRs)
- **FR-001 Precedence.** `pickModel(role, env, channelModels, {agentModel, defaultModel})` is pure and returns `{model, source}`:
  agent's own model (role agents inherit their orchestrator's) → channel card `models[role]` (legacy) → env `EDITOR_MODEL_<ROLE>` →
  the owner's global default (`app_settings` key `ai.default_model`) → `DEFAULT_EDITOR_MODEL` (`z-ai/glm-5.3-flash`). Sources:
  `agent | channel | env | default`. The `idea_reviewer` role default is gone: with no configuration every role runs flash.
  `ModelProfile.source` carries the source into the run.
- **FR-002 Reasoning effort.** `pickReasoningEffort`: the agent's own (role agents inherit the orchestrator's) → env
  `EDITOR_REASONING_<ROLE>` → env `EDITOR_REASONING` → the role default. The agent setting now takes effect.
- **FR-003 Global default.** `ModelDefaultsStore` (`editor/llm/model-defaults.ts`) reads `ai.default_model` with a 60 s in-process
  cache; a save updates the cache at once; a failed read keeps the last value. Every caller of `resolveModel` gets it through a
  `defaultModel` dependency (editor roles, network runner, MANAGER, editor chat composer, @ai0 / @manager chat).
  `SettingsService` never loads `ai.*` keys as env overrides (`isAiKey`, same rule as `ui.*`, `cap.*`, `landing.*`).
- **FR-004 Catalog.** `GET /api/models` — OpenRouter's public `https://openrouter.ai/api/v1/models` (no key) fetched server-side with
  a 10 s timeout, cached 24 h in process, one fetch in flight, a 5 min back-off after a failure. Only models whose
  `supported_parameters` include `tools`. Entry: `{id, name, contextLength, inPerM, outPerM, supportsReasoning}` (prices per 1M;
  negative / variable prices → null). The current default first, then by id; plus `fetchedAt`, `stale`, `source`
  (`openrouter | fallback`), `defaultModel`. A failed refresh serves the last good list (`stale: true`); with none, a fallback list from
  the OpenRouter rows of `llm_prices` + the static price map. Tests use a fake fetch only.
- **FR-005 API.**
  - `GET /api/models/overview` — default `{model, saved, builtin, price}`, `envOverrides` (role + key name only, never a value), every
    agent (system, orchestrators, their role children in order) with own model/effort, effective model, source, `inheritedFrom`,
    effective effort + source, price per 1M (`llm_prices` → catalog → static), and the channel cards with legacy `models`.
  - `PUT /api/models/default {model | null}` — null returns to the built-in default (row deleted).
  - `POST /api/models/bulk {action: 'apply_all', model} | {action: 'reset_all'}` — sets / clears `agents.model` on every agent
    (reasoning efforts are kept).
  - `POST /api/models/channels/clear {channelKey, role?}` — removes one role (or all) from a card's legacy `models`.
  - An agent's model / effort: the existing `PATCH /api/agents/:handle` (`model`, `reasoning_effort`), now guarded.
  - Validation: a new model must be in the catalog (offline: the fallback list) or equal a value already in use (the agent's current
    model, the saved / built-in default; for `apply_all` any agent's current model) → else 400 `unknown_model`.
  - Pricing: when a chosen model has no `llm_prices` row, its catalog price is inserted (`openrouter`, effective from the table default,
    note "OpenRouter catalog … (Models page)") and the PriceService cache is invalidated, so spend stays accurate.
- **FR-006 Page `/app/models`** (English UI, `table.tsx` structure, `Badge` tones, `useConfirm()` for every change):
  "Default model" card (searchable select, price in/out per 1M, context, "Use the built-in default"); "Agents" section with a bulk
  model select, "Apply to all agents" and "Reset all to default", and the table Agent · Role · Model · Source (`Agent` / `Channel` /
  `Env` / `Default`) · In / 1M · Out / 1M · Effort · Actions (edit → dialog with the model select, "Default (…)" / "Inherit from
  @orchestrator" first, and effort; reset to default); "Channel overrides (legacy)" only when a card has any; an env note listing the
  `EDITOR_MODEL_*` keys that are set. No horizontal page scroll at 375 px (the table scrolls in its wrapper).
- **FR-007** Shared `components/models/ModelSelect.tsx` (combobox: search over id + name, ↑/↓/Enter/Esc, current choice shown right
  after "Default", "not in catalog" marker, portaled fixed popover so tables and modals never clip it). It replaces the free-text
  Model field in `AgentOverview.tsx`.
- **FR-008** Navigation registry entry `models` (Agents group, icon `cpu`), so it is in the default menu and the ⌘K palette.

## Decisions
- No migration: the global default is one `app_settings` row; per-agent values use the existing columns.
- Agent beats channel beats env beats the global default (the owner's explicit per-agent choice wins; env stays an operator escape
  hatch above the page default and is shown on the page).
- Role agents inherit the orchestrator's model and effort (unchanged runtime behaviour, now visible as "via @orchestrator").
- "Reset all" clears models only; per-agent reasoning efforts stay (row reset clears both).
- Catalog fetch is lazy (first page load), never at boot.

## Owner notes
- Env `EDITOR_MODEL_<ROLE>` on the server beats the page default (the page lists which keys are set). `EDITOR_REASONING*` beats the
  role default effort but not an agent's own effort.
- Before this change `idea_reviewer` ran on `z-ai/glm-5.3`; it now runs flash unless an agent model / override / env says otherwise.
