# 078 tasks

Paths are relative to `apps/dashboard/src` unless they start with `apps/`, `docs/` or `specs/`. Each agent reads `spec.md` (lead decisions first), its research brief(s) in full (Skeptic sections included), the handoff section, and the prototype it builds.

**Owns** = files only this agent edits in its wave. **Appends** = small, local additions to a shared file (no reordering, no reformatting).

---

## Wave A (parallel)

### A1 Foundation — tokens, status system, global CSS, shared primitives
Brief: `research/design-language.md` (all). Handoff §1, §1.1, §2. Prototype CSS of all four app prototypes.
Owns: `index.css`, `components/ui/*` (except new files other agents add), `SegmentedTabs.tsx`, `Modal.tsx`, `Pagination.tsx`, `lib/status-tone.ts` (new), `lib/useReducedMotion.ts` (new), the six recharts files (animation flag only), `editor/EditorUi.tsx` (tone maps only), `routes/app.index.tsx` (only its local slot tone map → status-tone), `routes/app.landing.tsx` / `routes/app.logs.tsx` (reduced-motion guards only), the 13 hard-coded mono stacks, `data/SchemaEditor.tsx:181`, `apps/dashboard/CLAUDE.md`.
Must NOT edit: `AppShell.tsx`, `AppSidebar.tsx`, `nav/*` (A2), `api/*` (A3).
- [ ] A1.1 Tokens (D1): ink-dim/muted, `--font-mono`, `--color-on-warning`, shadow and motion tokens, `.text-heading-md`, `.mono`, `.text-overline`, `.page-title`; replace hard-coded mono stacks; `--shadow-2` defined.
- [ ] A1.2 Status system (D2): `lib/status-tone.ts` (slot + publication tones, labels, `isMissed`, with node tests pinning the backend prefix lists), `ui/StatusMark.tsx`, MODE_TONE remap + MODE_OPTIONS tones, replace the local maps in `app.index.tsx` and `EditorUi.tsx` (and `app.scheduled.tsx` STATUS_TONE).
- [ ] A1.3 Global CSS restyle (D3, brief §3–§4): buttons, focus, links, inputs, panel/card/section-head, stat-tile, empty-state, callouts, chip, tabs-pill → track, table-wrap, modal shell, nav-link/nav-badge (classes only; A2 changes the markup), cmdk-trigger/kbd/crumbs, new layout classes (`.panel-head`, `.panel-row`, `.panel-foot`, `.panel-link`, `.inset`, `.code-block`, `.sev*`, `.pill-live`, `.chip-toggle`, `.btn-warning`, `.stat-strip`, keyframes `fade-up`, `pop`, `slide-left`, `pulse-ring`, `grow-x`, `grow-y`), global reduced-motion block, `@media (hover:none)` reveals; delete dead `.nav-item` / `.btn-translucent`.
- [ ] A1.4 Primitives: `PageHeader` (eyebrow, `.page-title`), `SectionCard` (`flush`, `is-section`, `.panel-link` action), `StatTile` (`spark`, sentence-case label) + `StatStrip` + `Sparkline`, `Badge` 11/600, `EmptyState` `tone`, `SeverityPill` + `LivePill`, `SegmentedTabs` (`count`, `tone`, `variant: 'track'|'underline'`, `size: 'sm'|'md'|'lg'`), `Toast` (div item, optional `{action, ttlMs}`, backward compatible), `Modal` (`size: 'drawer'`, bottom sheet ≤600, hairlines, quiet close), `usePrefersReducedMotion` + `isAnimationActive` in the six charts, chart tooltip radius → token.
- [ ] A1.5 Docs: `apps/dashboard/CLAUDE.md` (D3 list), index.css comments; a short "Design language" section at the top of CLAUDE.md that wave C agents will follow (page header + eyebrow, flush panel rows, StatStrip, track tabs with counts, StatusMark vs Badge, mono usage, no literal hex/px radius, ≥11px text).

### A2 Navigation, sidebar and top bar
Brief: `research/nav.md` (all, Skeptic sections override). Handoff §3. Prototype: the `aside.side` and `.top` parts of `App-Today.dc.html`.
Owns: `nav/*` (+ tests), `AppSidebar.tsx`, `components/nav/*` (new `components/nav/sidebar.css` for sidebar-only classes; `.nav-link`/`.nav-badge` base classes are A1's), `AppShell.tsx`, `CommandPalette.tsx` (only if needed for hidden pages), `settings/NavigationTab.tsx` (copy + legacy groups), `apps/automation/src/settings/nav/*`.
Appends: `components/ui/Icon.tsx` (an `ellipsis` icon name if needed).
- [x] A2.1 Registry (D4): group retitles + `legacy` flag, order, labels, `calendar` entry, hiddenByDefault list, re-pointed defaultGroups, `subview` flag, agents badge → `directives`, BadgeKey `agents` removed; tests.
- [x] A2.2 Badges: Inbox = unread + approvals (tone/title), `COVERS`, `rollup` no double count; tests.
- [x] A2.3 Schema v2: `NAV_SCHEMA_VERSION = 2`, `MIGRATIONS[1]` per D4 (shape-tolerant), literal `1`s replaced, server `NAV_SCHEMA_MAX = 2` + its tests; migration tests with frozen v1 fixtures.
- [x] A2.4 Sidebar: group titles as `.nav-group-title` (no title over Home), active = longest visible prefix, More tools (button disclosure, chips with counter dots, localStorage, auto-open, rail menu), rollup dot moves to More tools, footer (AI budget card, operator row with Log out moved from the header, env pill when `VITE_ENV_LABEL`), width 248.
- [x] A2.5 Top bar: ⌘K field, "N agents live" pill, New post → `/app/compose`, main padding/max-width; mobile header keeps the hamburger and its rollup dot.

### A3 Inbox actions — backend gaps + kinds library + NoteActions
Brief: `research/inbox.md` (all, Skeptic sections override), `research/today.md` (skeptic notes about CTAs). Handoff §5.2.
Owns: `apps/automation/src/editor/agents/owner-inbox.ts`, `apps/automation/src/editor/series-pause/*`, `apps/automation/src/editor/agents/agents.controller.ts` / `agents.service.ts` (inbox + series-pauses parts), their tests; dashboard `lib/inbox-kinds.ts` (new) + `lib/inbox-ref.ts` (new) + tests, `components/inbox/NoteActions.tsx` (new).
Appends: `api/agents.ts` (types + hooks `useInboxAction`, `usePauseSeries`, `useMarkInboxUnread`; `useResumeSeries` also invalidates `['agents','inbox']`).
Must NOT edit routes or `index.css`.
- [ ] A3.1 Gap #1: `InboxItem.subject/parts/actions` with English `actionView`; `OwnerInbox.get(id)`; tests.
- [ ] A3.2 Gap #2: `POST /api/agents/inbox/:id/actions {key}` (stored-key check, 404/400 codes), `via` threaded through `pause-actions.ts`, outcome `code`, dashboard resolutions count for the A10 demotion; tests (unit + PG where the brief points).
- [ ] A3.3 Gap #3 + mark-unread: series-pauses `{action:'pause', key, label}`; `POST /api/agents/inbox/unread {ids}`; tests.
- [ ] A3.4 `lib/inbox-kinds.ts` + `lib/inbox-ref.ts`: every kind → why / primary / secondary descriptors (links and operations), ref parsing, handle resolution; node tests incl. every kind in the brief's list.
- [ ] A3.5 `components/inbox/NoteActions.tsx` (+ api hooks): runs descriptors, marks read after decisions, invalidates inbox + badges, English toasts, shows server error codes; handles missing handle / missing endpoint gracefully (link fallback).

### A4 Mock API for visual QA (scratchpad only, never committed)
Owns: `<scratchpad>/rdmock/` only. No repo edits at all.
- [ ] A4.1 `server.mjs <distDir> [port=3178]`: serves the built dashboard (SPA fallback) and answers every GET the dashboard makes (derive the list from `api/*.ts` and route files) with realistic fixtures: 6 orchestrators (+ manager, sysadmin, builder, roles), editor channels and today's plans (all slot statuses, missed series slots, reserved), 5-day schedules, inbox notes of every kind/severity with actions, approvals, directives, chat cards, map snapshot with events, spend summary/breakdown/budgets, network health, tracking channels, meta accounts, scheduled posts, agents' detail endpoints, landing public endpoints, nav config/badges/attention. Stateful for: inbox read/unread/actions, nav config PUT/DELETE, mode switches, scheduled post create/cancel, series pause/resume. Unknown `/api/*` → 404 JSON (pages must survive it). `/auth/me` → a dev owner.
- [ ] A4.2 `README.md`: how to start, the fixture knobs (`?empty=1` style switch or env to serve empty states), and the endpoint list.

---

## Wave B (parallel, after A is merged)

### B1 Today — `routes/app.index.tsx`
Brief: `research/today.md`. Handoff §4. Prototype `App-Today.dc.html`.
Owns: `routes/app.index.tsx`, `components/overview/*`, new `components/today/*` (DayTimeline, SlotRing, NeedsYouList, ActivityList, AgentsPanel), `lib/today.ts` (+tests), `lib/useNow.ts` (moved from map), `api/map.ts` (`useMapSnapshot`) + `map/MapPage.tsx` (switch to the hook only).
- [ ] B1.1 Header (eyebrow date/time Kyiv, greeting, "N things need you", severity pills) + Needs you (D6) with NoteActions, Dismiss + Undo toast, All clear.
- [ ] B1.2 Glance (SlotRing, runs, AI budget, busiest channel) + DayTimeline (D6) + legend; tests for 0 / 15+ slots / superseded hidden.
- [ ] B1.3 Agents panel (ModeSwitch by channel, live via AutonomyDialog) + Live activity (useMapSnapshot) + KPI strip with sparkline + health link line; remove the legacy blocks and dead components.

### B2 Inbox — `routes/app.agents_.inbox.tsx`
Brief: `research/inbox.md`. Handoff §5. Prototype `App-Inbox.dc.html`.
Owns: `routes/app.agents_.inbox.tsx`, new `components/inbox/*` except `NoteActions.tsx` (A3's; fix bugs in it only with a note in Deltas).
- [ ] B2.1 Tabs + Unread only + search params (legacy mapping) + list with severity marks, grouping by subject, counts.
- [ ] B2.2 Detail pane (D6) + bottom sheet ≤860 + Mark as done / Mark all as done + Undo.
- [ ] B2.3 To approve tab around `ApprovalList`; deep links (`note=`), InboxLinks preserved; empty states.

### B3 Agent detail — `routes/app.agents_.$handle.tsx`
Brief: `research/agent.md`. Handoff §6. Prototype `App-Agent.dc.html`.
Owns: `routes/app.agents_.$handle.tsx`, `components/agents/*` (AgentsUi restyle, AgentOverview, header pieces, new `lib/agent-tabs.ts` + tests, `lib/mode-hints.ts`), `health/NetworkHealthView.tsx` (AgentLink tab type only).
- [ ] B3.1 Tab groups (leaf `?tab=` → group; second level; `settings` leaf) + every existing link verified.
- [ ] B3.2 Header (glyph xl, meta line, big mode switch + kind-aware hint, Run now / Chat / More) + pause banners (series + resource).
- [ ] B3.3 Overview (KPI strip, Today step by step, Channel + How posts look summaries) + Settings leaf content.

### B4 Calendar — `routes/app.calendar.tsx`
Brief: `research/calendar.md`. Handoff §7. Prototype `App-Calendar.dc.html`.
Owns: `routes/app.calendar.tsx`, new `components/calendar/*`, `lib/calendar.ts` (+tests), `post/PostComposer.tsx` (drawer mode + validation timing), `nav/legacy-redirects.test.ts`.
Appends: `AppShell.tsx` (New post target only), `api/*` hooks if missing.
- [ ] B4.1 Week grid (rows = orchestrators + Other channels; 5 days; nav; chips with StatusMark; not-planned chips; click targets).
- [ ] B4.2 Composer drawer (`?compose=new&channel=&day=`), validation after submit/blur, Ask the agent (pin rule or disabled), Undo toast.
- [ ] B4.3 New post button → drawer; legacy redirect test; empty/404 states.

### B5 Landing — `/` and `/white-label`
Brief: `research/landing.md`. Handoff §8. Prototype `Main.dc.html`.
Owns: `routes/index.tsx`, `routes/white-label.tsx`, `components/landing/*` except the four admin cards (`CtaStatsCard`, `LeadsCard`, `NetworksCard`, `PublicPageCard`), `lib/landing-view.ts` (+tests).
- [ ] B5.1 Hero (headline words, orbit, agent log, stats) + channel marquee.
- [ ] B5.2 Role explorer, loop ring + guard track, approval deck, ad steps, shadow/live demo, network showcase hover; CTA/leads/beacon unchanged.
- [ ] B5.3 Motion rules (off-screen pause, reduced motion, no-JS), "| DEV" removal, 375px.

---

## Wave C (parallel, after B is merged) — pages without a prototype
Brief: `research/other-pages.md` §3 (per page) and §5 (batches); CLAUDE.md "Design language" (A1.5). Frozen: `ui/*`, `index.css`, `SegmentedTabs`, `Modal`, `Pagination`, `nav/*`, `AppSidebar`, `AppShell`, chart files, `GraphCanvas`, `agents/AgentsUi`, `approvals/*`, `overview/*`, `today/*`, `inbox/*`, `calendar/*`, `landing/*` public parts. Page CSS goes into an area file (e.g. `components/connections/connections.css`).

- [ ] C1 Channels & intelligence: channels, channels_.$id, tracked, analytics, discovery, recommendations, graph (+ their owned components per brief §5).
- [ ] C2 Connections, health & map HUD: connections, connections_.groups, connections_.meta_.$accountId, health, map HUD only.
- [ ] C3 Publishing & spend: editor, editor_.$channel, editor_.run.$id, editor_.slot.$id, scheduled, compose, logs, spend.
- [ ] C4 Agents config & system: agents, models, dm, settings (+ settings/*, models/*, strategies/MigrationBanner).
- [ ] C5 Chat & artifacts: chat, artifacts (+ chat/*, artifacts/*, nav/NeedsYou).
- [ ] C6 Data, ads & public: data, data_.$key, ads, landing (admin), login, report.$token, app.tsx auth screens, NotFound (+ data/*, landing admin cards).

---

## Lead (after each wave)
- [ ] Merge in order (A: A1 → A3 → A2; B: B1 → B2 → B3 → B4 → B5; C: C1…C6), resolve conflicts, full suites under Node 20.
- [ ] Browser pass on the A4 mock (1280 / 375, reduced motion), fix or send back.
- [ ] Adversarial review of the merged diff; fixes.
- [ ] Runbook § 31 (nav v2 migration behaviour, `VITE_ENV_LABEL`, what moved where), specs README row, docs/ui-inventory.md refresh, spec status.

## Status
(filled in per commit)

### A2 Navigation, sidebar and top bar (branch `worktree-wf_9569abf2-5cb-2`, base `8492e74f`)
- A2.1 `54aecc4f` registry: 11-item default menu in Home, Network, Insights and System.
- A2.2 `5cd297b9` badges: the Inbox counts unread notes plus posts to approve; `rollup` stops double counting.
- A2.3 `fbbd00d1` schema v2 and the v1 to v2 migration (client and server); `3d6f226d` follow-up: a stored v1 group title that is just the v1 default is not a rename.
- A2.4 `109716bc` sidebar: group titles, longest-prefix active item, More tools, footer, width 248.
- A2.5 `1d8ead75` top bar: wide search field, N agents live pill, New post, main padding and max-width.

## Deltas from the spec
(each agent appends its own subsection)

### A2
- **Registry:** `network-map` no longer lists `agents` or `overview` among its keywords (the ⌘K query "agents" must land on Agents, not Map). Group order is the `NAV_GROUPS` array order; item order inside a group is the `NAV_REGISTRY` order. The five legacy groups stay in `NAV_GROUPS` (`legacy: true`) so a saved menu still resolves their titles; `DEFAULT_GROUPS` is what the default menu uses. Sub-view entries (`subview: true`) are `hiddenByDefault` and stay out of More tools.
- **Migration keeps less than a naive reading of D4 suggests, by design:** order inside built-in groups and moves between built-in groups are dropped; pages the owner left visible get the v2 placement (the redesign decides which 11 are in the menu). A built-in group's stored title is kept only when it differs from the frozen v1 built-in title (a menu saved with all nine titles spelled out would otherwise keep "Agents" and "Analytics" over the new menu; found on the mock). A custom link that sat in a built-in group stays in it when the group survives (Home, Network, Insights, System) and is hidden otherwise (More tools lists it, last). Ids that are no longer pages are dropped, not parked. A badge override `badge: false` on `approvals` is carried but no longer matters: the posts-to-approve count lives in the Inbox counter.
- **Server and client ship together:** `NAV_SCHEMA_MAX = 2` accepts v1 and v2; a v2 build saving against a server that still has max 1 gets a 400 (`invalid_nav_config`). Deploy automation first or in the same release. Until the owner edits the menu, the stored row stays v1 and is migrated on every render (idempotent).
- **Sidebar footer layout differs from the prototype in three places, all to keep More tools reachable in an 800px window:** the collapse button moved to the header (next to the logo), Edit menu became an icon button in the operator row (next to Log out), and short windows get a denser menu (`max-height: 860px` shrinks rows and group titles; `max-height: 680px` hides the budget card).
- **The budget card does not use `BudgetBar`:** its header (label, state badge, amounts on one row) does not fit the 192px of the card (the label truncated to "AI budg" and the badge squeezed to a circle on the mock), and it prints `<label> today` as the meter's aria-label, which would read "AI budget today today". The card draws its own meter from `barPct`, `budgetBarColor`, `budgetBadge` and `fmtUsd` (`lib/spend.ts`); the state shows as the bar color and in the tooltip. `AiSpendCard.tsx` is untouched.
- **"N agents live" shows only when at least one editor channel is in live mode** (a "0 agents live" pill in the live green would be wrong). It is a plain pill, not a link. The ⌘K field says "Search pages and actions..." (the palette searches pages and actions, not agents or posts).
- **More tools:** chips support right click (Pin, Edit in menu settings); there is no long press on touch, pins from the constructor or ⌘K still work. The rail's menu lists the same pages with counters; the rail version is what the chat page shows by default. Opening the list scrolls it into view.
- **Active item** is computed by the sidebar (`activeItemId`), and the router is told to match exactly so it adds no second highlight. It uses the router's `location.search`, like the Link did, so Channels (`?filter=mine`) lights once the route's own redirect has added the default params (a blink on a direct load of `/app/channels`).
- **Files outside A2 ownership:** `api/nav.ts` (the `NavConfigV1` to `NavConfig` type rename, one line), `components/ui/Icon.tsx` (appended `ellipsis`, `logout`; a second import line from lucide-react), `lib/env.ts` (appended `ENV_LABEL`). `VITE_ENV_LABEL` is read at build time only; no CI or Docker change was made, so no environment shows the pill until the build arg is set.
- **For B2 (Inbox):** the Inbox menu entry still has no `search`, so it opens on the Unread tab; when the counter is made of approvals only, the owner lands on an empty Unread list (`?tab=approvals` holds them). The page title and breadcrumb parent ("Agents") are unchanged.
- **For the merge with A1:** the sidebar relies on A1's `.nav-link`, `.nav-link-active`, `.nav-badge`, `.nav-dot`, `.btn-icon`, `.btn-ghost`, `.cmdk-trigger` and `.kbd`. `components/nav/sidebar.css` adds only tone modifiers (`.nav-badge.nav-badge-*`, which set colors outright), layout and the footer; `components/nav/shell.css` overrides the trigger's width only at 861px and up (`.topbar .cmdk-trigger`). Check both against A1's restyle (row height 40px makes the short-window rule matter more).
