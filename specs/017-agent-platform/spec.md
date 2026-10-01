# 017: Agent registry: named agents, agent pages, DB skills with versions and self-edit

**Status:** SPEC · **Depends on:** 003–010 · **Design:** [design.md](design.md) · **Migration:** `049_agents.sql`

## Why
Today an "agent" is implicit: a channel card plus three roles. The owner wants to see every agent as an entity:
- with a name and a handle;
- bound to a resource or a network;
- with a page showing its skills, memory, history and spend;
- with skills the owner can edit and agents can improve themselves.

This spec is the foundation for 018–022.

## User stories
- **US1:** I open `/app/agents` and see a tree: `@manager` → networks and resources → their agents. For each agent I see
  its status, mode, today's spend and last run.
- **US2:** I open `/app/agents/@kira` and see: profile, skills, memory, history, playbook and plan (the last two arrive in
  020).
- **US3:** I rename an agent, change its handle, pause it, or run it now.
- **US4:** I enable or disable a built-in skill for this agent, choose "always in context" or "on demand", edit it (this
  creates an override for this agent), write a new skill, see a skill's version history and diffs, and roll back.
- **US5:** An agent improves its own skill. I get a notification with the diff and the reason. If the KPIs drop within
  7 days, it rolls back by itself and I am told.

## Functional requirements
| ID | Requirement |
|----|-------------|
| FR-001 | **Migration `049_agents.sql`** (additive, idempotent, records its version). <br>• `agents(id uuid pk, kind text check in (manager, builder, orchestrator, planner, ideator, idea_reviewer, executor, reviewer), scope text check in (system, network, resource), scope_id text, parent_id uuid fk agents null, name text, handle citext unique, emoji text, description text, mode text check in (off, shadow, live) default 'shadow', status text check in (active, paused) default 'active', paused_until timestamptz, model text null, reasoning_effort text null, schedule jsonb, daily_budget_usd numeric(8,4) null, shadow_until timestamptz null, created_by text check in (owner, builder, migration), created_at, updated_at)`. <br>• The handle matches `^[a-z][a-z0-9_]{2,31}$`. The handles `ai0`, `manager`, `all`, `owner` and `admin` are reserved. <br>• `editor_runs` gets `agent_id uuid null` plus an index on `(agent_id, started_at desc)`. |
| FR-002 | **Backfill**, inside the migration and idempotent. <br>• One `orchestrator` agent per `editor_channels` row: scope `resource`, scope_id `telegram:<channel_key>`, handle derived from the channel username (`@space_daily` → `space_daily`, with a `_2` suffix on collision), `mode` copied from the card. <br>• Under each orchestrator, child agents `planner`, `executor` and `reviewer` (`parent_id` = the orchestrator), which are today's roles. <br>• One `manager` (`@manager`, mode `off` until 021) and one `builder` (`@ai0`, mode `live`). <br>• The card's `mode` stays the source of truth for publishing in this spec; the agent's `mode` mirrors it on write. <br>• Existing runs are linked by `(role, channel_key)`. |
| FR-003 | **Runs carry `agent_id`.** `PgRunRecorder.start` takes `agentId`, and the scheduler resolves it from `(scope, kind)`. A paused agent (`status='paused'`, or `paused_until > now()`) is skipped by the scheduler with a `disabled` run record, at most one per day per agent. |
| FR-004 | **DB skills.** <br>• `skills(id uuid pk, name text, scope text check in (builtin, global, agent), agent_id uuid null, description, applies_to text[], body text, locked bool default false, safety bool default false, current_version int, created_by text check in (repo, owner, agent), created_at, updated_at)`, with `unique(name, coalesce(agent_id, '00000000-...'))`. <br>• `skill_versions(id bigserial, skill_id fk cascade, version int, body text, description text, applies_to text[], author text check in (repo, owner, agent), author_agent_id uuid null, reason text, kpi_baseline jsonb null, review_at timestamptz null, outcome text check in (pending, kept, rolled_back, superseded) null, created_at)`. <br>• `agent_skills(agent_id fk, skill_id fk, enabled bool default true, inline bool default false, primary key (agent_id, skill_id))`. |
| FR-005 | **Repo skills stay the baseline.** At boot `SkillSync` upserts every `editor-skills/*.md` as a `builtin` skill. A new repo version → a new `skill_versions` row with `author='repo'`. Agent overrides are **separate rows** (scope `agent`) and are not overwritten by a repo update, but the page shows "the built-in base changed since you forked it" with a diff. <br>• `safety: true` in the frontmatter marks system safety skills (`source-licensing`, `fact-check`, and the composer and executor workflow guard sections). Those can never be overridden by an agent. The owner can override them only with an explicit "I understand" confirmation. |
| FR-006 | **Skill resolution per run.** An agent's effective skill set is: <br>• builtin and global skills whose `applies_to` contains the agent's kind or role, <br>• minus the ones disabled in `agent_skills`, <br>• plus the agent's own (`scope='agent'`) skills. <br>An override replaces the builtin of the same name. `inline=true` skills go into the system prompt within the existing 8000-character budget; skills that do not fit are listed and loaded on demand with `load_skill`. `SkillLibrary` becomes an interface backed by DB, with the file loader kept for tests and the MCP server. |
| FR-007 | **Skill linter** (`lintSkill`), run on every write from any author. <br>• Frontmatter: `name` matches `^[a-z0-9-]{3,48}$`; `description` is 10–300 characters; `applies_to` contains known kinds only. <br>• Body: at most 12000 characters; for `inline`, at most 4000. <br>• **Blocked patterns** in any language (uk, en, ru): instructions to skip lint, guards, dedup or budget; to ignore earlier or system instructions; to reveal keys, tokens or the system prompt; to publish without lint; to impersonate a person; to contact third parties. Errors are returned as data. |
| FR-008 | **Agent self-edit tool** `propose_skill_edit({skill, body, reason})` for the orchestrator and reviewer of the same scope. <br>• It creates or updates an agent-scope skill for **its own agent or that agent's children** only. <br>• Refused when the skill is `locked`, `safety`, or owner-authored in its current version. <br>• Rate limit: at most 1 self-edit per agent per Kyiv day. <br>• It stores `kpi_baseline` (the scope's KPI snapshot, from 021's digest; until 021, the 7-day avg views/post) and sets `review_at = now() + 7 days`. <br>• It notifies the owner with a card (diff, reason, `[↩️ Відкотити]` `[🔒 Заблокувати скіл]`). Through 012 when it exists; until then, the admin-bot notification plus a dashboard inbox entry. |
| FR-009 | **Auto-rollback.** The daily `SkillVersionEvaluator` handles every version with `outcome='pending'` and `review_at <= now()`. It compares the scope's KPI with the baseline. <br>• If the primary KPI is down by at least 15% **and** the drop is outside the 28-day noise band (|z| ≥ 1.5): it restores the previous version, sets `rolled_back`, notifies the owner and writes an `avoid` memory entry with the reason. <br>• Otherwise it sets `kept`. <br>• A newer version supersedes the older pending one. |
| FR-010 | **REST**, behind TrackingAuthGuard: <br>• `GET /api/agents` (tree) <br>• `GET /api/agents/:handle` <br>• `PATCH /api/agents/:handle` (name, handle, emoji, description, schedule, budget, model, status, paused_until) <br>• `POST /api/agents/:handle/run` <br>• `GET /api/agents/:handle/runs?cursor=` <br>• `GET /api/agents/:handle/skills` <br>• `PUT /api/agents/:handle/skills/:name` (owner edit or override) <br>• `POST /api/agents/:handle/skills` (new) <br>• `PATCH /api/agents/:handle/skills/:name` (`enabled`, `inline`, `locked`) <br>• `GET /api/skills/:id/versions` <br>• `POST /api/skills/:id/rollback {version}` <br>• `GET /api/agents/:handle/memory` <br>Handle changes keep the old handle as an alias for 30 days, so the chat history and links keep working. |
| FR-011 | **Dashboard.** <br>• **`/app/agents`**: a tree and table (emoji, name, @handle, kind, scope, mode badge, status, today's spend, last run and its status). <br>• **`/app/agents/$handle`** with tabs: **Overview** (profile form, mode, schedule, budget, pause, run now), **Skills** (a list grouped as built-in, overridden, own; toggles; an editor with markdown preview and linter errors inline; versions with diff and rollback; a "base changed" banner), **Memory**, **History** (runs, with an expandable step trace reusing `/app/editor` components), **Playbook** and **Plan** (placeholders until 020). <br>• The sidebar entry "Agents" goes under Publishing. <br>• Follows `apps/dashboard/CLAUDE.md` and works at 375 px. |
| FR-012 | **MCP server**: read-only `list_agents`, `get_agent`, `list_skills`, `get_skill_versions`. |

## Corner cases
- **Two agents get the same handle in the backfill** → a deterministic suffix, logged.
- **The owner renames a handle that is referenced in chat history** → the alias table resolves old mentions for 30 days.
- **A repo update changes a builtin that an agent has overridden** → the override stays, and a banner offers a diff and
  "rebase to the new base".
- **An agent self-edits, then the owner edits the same skill before `review_at`** → the owner version wins. The
  pending agent version becomes `superseded`, with no rollback later.
- **The KPI data is missing at `review_at`** (the channel was paused, too few posts) → the review moves by 7 days, at
  most twice, then the version becomes `kept` with a note.
- **The linter catches a blocked pattern in an owner edit** → the edit is refused with the reason. The owner may force
  it with the "I understand" flag, except for the guard-bypass patterns.
- **The skill body is too long for inline** → it is saved as on-demand with a warning.

## Success criteria
- Unit tests:
  - handle validation and reserved names;
  - backfill idempotency (run twice);
  - effective skill resolution: override, disable, inline budget;
  - linter allow and deny tables in uk, en and ru;
  - self-edit rate limit and scope checks;
  - the rollback evaluator: drop, noise, missing data, superseded.
- A PG test for the migration and the backfill on the scratch DB.
- The dashboard builds and is checked in a browser against the mock API, including at 375 px.
- No behaviour change for existing channels: all editor tests and the existing evals pass unchanged.
