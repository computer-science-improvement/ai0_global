# 056 Network map

**Epic:** AI0-248 (T1–T4) · **Priority:** P2 · **Depends on:** 017–022, 025, 031, 049, 053 · **Status:** spec

## Why

The owner runs a network of agents, resources and posts. Today the dashboard shows these as separate lists: agents, Connections, Approvals, Network health and Spend. Nowhere can the owner see the whole network at a glance: who is working right now, where something waits for them, and how the channels feed each other.

The owner asked (2026-10-20) for a gamified view "like a StarCraft map or a mobile RPG": a mini avatar for each agent, and its actions visible as they happen.

This spec makes that map, with one rule: **every element means something and leads to an action**. The map is a decorative layer over real state, never a toy. The owner skipped the brainstorm; each design decision below is **my call**.

## The picture

| Game element | Real thing | Source |
|---|---|---|
| Territory | A network (resource group) | `meta_account_groups`, via `ResourceCatalog.list()` `groupId` |
| Unaffiliated land | Resources outside any group | catalog items with `groupId = null` |
| Building | A resource: a Telegram channel, IG, FB, Threads, TikTok or YouTube account | `ResourceCatalog.list()` |
| Headquarters | System agents (manager, builder), drawn at the centre | `agents` with `scope = 'system'` |
| Unit | An agent; its avatar stands next to its home building | `agents`; home = `scope_id` for resource agents, the network's anchor for network agents |
| Unit state | idle · planning · writing · reviewing · waiting · publishing · error · paused · off | derived (FR-002) |
| Road | Cross-promo, repost or duplicate flow between two resources | `promo_pairs` (30 days), `editor_slots.promo`, `derived_from_slot_id` + `treatment` |
| Minerals (top bar) | Today's AI spend against the daily caps | `budgetSnapshot()` |
| Alert beacon | Something waits for the owner at that building or unit | approvals waiting, directives awaiting the owner, network-health `stuck` and connection problems, launches waiting for Start |
| Event feed | The last 30 things that happened | runs, publishes, approvals, failures |
| Level | How well an agent writes (quality, never volume) | FR-005 |

## Requirements

### FR-001 Map snapshot API (T1)

`GET /api/map` (TrackingAuthGuard) returns one JSON snapshot:

```
{ generatedAt,
  budget:    { spentUsd, capUsd | null, pct | null, blocking: boolean },
  networks:  [{ id, name, anchorRef | null }],
  resources: [{ ref, platform, title, username, followers, groupId, health: ok|warning|broken|unknown, paused, postsToday, waiting }],
  units:     [{ id, handle, name, kind, emoji, parentId, homeRef | null, mode, effectiveMode, state, stateSince, detail, spentTodayUsd, capUsd, runsToday, lastRunAt, level }],
  roads:     [{ from, to, kind: promo|repost|duplicate, count30d, lastAt }],
  alerts:    [{ kind, count, ref | null, agent | null, title, path }],
  events:    [{ id, at, kind, agent | null, ref | null, text }] }
```

- It is built from the existing services: `ResourceCatalog`, `AgentsRepository.list()` + `activity()`, `budgetSnapshot()`, `NetworkHealthService.health()`, the approvals count, the directives awaiting the owner, open launches (052) and `promo_pairs`. Queries are batched, with no N+1 per agent.
- **Performance target:** under 300 ms on 100 agents and 50 resources. A 5-second in-memory cache is shared by all callers.
- Text in the snapshot is English (the dashboard shows it). Post text never appears in it; an event names the post by its slot topic only.
- **Events** come from the last 24 h:
  - run started, finished or failed (`editor_runs`);
  - post published (`editor_slots` status `published`, plus `platform_posts`);
  - post approved or rejected;
  - directive filed;
  - launch started or graduated.
  - The 30 newest, newest first. An event's `id` is stable across polls, so the client can animate only new ones.

### FR-002 Unit state (T1)

A pure function `unitState(agent, facts, now)`. The first rule that matches wins:

1. `paused`: `agents.status = 'paused'`, or `paused_until > now`, or the home resource is paused (025 pause).
2. `off`: the effective mode is `off`.
3. Running run (`editor_runs.status = 'running'` for this agent, started within 30 minutes):
   - role planner, orchestrator or manager → `planning`;
   - executor or composer → `writing`;
   - reviewer, checker or idea_reviewer → `reviewing`;
   - onboarder or builder → `planning`.
   - `detail` = the slot topic or the role.
4. `error`: the last finished run within 2 h ended in error, `budget_exceeded`, `max_steps` or `no_terminal`, or a slot of its resource failed within 2 h. `detail` = the error in one line.
5. `publishing`: a slot of its resource is `running`, or `approved` and due within 10 minutes.
6. `waiting`: an orchestrator whose resource has posts in `awaiting_approval`. `detail` = "N posts wait for you".
7. `idle`.

`stateSince` = when that condition started (run start, slot time…), or `lastRunAt` for idle.

Unit tests cover each rule and the order of precedence.

### FR-003 Map page (T2)

A new route `/app/map` in the nav (group Agents, icon `globe` or a new `map` icon, keywords map, game, network, overview).

**Layout:** deterministic, never a force simulation, so a building never moves between polls.

- Territories are rounded regions on a grid (largest network first).
- Buildings sit on a ring inside their territory, with the anchor Telegram channel in the middle.
- Unaffiliated resources share one "Frontier" territory.
- HQ is at the top centre and holds the system agents.
- Units stand around their home building: the orchestrator in front, its role children in a small arc behind it.

**Rendering:** SVG with CSS-variable colours (dark theme tokens only). The `motion` library, already a dependency, handles transitions. The network's real size (tens of nodes) suits SVG; GraphCanvas's canvas rule stays where it is. Pan by drag, zoom by wheel or pinch and buttons, and "Fit" re-centres. The map never scrolls the page horizontally.

**Building:**

- a platform glyph (Telegram, Instagram… from the icon set);
- the title;
- followers as a small number;
- a health ring: ok = accent, warning = warning, broken = danger;
- a beacon pulse when anything waits for the owner there;
- a hatched look when the resource is paused.

**Unit:**

- an avatar (FR-005) in a circle with a state ring coloured by state;
- a tiny state icon (pen = writing, magnifier = reviewing, map = planning, clock = waiting, send = publishing, warning = error, pause = paused);
- a gentle bob while working;
- greyed when off or paused.

**HUD:**

- **Top bar:** spend ("minerals") against caps, with a bar; runs today; posts today; the number of things that wait for the owner. That number is a button that opens a list of the alerts.
- **Right:** the event feed (FR-004), collapsible.
- **Bottom-left:** the legend (states and roads).

**Click:**

- **Building:** a side drawer with the resource, its health, today's posts, waiting items and links to the agent page, Approvals and Connections.
- **Unit:** a drawer with the agent: state and detail, mode, spend today against its cap, runs today, level and what it is made of. It links to the agent page, the agent's Artifacts tab and a chat with the agent (`/app/chat?agent=`). With spec 054 it also links to the Loadout tab.
- **Road:** promos in the last 30 days, the last one, and joins when tracked.

**Phone (< 640 px):**

- The map is shown fitted, with pan and zoom.
- The HUD collapses into one bar.
- The feed and the drawers become bottom sheets.

**Empty state:** no resources yet → a short "Connect a channel" with links to Connections and `/launch`.

**English text only.** Visual design follows `apps/dashboard/CLAUDE.md`.

### FR-004 Live updates and animations (T3)

- **Polling:** the page polls `/api/map` every 5 s while any unit is in a working state (planning, writing, reviewing, publishing), otherwise every 30 s. It stops while the tab is hidden.
- Between two snapshots the client diffs by stable ids:
  - **State change:** the unit's ring changes colour with a short pulse. Entering `writing` shows a small pen spark; entering `publishing` shows a paper plane flying from the unit to its building.
  - **New published event:** a flare over the building and a "+1 post" floater.
  - **New promo event:** a dot travels along the road.
  - **New error:** the unit shakes once and the feed line is red.
  - **New alert:** the beacon starts pulsing and the alert counter bumps.
- Every animation is under 1.2 s and runs only on new events. Nothing animates on the first load. `prefers-reduced-motion` turns off all motion except colour changes.
- **Event feed:** newest first; each line has the unit's avatar, its text and its time. Clicking a line focuses the unit or building.

### FR-005 Avatars and levels (T4)

**Avatar:**

- A deterministic pixel-style avatar generated in SVG from a hash of the handle: an 8×8 symmetric sprite, a colour from a fixed palette of CSS chart/tg variables, and the agent's kind as the silhouette accessory (e.g. a quill for executor, a scroll for planner, glasses for reviewer, a crown for manager).
- The agent's `emoji`, when set, is shown as a badge on the avatar.
- No image generation and no external assets.

**Level:** quality, never volume. Volume-based XP would reward spam.

- Score per orchestrator over the last 30 days:
  - clean approvals (approved without edits);
  - published posts whose critic verdict was `pass`;
  - minus rejected posts and failed runs.
- Level 1–10 = `clamp(1, 10, 1 + floor(score / 10))`, where score = `clean*1 + pass*1 − rejected*2 − failedRuns*1`.
- Role children show their orchestrator's level.
- The unit drawer explains the level in one line ("12 clean approvals, 18 critic passes, 1 rejection in 30 days").
- Computed in the snapshot (FR-001) with one grouped query.

## Non-goals

- Editing anything on the map. The map links to the pages that edit.
- Real-time push (SSE or WebSocket): polling is enough for the network's size. SSE can come later.
- Leaderboards, achievements, sounds.
- Changing `/app/graph` (the tracked ad graph). It stays.

## Tasks

- T1: `GET /api/map` (FR-001) with `unitState` (FR-002), events, roads, alerts, the cache and the level score (FR-005 backend); unit tests for the state rules and the level, and a PG test for the snapshot queries on the scratch DB.
- T2: the `/app/map` page (FR-003): layout, buildings, units, roads, HUD, drawers, legend, phone, nav entry, mocks and a browser check.
- T3: live updates and animations (FR-004), feed, reduced motion.
- T4: avatars and levels on the page (FR-005).

Each task ends green: automation `npm test` + `npm run build` on Node 20; dashboard `npx tsc --noEmit` + `npm test` + `npm run build`.
