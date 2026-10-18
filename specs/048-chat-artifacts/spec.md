# 048 Chat workspace and artifacts

**Epic:** AI0-181 (T1–T8 = AI0-208…215) · **Priority:** P1 · **Depends on:** 042, 045, 047 · **Status:** in progress (design approved by the owner 2026-10-18)

## Why

Review 2 (`docs/reviews/2026-10-17-agent-review-2.md`) and the owner's requests on 2026-10-17:

- **Pages that should be chat.** Setup from history (042) and steering (045) each have their own page and form. The owner wants to start them in the chat, as `/setup` and `/steer`, and to see the result there.
- **Everything that shapes an agent is scattered.** Each lives in its own place:
  - the setup proposal and the steering set on their pages;
  - owner rules and memory under the agent's Memory tab;
  - skills under Skills;
  - the playbook under Playbook;
  - the profile and formatting in the overview.

  There is no single list. Only skills, playbooks and profiles keep versions.
- **Chat output you can't revisit.** When the agent changes one of these things in the chat, the thread shows a line of text. There is nothing to open, edit or compare with the version before.
- **The chat page.** The owner: "the chat looks bad; it should be like Claude". The app menu takes the left side, the thread is squeezed, and there is no room for a side panel.

## Terms

An **artifact** is a typed thing that shapes an agent. The types:

| Type | Source of truth | Id | Versions |
|---|---|---|---|
| `setup` | `channel_setup_proposals` | proposal id | `artifact_versions` (new) |
| `steering` | `steering_sets` | set id | `artifact_versions` (new) |
| `rules` | the channel's owner rules: `editor_channel_memory` rows by the owner, without approval preferences | channel key | `artifact_versions` (new): a snapshot of the rule list |
| `memory` | the channel's other active memory (reviewer insights, approval preferences) | channel key | none (read only; the owner can retire a line) |
| `skill` | `skills` | skill id | `skill_versions` (existing) |
| `playbook` | `playbooks` (one active per agent) | agent id | the `playbooks` rows (existing) |
| `profile` | `resource_profiles.profile` | resource ref | `resource_profile_versions` kind `profile` (existing) |
| `formatting` | `resource_profiles` format prefs | resource ref | `resource_profile_versions` kind `format` (existing) |

Each type keeps its own table. The registry is a read model with one adapter per type, so no data moves.

## Requirements

### FR-001 Artifact registry and API (T1, AI0-208)

**Endpoints** (all behind the usual auth guard):

- `GET /api/artifacts?type=&agent=&channel=&status=&limit=` returns compact rows `{type, id, title, agent, channel, target, status, version, updatedAt, summary}`, newest first.
- `GET /api/artifacts/:type/:id` returns `{row, body, versions: [{version, author, reason, createdAt}], actions: [...]}`. `actions` lists the actions the artifact allows right now, e.g. `activate`, `pause`, `discard`, `apply`, `edit`.
- `GET /api/artifacts/:type/:id/versions/:v` returns that version's body, so the dashboard can diff two versions.
- `PATCH /api/artifacts/:type/:id` is a hand edit by the owner. It uses the type's existing validation:
  - steering rule lint and copy guard;
  - owner-rule lint (047 T4);
  - skill lint;
  - playbook validation;
  - the profile schema.

  It writes a new version with author `owner`. A refused edit answers 400 with the type's issue codes.
- The type's own actions (activate, pause, discard, apply sections) keep their existing endpoints. The artifact API links to them; it does not copy them.

**Versions.** New table `artifact_versions(id, type, ref_id, version, body jsonb, author owner|agent|system, agent_id, reason, created_at, UNIQUE(type, ref_id, version))`, in migration 084.

- It serves `setup`, `steering` and `rules`.
- A version is written when an artifact is created (version 1) and on every change, whether by the owner or an agent, through the API or a card.
- Existing rows get version 1 on their first read (lazy backfill), not in the migration.

**Statuses** shown on the row are the type's own: a setup proposal's status, a steering set's status, `active` for rules and memory, the skill's enabled state, the playbook's status.

### FR-002 Artifact tools for agents (T2, AI0-209)

When the owner says "drop rule 3", "make the hooks shorter" or "add a rule about emoji" about an artifact in the thread, the agent has two chat tools:

- **`get_artifact(ref)`** (read). `ref` is `type:id`, or a type with the chat's channel (`rules`, `steering`). It returns the body, the version and the allowed actions.
- **`update_artifact(ref, patch, reason)`** (act). The patch is per type:
  - **steering:** rule edits (enable / disable / text), adding a rule, removing a rule;
  - **rules:** add, edit or retire a line;
  - **skill:** a new body;
  - **playbook:** a playbook patch;
  - **profile / formatting:** field changes.

  The type's validation runs first, and a refusal comes back as the tool's error.

**When a change applies** (owner decision, 2026-10-18):

- **A live artifact goes through a card.** This covers an active steering set, the channel's rules, an active playbook, a skill attached to the agent, and a profile. The change becomes an `update_artifact` card with Apply / Discard. Apply writes the new version.
- **A draft changes at once.** Drafts are a setup proposal before apply, a steering set in `ready` or `paused`, and a pending playbook. The change writes a new version with author `agent`.

Existing tools such as `add_owner_rule`, `edit_my_skill` and `propose_skill_edit` stay. They also write `artifact_versions` rows where their type uses that table.

### FR-003 Slash commands (T3, AI0-210)

- **`/setup @channel`** queues the 042 analysis for one of our channels (the same checks as `analyze_channel_history`). The thread gets a message with the setup artifact chip in status `queued`, and the chip follows the status to `ready`.
- **`/steer @ours @reference`** (or a `t.me` link as the reference) creates a 045 steering set (the same checks as `steer_channel`). The thread shows the steering artifact chip.
- **`/rules [@channel]`, `/skills [@agent]`, `/memory [@channel]`** answer with the list of the matching artifacts as chips.
- **`/help`** lists the commands.

Commands run in code; no LLM turn and no cost. A wrong argument gets a one-line answer with the usage.

Typing `/` at the start of the composer opens a command menu (like the `@` mention menu) with each command, its arguments and a one-line description. Arrow keys, Enter and Escape work as in the mention menu.

### FR-004 Chat layout (T4, AI0-211)

- **Desktop.** On `/app/chat` the app menu collapses to the 64 px icon rail (owner decision).
  - The rail's own toggle opens the full menu for this page. The choice is remembered per viewer (`dashboard:chat-nav`), separately from the global collapse setting.
  - The chat page drops the shell's max width and padding. Three columns:
    - left: the chat list (new chat, search, chats grouped by date; scheduled drafts under them);
    - centre: the thread, at a readable max width (760 px), with the composer pinned at the bottom;
    - right: the artifact panel when one is open (FR-005).
- **Mobile.** The chat list is a drawer and the artifact panel is a full-screen sheet.
- **Other pages.** The app menu is unchanged.

### FR-005 Artifacts in the thread (T5, AI0-212)

- **Message → artifact link.** Messages get a column `editor_chat_messages.artifacts jsonb` (`[{type, id, version}]`, migration 084).
  - The turn recorder writes the artifacts the turn's tools created or changed: `steer_channel`, `analyze_channel_history`, `update_artifact`, `add_owner_rule`, `edit_my_skill`, and the slash commands.
  - A card's artifact is linked when the card is applied.
- **Chip.** A message shows one compact chip per artifact: type icon, title, status and version. The chip reads the artifact's current state, so its status updates (a setup going from `analyzing` to `ready`).
- **Side panel.** Clicking a chip opens the right-side panel with:
  - the artifact's details (reusing the setup proposal body and the steering details);
  - hand editing (FR-001 PATCH);
  - its actions;
  - the version list, with a diff of each version against the one before (reusing the line diff of the skills versions);
  - **Ask the agent**, which puts a reference to the artifact (`[[steering:<id>]]`) and the cursor into the composer.

  The agent reads a reference like that with `get_artifact`.

### FR-006 Artifacts page (T6, AI0-213)

`/app/artifacts` shows every artifact as a compact card (`CompactCard`).

- **Filters:** type, channel / agent and status, kept in the URL (`?type=steering&channel=@x&status=active`).
- **Card:** type, target, status, version and date.
- **Dialog:** the same content as the side panel, plus **Open in chat**. That opens the chat that made the artifact, or a new chat with the right agent and the artifact referenced.
- **Empty state per type** names the command that creates it, e.g. "Type `/steer @yours @theirs` in the chat".
- **Menu:** "Artifacts" in the Agents group.

### FR-007 Agent page (T7, AI0-214)

- **Artifacts tab.** The agent page gets an **Artifacts** tab: the FR-006 list filtered to the agent and its channel. The Skills, Memory and Playbook tabs stay for now (owner decision); merging them is a later task.
- **Overview line.** The Overview shows one line, e.g. "Setup from history: applied 16 Oct · Steering: 1 active from @ref · Rules: 6", linking to the filtered tab. It replaces the separate steering line.

### FR-008 Remove the setup and steering pages (T8, AI0-215)

- **Redirects.**
  - `/app/setup` → `/app/artifacts?type=setup`, and `?proposal=<id>` opens that artifact.
  - `/app/steering` → `/app/artifacts?type=steering`, and `?set=<id>` opens that artifact.
- **Menu.** The `channel-setup` and `steering` entries go; `artifacts` takes their place.
- **Unchanged.** The @ai0 tools `analyze_channel_history` and `steer_channel` stay; the commands call the same code. Their `link` points to the artifact.
- **Docs.** The runbook `docs/runbooks/agent-platform.md` §9–10 and `specs/README.md` are updated.

## Out of scope

- Merging the Skills / Memory / Playbook tabs into Artifacts.
- Artifacts for directives, ideas and data schemas. They have their own pages and flows.
- Collaborative editing, or comments on an artifact.

## Acceptance

- `/steer @ours @ref` in the chat creates a steering set. Its chip shows `queued`, then `ready`.
  - Opening the chip shows the rules.
  - "drop rule 3" makes the agent change the draft at once, as version 2.
  - Activate makes it live. A later "make the hooks shorter" on the live set comes as an Apply / Discard card, and Apply writes version 3.
- Hand edits that break the type's validation are refused with the reason.
- `/app/artifacts?type=steering` lists the set, and the agent page's Artifacts tab shows it.
- `/app/setup?proposal=<id>` lands on that proposal in Artifacts.
- On `/app/chat` the app menu is the icon rail, and the thread and panel fit a 1280 px screen.
