# 078 tasks

Paths are relative to `apps/dashboard/src` unless they start with `apps/`, `docs/` or `specs/`. Each agent reads `spec.md` (lead decisions first), its research brief(s) in full (Skeptic sections included), the handoff section, and the prototype it builds.

**Owns** = files only this agent edits in its wave. **Appends** = small, local additions to a shared file (no reordering, no reformatting).

---

## Wave A (parallel)

### A1 Foundation — tokens, status system, global CSS, shared primitives
Brief: `research/design-language.md` (all). Handoff §1, §1.1, §2. Prototype CSS of all four app prototypes.
Owns: `index.css`, `components/ui/*` (except new files other agents add), `SegmentedTabs.tsx`, `Modal.tsx`, `Pagination.tsx`, `lib/status-tone.ts` (new), `lib/useReducedMotion.ts` (new), the six recharts files (animation flag only), `editor/EditorUi.tsx` (tone maps only), `routes/app.index.tsx` (only its local slot tone map → status-tone), `routes/app.landing.tsx` / `routes/app.logs.tsx` (reduced-motion guards only), the 13 hard-coded mono stacks, `data/SchemaEditor.tsx:181`, `apps/dashboard/CLAUDE.md`.
Must NOT edit: `AppShell.tsx`, `AppSidebar.tsx`, `nav/*` (A2), `api/*` (A3).
- [x] A1.1 Tokens (D1): ink-dim/muted, `--font-mono`, `--color-on-warning`, shadow and motion tokens, `.text-heading-md`, `.mono`, `.text-overline`, `.page-title`; replace hard-coded mono stacks; `--shadow-2` defined.
- [x] A1.2 Status system (D2): `lib/status-tone.ts` (slot + publication tones, labels, `isMissed`, with node tests pinning the backend prefix lists), `ui/StatusMark.tsx`, MODE_TONE remap + MODE_OPTIONS tones, replace the local maps in `app.index.tsx` and `EditorUi.tsx` (and `app.scheduled.tsx` STATUS_TONE).
- [x] A1.3 Global CSS restyle (D3, brief §3–§4): buttons, focus, links, inputs, panel/card/section-head, stat-tile, empty-state, callouts, chip, tabs-pill → track, table-wrap, modal shell, nav-link/nav-badge (classes only; A2 changes the markup), cmdk-trigger/kbd/crumbs, new layout classes (`.panel-head`, `.panel-row`, `.panel-foot`, `.panel-link`, `.inset`, `.code-block`, `.sev*`, `.pill-live`, `.chip-toggle`, `.btn-warning`, `.stat-strip`, keyframes `fade-up`, `pop`, `slide-left`, `pulse-ring`, `grow-x`, `grow-y`), global reduced-motion block, `@media (hover:none)` reveals; delete dead `.nav-item` / `.btn-translucent`.
- [x] A1.4 Primitives: `PageHeader` (eyebrow, `.page-title`), `SectionCard` (`flush`, `is-section`, `.panel-link` action), `StatTile` (`spark`, sentence-case label) + `StatStrip` + `Sparkline`, `Badge` 11/600, `EmptyState` `tone`, `SeverityPill` + `LivePill`, `SegmentedTabs` (`count`, `tone`, `variant: 'track'|'underline'`, `size: 'sm'|'md'|'lg'`), `Toast` (div item, optional `{action, ttlMs}`, backward compatible), `Modal` (`size: 'drawer'`, bottom sheet ≤600, hairlines, quiet close), `usePrefersReducedMotion` + `isAnimationActive` in the six charts, chart tooltip radius → token.
- [x] A1.5 Docs: `apps/dashboard/CLAUDE.md` (D3 list), index.css comments; a short "Design language" section at the top of CLAUDE.md that wave C agents will follow (page header + eyebrow, flush panel rows, StatStrip, track tabs with counts, StatusMark vs Badge, mono usage, no literal hex/px radius, ≥11px text).

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
- [x] A3.1 Gap #1: `InboxItem.subject/parts/actions` with English `actionView`; `OwnerInbox.get(id)`; tests.
- [x] A3.2 Gap #2: `POST /api/agents/inbox/:id/actions {key}` (stored-key check, 404/400 codes), `via` threaded through `pause-actions.ts`, outcome `code`, dashboard resolutions count for the A10 demotion; tests (unit + PG where the brief points).
- [x] A3.3 Gap #3 + mark-unread: series-pauses `{action:'pause', key, label}`; `POST /api/agents/inbox/unread {ids}`; tests.
- [x] A3.4 `lib/inbox-kinds.ts` + `lib/inbox-ref.ts`: every kind → why / primary / secondary descriptors (links and operations), ref parsing, handle resolution; node tests incl. every kind in the brief's list.
- [x] A3.5 `components/inbox/NoteActions.tsx` (+ api hooks): runs descriptors, marks read after decisions, invalidates inbox + badges, English toasts, shows server error codes; handles missing handle / missing endpoint gracefully (link fallback).

### A4 Mock API for visual QA (scratchpad only, never committed)
Owns: `<scratchpad>/rdmock/` only. No repo edits at all.
- [ ] A4.1 `server.mjs <distDir> [port=3178]`: serves the built dashboard (SPA fallback) and answers every GET the dashboard makes (derive the list from `api/*.ts` and route files) with realistic fixtures: 6 orchestrators (+ manager, sysadmin, builder, roles), editor channels and today's plans (all slot statuses, missed series slots, reserved), 5-day schedules, inbox notes of every kind/severity with actions, approvals, directives, chat cards, map snapshot with events, spend summary/breakdown/budgets, network health, tracking channels, meta accounts, scheduled posts, agents' detail endpoints, landing public endpoints, nav config/badges/attention. Stateful for: inbox read/unread/actions, nav config PUT/DELETE, mode switches, scheduled post create/cancel, series pause/resume. Unknown `/api/*` → 404 JSON (pages must survive it). `/auth/me` → a dev owner.
- [ ] A4.2 `README.md`: how to start, the fixture knobs (`?empty=1` style switch or env to serve empty states), and the endpoint list.

---

## Wave B (parallel, after A is merged)

### B1 Today — `routes/app.index.tsx`
Brief: `research/today.md`. Handoff §4. Prototype `App-Today.dc.html`.
Owns: `routes/app.index.tsx`, `components/overview/*`, new `components/today/*` (DayTimeline, SlotRing, NeedsYouList, ActivityList, AgentsPanel), `lib/today.ts` (+tests), `lib/useNow.ts` (moved from map), `api/map.ts` (`useMapSnapshot`) + `map/MapPage.tsx` (switch to the hook only).
- [x] B1.1 Header (eyebrow date/time Kyiv, greeting, "N things need you", severity pills) + Needs you (D6) with NoteActions, Dismiss + Undo toast, All clear.
- [x] B1.2 Glance (SlotRing, runs, AI budget, busiest channel) + DayTimeline (D6) + legend; tests for 0 / 15+ slots / superseded hidden.
- [x] B1.3 Agents panel (ModeSwitch by channel, live via AutonomyDialog) + Live activity (useMapSnapshot) + KPI strip with sparkline + health link line; remove the legacy blocks and dead components.

### B2 Inbox — `routes/app.agents_.inbox.tsx`
Brief: `research/inbox.md`. Handoff §5. Prototype `App-Inbox.dc.html`.
Owns: `routes/app.agents_.inbox.tsx`, new `components/inbox/*` except `NoteActions.tsx` (A3's; fix bugs in it only with a note in Deltas).
- [x] B2.1 Tabs + Unread only + search params (legacy mapping) + list with severity marks, grouping by subject, counts.
- [x] B2.2 Detail pane (D6) + bottom sheet ≤860 + Mark as done / Mark all as done + Undo.
- [x] B2.3 To approve tab around `ApprovalList`; deep links (`note=`), InboxLinks preserved; empty states.

### B3 Agent detail — `routes/app.agents_.$handle.tsx`
Brief: `research/agent.md`. Handoff §6. Prototype `App-Agent.dc.html`.
Owns: `routes/app.agents_.$handle.tsx`, `components/agents/*` (AgentsUi restyle, AgentOverview, header pieces, new `lib/agent-tabs.ts` + tests, `lib/mode-hints.ts`), `health/NetworkHealthView.tsx` (AgentLink tab type only).
- [x] B3.1 Tab groups (leaf `?tab=` → group; second level; `settings` leaf) + every existing link verified.
- [x] B3.2 Header (glyph xl, meta line, big mode switch + kind-aware hint, Run now / Chat / More) + pause banners (series + resource).
- [x] B3.3 Overview (KPI strip, Today step by step, Channel + How posts look summaries) + Settings leaf content.

### B4 Calendar — `routes/app.calendar.tsx`
Brief: `research/calendar.md`. Handoff §7. Prototype `App-Calendar.dc.html`.
Owns: `routes/app.calendar.tsx`, new `components/calendar/*`, `lib/calendar.ts` (+tests), `post/PostComposer.tsx` (drawer mode + validation timing), `nav/legacy-redirects.test.ts`.
Appends: `AppShell.tsx` (New post target only), `api/*` hooks if missing.
- [x] B4.1 Week grid (rows = orchestrators + Other channels; 5 days; nav; chips with StatusMark; not-planned chips; click targets).
- [x] B4.2 Composer drawer (`?compose=new&channel=&day=`), validation after submit/blur, Ask the agent (pin rule or disabled), Undo toast.
- [x] B4.3 New post button → drawer; legacy redirect test; empty/404 states.

### B5 Landing — `/` and `/white-label`
Brief: `research/landing.md`. Handoff §8. Prototype `Main.dc.html`.
Owns: `routes/index.tsx`, `routes/white-label.tsx`, `components/landing/*` except the four admin cards (`CtaStatsCard`, `LeadsCard`, `NetworksCard`, `PublicPageCard`), `lib/landing-view.ts` (+tests).
- [x] B5.1 Hero (headline words, orbit, agent log, stats) + channel marquee.
- [x] B5.2 Role explorer, loop ring + guard track, approval deck, ad steps, shadow/live demo, network showcase hover; CTA/leads/beacon unchanged.
- [x] B5.3 Motion rules (off-screen pause, reduced motion, no-JS), "| DEV" removal, 375px.

---

## Wave C (parallel, after B is merged) — pages without a prototype
Brief: `research/other-pages.md` §3 (per page) and §5 (batches); CLAUDE.md "Design language" (A1.5). Frozen: `ui/*`, `index.css`, `SegmentedTabs`, `Modal`, `Pagination`, `nav/*`, `AppSidebar`, `AppShell`, chart files, `GraphCanvas`, `agents/AgentsUi`, `approvals/*`, `overview/*`, `today/*`, `inbox/*`, `calendar/*`, `landing/*` public parts. Page CSS goes into an area file (e.g. `components/connections/connections.css`).

- [x] C1 Channels & intelligence: channels, channels_.$id, tracked, analytics, discovery, recommendations, graph (+ their owned components per brief §5).
- [x] C2 Connections, health & map HUD: connections, connections_.groups, connections_.meta_.$accountId, health, map HUD only.
- [x] C3 Publishing & spend: editor, editor_.$channel, editor_.run.$id, editor_.slot.$id, scheduled, compose, logs, spend.
- [x] C4 Agents config & system: agents, models, dm, settings (+ settings/*, models/*, strategies/MigrationBanner).
- [x] C5 Chat & artifacts: chat, artifacts (+ chat/*, artifacts/*, nav/NeedsYou).
- [x] C6 Data, ads & public: data, data_.$key, ads, landing (admin), login, report.$token, app.tsx auth screens, NotFound (+ data/*, landing admin cards).

## Wave D (parallel, after C is merged) — what B and C kept frozen
Wave C froze `components/agents/*` and `approvals/*`, so the agent page's tab contents and the approval, review and proposal cards kept the old look (inline colours, 10px text, uppercase eyebrows, hand-made pills). B1 also took the network KPI digest off Today and nothing shows it now. Same brief as C: CLAUDE.md "Design language", `research/design-language.md`, `research/agent.md` (the tab leaves). Restyle only: same data, same mutations, same links and search params, same keyboard behaviour; no endpoint, route or `routeTree.gen.ts` change. Frozen: everything not owned below, in particular `ui/*`, `index.css`, `SegmentedTabs`, `Modal`, `nav/*`, `AppShell`, `AppSidebar`, `agents/AgentsUi.tsx`, `agents/AgentHeader.tsx`, `agents/AgentOverview.tsx`, `agents/AgentSummaries.tsx`, `lib/agent-tabs.ts`, `lib/status-tone.ts`, every route file.
CSS: each package writes only its own area file, already created and imported by `routes/app.tsx` (so no component imports a stylesheet: several of these components are loaded by node tests, and `tsx --test` cannot load `.css`). Prefix every class with the package prefix; never restyle a global class from an area file.
Do not edit this file: put deltas, open questions and the browser checklist in the final report; the lead writes them here.

- [ ] D1 Plan, schedule and reach tabs (prefix `apl-`, `components/agents/agent-plan.css`): `AgentPlan.tsx`, `AgentSchedule.tsx`, `AgentPromo.tsx`, `AgentLoadout.tsx`, `NewsWatchFields.tsx`, `ActiveEffects.tsx` (In force).
- [ ] D2 Playbook, ideas, skills and memory tabs (prefix `apb-`, `components/agents/agent-playbook.css`): `AgentPlaybook.tsx`, `PlaybookEditor.tsx`, `AgentIdeas.tsx`, `AgentSkills.tsx`, `SkillProbeDialog.tsx`, `AgentMemoryHistory.tsx`, `StyleSheetEditor.tsx`.
- [ ] D3 Manager, reviews and proposal cards (prefix `amg-`, `components/agents/agent-manager.css`): `Directives.tsx`, `ManagerReviews.tsx`, `PostAuditNotes.tsx`, `NetworkUi.tsx`, `critic/CriticBlock.tsx`, `sysadmin/AuditBody.tsx`, `launch/LaunchBody.tsx`, `setup/SetupProposalDialog.tsx`, `steering/SteeringCard.tsx`.
- [ ] D4 Settings leaf, approvals and the network digest (prefixes `ast-`, `appr-`, `hd-`; `components/agents/agent-settings.css`, `components/approvals/approvals.css`, `components/health/digest.css`): `ResourceProfile.tsx`, `ResourceFormatting.tsx`, `SourcesSection.tsx`, `approvals/*` (`ApprovalCard`, `ApprovalList`, `AutonomyDialog`, `ApprovalFindings`, `ApprovalStatsPanel`); and a new `components/health/DigestSection.tsx` on `/app/health` that brings back what the old Overview card `NetworkHealthCard` showed from `GET /api/kpi/digest` (per-resource KPIs, anomalies, quality flags, open directives, the "Answers to @manager" compliance table; the old file is `git show 0c37e078^:apps/dashboard/src/components/agents/NetworkHealth.tsx`), placed after the four health sections in `NetworkHealthView.tsx` (a one-line render in that file is the only edit there).

---

## Lead (after each wave)
- [ ] Merge in order (A: A1 → A3 → A2; B: B1 → B2 → B3 → B4 → B5; C: C1…C6; D: D1…D4), resolve conflicts, full suites under Node 20.
- [ ] Browser pass on the A4 mock (1280 / 375, reduced motion), fix or send back.
- [ ] Adversarial review of the merged diff; fixes.
- [ ] Runbook § 31 (nav v2 migration behaviour, `VITE_ENV_LABEL`, what moved where), specs README row, docs/ui-inventory.md refresh, spec status.

## Status
(filled in per commit)

- A1 Foundation (branch `worktree-wf_9569abf2-5cb-1`, base `8492e74f`), done:
  - A1.1 `18bd57dd` tokens
  - A1.2 `f7848f43` status system
  - A1.3 `5fd317ca` global CSS restyle
  - A1.4 `6f980ffe` primitives
  - A1.5 `b1eeab4d` docs (CLAUDE.md "Design language", index.css comments)
  - Checked under Node 20: `tsc --noEmit` clean, 321 node tests pass, `VITE_ALLOW_DEV_AUTH=true npm run build` builds. Browser pass is the lead's.

A3 (worktree `wf_9569abf2-5cb-3`):
- `a39a7b9c` A3.1 `Inbox` list returns `subject`, `parts` and English `actions`; `OwnerInbox.get(id)`.
- `f0b19389` A3.2 `POST /api/agents/inbox/:id/actions`, `via` threaded through `pause-actions.ts`, outcome `code`, dashboard reactions count for the A10 demotion.
- `0689e01c` A3.3 series-pauses `{action:'pause'}` and `POST /api/agents/inbox/unread`.
- `a215b15b` A3.4 `lib/inbox-ref.ts` + `lib/inbox-kinds.ts` (48 kinds) with node tests.
- `4e718e1e` A3.5 `components/inbox/NoteActions.tsx`, `useInboxAction` / `usePauseSeries` / `useMarkInboxUnread`, `useResumeSeries` invalidates the inbox.

### A2 Navigation, sidebar and top bar (branch `worktree-wf_9569abf2-5cb-2`, base `8492e74f`)
- A2.1 `54aecc4f` registry: 11-item default menu in Home, Network, Insights and System.
- A2.2 `5cd297b9` badges: the Inbox counts unread notes plus posts to approve; `rollup` stops double counting.
- A2.3 `fbbd00d1` schema v2 and the v1 to v2 migration (client and server); `3d6f226d` follow-up: a stored v1 group title that is just the v1 default is not a rename.
- A2.4 `109716bc` sidebar: group titles, longest-prefix active item, More tools, footer, width 248.
- A2.5 `1d8ead75` top bar: wide search field, N agents live pill, New post, main padding and max-width.

### B1 Today (branch `worktree-wf_a4c40803-5b3-1`, base `ad17cb89`)
- B1.1 `5a53e8ed` header (Kyiv eyebrow, greeting, "N things need you", severity pills) and Needs you (NoteActions, Dismiss with Undo, All clear).
- B1.2 `ca01c150` Today at a glance (SlotRing, runs, AI budget, busiest channel) and the day timeline (fixed 06-24 axis, StatusMark markers, now-line, past shading, legend).
- B1.3 `29bc2514` Agents panel (ModeSwitch by channel), Live activity (`useMapSnapshot`, shared with the map), KPI strip with the spend trend, health line; the legacy blocks and `AgentsCard.tsx` are gone.
- Checked under Node 20: `tsc --noEmit` clean, 431 node tests pass (24 new in `lib/today.test.ts`), `VITE_ALLOW_DEV_AUTH=true npm run build` builds. Looked at in the browser through a dev server on 3111 proxied to the read-only mock (GET only, nothing that writes was clicked) at 1440 and 390 wide, and with the clock pinned to 14:00 Kyiv for the now-line. The lead's browser pass is still to do.

### B2 Inbox (worktree `wf_a4c40803-5b3-2`, base `ad17cb89`)
- B2.1 `645e1c7f` tabs (To approve / All / Critical / Action / FYI with counts), Unread only, search params with the legacy mapping, list with severity marks and subject groups (`lib/inbox-view.ts`, `components/inbox/InboxList.tsx`, `InboxPage.tsx`, `inbox.css`).
- B2.2 `2adbc96b` detail pane (`InboxDetail.tsx`), bottom sheet at 860px and below, Mark as done / Mark all as done with Undo, Mark as unread.
- B2.3 `730972be` stale `?note=` cleanup, error callout, Show read notes action, 200-note cap line; the To approve tab and deep links are covered by tests.
- Checked under Node 20: `tsc --noEmit` clean, 434 node tests pass, `VITE_ALLOW_DEV_AUTH=true npm run build` builds. Clicks, the sheet, Undo and the 375px layout are the lead's browser pass (checklist in the report).

B3 Agent detail (worktree `wf_a4c40803-5b3-3`, base `ad17cb89`), done:
- `8699fe18` B3.1 `lib/agent-tabs.ts` (17 leaves in 5 groups, visibility per kind, `resolveTab`) with tests that scan every `?tab=` link; `AgentTabs` (groups row + leaves row), `AgentSettings` (the new `settings` leaf), the `effects` leaf; `NetworkOfferActions` buttons `btn-sm`.
- `a6f7c055` B3.2 `AgentHeader` (glyph xl, kind chip, `@handle → scope`, 4-up mode switch with a kind-aware hint, Run now / Chat with / More), `PauseBanners` (series Resume, resource Lift), `lib/mode-hints.ts`, `useAgentSetup`.
- `976736a7` B3.3 Overview: `StatStrip`, `TodaySteps`, `ChannelSummary`, `FormattingSummary`, Roles as panel rows; `lib/agent-overview.ts`; inbox links 'Open active effects' open `?tab=effects`.
- Checked under Node 20: `tsc --noEmit` clean, 441 node tests pass, `VITE_ALLOW_DEV_AUTH=true npm run build` builds. `buildSteps` / `formatRows` were also run against the mock (GET only) for `ai_global`. Browser pass is the lead's.

### B4 Calendar (branch `worktree-wf_a4c40803-5b3-4`, base `ad17cb89`)
- B4.1 `209f07f2` week grid: 5-day window and `?from=`, rows per orchestrator plus Other channels, chips with StatusMark, not-planned projections, phone agenda, legend; schedule DTO carries the slot `error`. `e0d690a8` follow-up: a crowded cell shows what needs the owner first.
- B4.2 `b517d15d` composer drawer (`?compose=new|edit`), PostComposer drawer layout and validation timing, Ask the agent, Undo toasts. `04d31d56` follow-up: a numeric `?post=` id survives the router's search parser.
- B4.3 `af8d9948` top-bar New post and the ⌘K action open the drawer; failed-to-load states; `legacy-redirects.test.ts` pins the new route and the New post target.
- Checked under Node 20: dashboard `tsc --noEmit` clean, 445 node tests pass, `VITE_ALLOW_DEV_AUTH=true npm run build` builds; automation `nest build` builds, `lint` has no errors, `src/editor/schedule/*.test.ts` pass (54 pass, 12 PG tests skipped without a database). `routeTree.gen.ts` did not change. Browser pass is the lead's.

### B5 Landing (worktree `wf_a4c40803-5b3-5`, base `ad17cb89`)
- `43fa918e` B5.1 hero: headline words, orbit, agent log, stats row, channel marquee.
- `4acd5df4` B5.2 sections: role explorer, loop ring and guard track, approval deck, ad steps, shadow/live demo, network card hover.
- `01f907b9` B5.3 motion rules, no "| DEV" on channel names, CSS lint tests.
- Checked under Node 20: `tsc --noEmit` clean, 439 node tests pass, `VITE_ALLOW_DEV_AUTH=true npm run build` builds. Browser pass (and the 375px pass) is the lead's.

### C1 Channels & intelligence (branch `worktree-wf_6e3bf934-224-1`, base `8f674e50`), done
- C1.1 `8a619ff3` channels, tracked: page header, stat strip, channel rows in a flush panel, search and bot filter, Add / Edit modals on SegmentedTabs; `lib/channel-view.ts` (+ tests), `components/channels/` (area CSS, `ChannelsUi`).
- C1.2 `e535cc55` channel detail: entity header, stat strip, setup facts, flush panels for forward routes, cross-posts and posts; ROI panel frameless.
- C1.3 `246219e4` analytics, discovery: platform tabs with counts, stat strips, chart panels, ROI in a panel; discovery queue as flush rows.
- C1.4 `98ddf3e2` recommendations, graph: controls panel and placements table; filter bar on chip toggles; channel dialog and edge sheet on Modal.
- C1.5 (this commit): the last inline colours moved to classes; this status and the deltas below.
- Checked under Node 20: `tsc --noEmit` clean, 402 node tests pass (4 new in `lib/channel-view.test.ts`), `VITE_ALLOW_DEV_AUTH=true npm run build` builds. In the browser on the mock (private port, GET only): every C1 page at 375px has no page-wide horizontal scroll; a stubbed 404 on `/tracking/*` and a stubbed empty payload both render the error callout or the empty state on all seven routes; channel dialog, edge sheet and the recommendations result table were driven with stubbed `fetch` (no POST reached the mock).

### C2 Connections, health & map HUD (branch `worktree-wf_6e3bf934-224-2`, base `8f674e50`), done
- C2.1 `4888968c` connections: every manager is rows in a flush panel (`ConnUi`: `ConnPanel`, `ConnRow`, `ConnStat`, `ConnAdd`), section tabs are a track with counts and sub-tabs are underline with counts (`lib/connection-counts.ts` + test), the Meta rows show the 24 h change and a Refresh stats button.
- C2.2 `db763176` connections/groups: composer in a panel, group cards on tokens, accessible port remove controls.
- C2.3 `1f69a71f` connections/meta/$accountId: `PageHeader` with eyebrow, `StatStrip` with a follower trend, an Account row and token facts (`ConnFact`).
- C2.4 `50050c97` health: `StatStrip` glance, flush panels with `SeverityPill` rows, 6px budget meters, the owner bot as rows (`health.css`).
- C2.5 `8cee8d88` map HUD: radius, shadow and ink tokens, overline keys, 11px floor, mono counts, `btn-ghost` Cancel (HUD only; `MapStage`, `MapShapes`, `MapPage`, `api/map.ts` and the `FeedPanel` props are untouched).
- C2.6 `45328a79` connections: delete-dialog notes on classes.
- Checked under Node 20: `tsc --noEmit` clean, 401 node tests pass (3 new, `connection-counts.test.ts`), `VITE_ALLOW_DEV_AUTH=true npm run build` builds. Browser on the A4 mock at 1280 and 375: no horizontal scroll on any C2 page. The lead's browser pass is still due.

### C3 Publishing & spend (worktree `wf_6e3bf934-224-3`, base `8f674e50`), done
- C3.1 `83432af3` editor, editor/$channel, run, slot: flush-panel rows, StatStrip, status marks, trace timeline; `EditorUi`, `SlotPlan`, `CardEditorModal` restyled; new `editor.css`, `lib/day-groups.ts` (+ test).
- C3.2 `a482ea24` scheduled, compose: StatStrip, queue as rows with the "yours" mark, publication Badge, inset hint band.
- C3.3 `7ec56399` logs: day-grouped Kyiv-time timeline, status marks on a spine, buttons that expand to the trace, CSS hover (`components/activity/activity.css`).
- C3.4 `c34a7297` spend (report, prices, budgets): underline section tabs, StatStrip, caps as meter rows, callouts, ghost Cancel (`components/spend/spend.css`).
- C3.1b `cbbdcb9a` editor: type classes instead of inline sizes, token radius for the trace error dot.
- Checked under Node 20: `tsc --noEmit` clean, 403 node tests pass (398 + 5 in `day-groups.test.ts`), `VITE_ALLOW_DEV_AUTH=true npm run build` builds. Browser pass on the mock at 1280 and 375 (no page-wide horizontal scroll on any of the 8 pages, 3 spend tabs); 404 states of scheduled and logs through a patched `fetch`.

### C4 Agents config & system (branch `worktree-wf_6e3bf934-224-4`, base `8f674e50`)
- C4.1 `5a27eb55` agents + MigrationBanner: KPI strip, registry as rows in flush panels, banner as a panel of channel rows.
- C4.2 `b7df9781` models + ModelSelect: workspace options as the control, price facts in insets, overrides as rows, picker popover on tokens.
- C4.3 `24623c04` dm: status as a KPI strip, chat intel as two flush panels, category tabs with counts, dialog bodies on overline keys and insets.
- C4.4 `4106fa6f` settings: underline tabs, setting groups as flush panels with counted tabs, sessions as rows, navigation constructor tuned in `settings.css`.
- `routes/app.agent.tsx` is redirect-only and was not touched.
- Checked under Node 20 after every commit: `tsc --noEmit` clean, 398 node tests pass (no new pure logic, so no new tests), `VITE_ALLOW_DEV_AUTH=true npm run build` builds. Browser pass is the lead's.

### C5 Chat & artifacts (branch `worktree-wf_6e3bf934-224-5`, base `8f674e50`)
- C5.1 `9cbc568f` chat + NeedsYou: `chat.css` and `needs-you.css`, token-only layout, button-disclosure approval strip, flush amber NeedsYou panel, card dialogs on `.inset` / `.code-block` / `.chip-toggle`.
- C5.2 `78074cba` artifacts page + panel: `PageHeader`, chip-toggle type filter, `SegmentedTabs` with counts, flush rules / memory / version rows.
- Checked under Node 20: `tsc --noEmit` clean, 398 node tests pass, `VITE_ALLOW_DEV_AUTH=true npm run build` builds. Browser pass is the lead's.

### C6 Data, ads & public (branch `worktree-wf_6e3bf934-224-6`, base `8f674e50`)
- C6.1 `f38cea13` data and dataset detail: PageHeader, StatStrips, flush panels, rows, schema editor with a sticky save bar, import wizard; local `SkeletonRows`; `summarizeDatasets`.
- C6.2 `d68ff064` ads: stage strip, orders as `.panel-row`s, price list, New order drawer; `lib/ad-orders.ts` with node tests.
- C6.3 `556be553` landing admin: underline tabs, networks and resources as rows, Public page card, Leads, CTA totals strip; `landing-admin.css`.
- C6.4 `79bba105` sign-in, session-guard screens and the in-shell 404 on `components/auth/auth.css`.
- C6.5 `e69b94b3` public report on `components/report/report.css`: PageHeader, StatStrip, SectionCards, width-aware curve.
- Checked under Node 20: `tsc --noEmit` clean, 403 node tests pass (`ad-orders` 4, `summarizeDatasets` 1 added), `VITE_ALLOW_DEV_AUTH=true vite build` builds. No browser (the lead's pass).

## Deltas from the spec
(each agent appends its own subsection)

### A1
- **Tokens:** added `--color-on-danger` (dark text on the danger fill; white was 3.1:1). Shadow and motion tokens live in a plain `:root` block, not `@theme`, because Tailwind v4 only emits `@theme` variables that are referenced.
- **Status marks:** `not_planned` is a dashed rounded square and `yours` is a target (ring plus dot), so neither shares its shape with the dashed `shadowed` circle or the plain ring. `expired` is warning-toned in the status table (handoff) while its mark is grey. The publication `canceled` tone is neutral, per the handoff. `app.index.tsx` "not planned" Badge is now warning-toned (it was neutral).
- **Reduced motion:** the global block collapses durations and also zeroes `animation-delay` and `transition-delay`, with `iteration-count: 1`, and never uses `animation: none` (`.compose-rise` and `.group-card` start at opacity 0). The tooltip animation is also disabled. Charts take `isAnimationActive={!reduced}` from the new `lib/useReducedMotion.ts`.
- **Primitives:**
  - `SectionCard.action` stays a free ReactNode; it is not wrapped in `.panel-link` automatically (a page passes `className="panel-link"` to its link).
  - `PageHeader` `title` and `subtitle` are widened to ReactNode.
  - `SegmentedTabs` now sets `type="button"` on its options.
  - `Pagination` Prev and Next both use `btn-secondary btn-sm`.
  - The `Toaster` live region (`aria-live="polite"`) is always mounted, even when empty, so screen readers announce additions.
  - `Button` gained `variant="warning"` and `size="sm"`.
- **Global CSS:**
  - `.group-card` and `.group-hub` are flattened and use tokens.
  - Nav and cmdk font sizes below 11px were raised to 11px.
  - Raw `.panel` padding went 18 to 20px and `.input-field` text went 15 to 14px.
  - `.empty-note` has a 420px max-width.
  - `.nav-group-title` is left to A2 (`nav/*` is A2's).
- **Left for other tasks:**
  - `AppSidebar.tsx:154` (A2) and `agents/NetworkOfferActions.tsx:68,71` (B3) use `btn-primary` / `btn-secondary` with inline compact padding and are now 40px tall.
  - `SidebarItem.tsx:63` (A2) still sets an inline `borderColor` on `.nav-badge`, so every badge reads as warning until A2 adds `.is-danger` / `.is-accent`.
- **Touched outside A1's files** (all listed in the task): the mono font stacks in `components/agents/AgentLoadout.tsx`, `AgentSkills.tsx`, `components/artifacts/ArtifactPanel.tsx`, `components/chat/{ActionCard,SlashMenu,ToolChips}.tsx`, `components/sysadmin/AuditBody.tsx`, `routes/app.models.tsx`; `components/data/SchemaEditor.tsx` (line 181, `var(--shadow-2)`); `routes/app.scheduled.tsx` (publication status tone); `routes/app.index.tsx`, `routes/app.landing.tsx`, `routes/app.logs.tsx` (status map, reduced-motion guards).

### A3
Backend (all under `apps/automation/src/editor/`):
- **`execute()` next to `run()`.** `SeriesPauseActions.run(noteId, key, via)` still returns the Ukrainian string the owner bot shows (default `via = 'telegram'`, so the bot is unchanged; the bot tests prove the string and the default). The new `execute()` returns `{outcome, changed, code}` and the endpoint answers with `code` (`resumed | already_resumed | not_found | kept | paused | already_paused | muted | not_broken | unavailable`); the dashboard maps the code to English, never the `outcome` text.
- **"`resolved_by`" is `owner_cards.resolved_by`.** `agent_inbox` has no such column. A dashboard press stamps the note's open owner-bot card `resolved_by = 'dashboard:owner'` (only where it is still NULL), and the sweep that closes the card of a read note ("decided in the dashboard") keeps that stamp: `OwnerCardsRepository.resolve` now uses `COALESCE($4, resolved_by)`. The A10 demotion (`agents/note-runs.ts`, `repeatingSubjects`) and `OwnerInbox.ownerActed` count `telegram:%` and `dashboard:%`.
- **Mark-unread clears only the `dashboard:%` stamp** (and `read_at`). A card a Telegram press resolved stays resolved; a card the sweep already closed is not re-created, so Undo after the sweep brings the note back to the list but not to Telegram.
- **No existence check for `pause`.** The endpoint pauses by `key` + `label` as the owner bot does; it refuses `resource:` keys and answers 409 `already_paused`, 404 `no_channel`.
- **`skipPlanned` text is cause-aware** (`series-pauses.repository.ts`): a slot skipped by an owner pause says it is paused by the owner, not "after repeated skips".
- **Dashboard Resume on the agent page (`useResumeSeries`) does not stamp the card** (it is the old endpoint, not a note action); it now invalidates `['agents','inbox']`, as the brief asked.
- **Support module** `series-pause/testing/inbox-service.078.ts` (fake service for the unit tests); the PG tests (`inbox-actions.078.pg.test.ts`, 7 tests, skipped without `EDITOR_PG_TEST_URL`) were added in A3.2 and A3.3.

Dashboard:
- **`critic_failed` is kept** (the skeptic's correction): 48 kinds in `INBOX_KINDS`, pinned by `inbox-kinds.test.ts` against the brief's list. A kind this table does not know ends in "Got it".
- **Steps instead of one action.** `planNote(item, {tree})` returns `why`, `primary`, `secondary`, `extra[]`; a step is a link, a stored action, or an operation (replan, Threads refresh, directive / contest / playbook decision, autonomy dialog, mode switch, network offer, resume / pause series). A step that cannot run (no handle, no stored actions on an old server) drops out and the next one moves up.
- **Per-kind decisions** (research/inbox.md section 3): Threads refresh only for `token_expiring` on `threads:`; every other broken connection is "Reconnect" (a link to `/app/connections?section=...&tab=...`, bots / telegraph / MTProto say "Open connections"); no MTProto verify button; skill kinds link to `?tab=skills` (no rollback, no "adopt anyway"); `series_source_empty` opens the agent's Schedule (not Data) and offers "Pause series"; slot kinds are keyed by kind, so `slot` and `editor_slot` both open the slot; `manager_escalation` opens `/app/chat?q=@manager ...`; `directive_contested` leads with Accept refusal, Uphold is secondary; `event_not_covered` offers "Plan a recap today" on the first `telegram:` resource named in its body.
- **Decisions mark the note read** (directive, playbook, replan, pause, Threads refresh, autonomy / mode change). A 409 that means "already decided" (`not_awaiting_owner`, `not_contested`, `not_pending`) also marks it done. Approve / Decline / Uphold / Accept refusal / playbook decisions ask for the same confirmation as their own pages.
- **A read note shows its links only** (its decisions were taken or are stale). Pages that want the buttons back after Undo call `useMarkInboxUnread` and the note is unread again.
- **`api/agents.ts`**: `InboxItem.subject/parts/actions` are optional (an older server sends none); `usePauseSeries(handle)` and `useInboxAction()` are `silentError` (NoteActions toasts English text); `noteErrorMessage` in `inbox-kinds.ts` explains a 404 from a server without the endpoint.
- **Outside A3's ownership**: `owner-bot/owner-cards.repository.ts` (COALESCE, above), `agents/note-runs.ts` (dashboard reaction in the A10 query), `docs/import-list-tools.069.test.ts` (fake `resume` results gained `code`). `lib/inbox-kinds.test.ts` and `components/inbox/NoteActions.test.ts` read `routeTree.gen.ts` / `nav/routes.ts` (A2's helpers) but change nothing there.
- **Rendering test**: `NoteActions.test.ts` renders on the server (`react-dom/server`, a memory router); click flows are in the browser checklist below, not automated.

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

### Lead: wave A merge and review
- Merged A1 → A3 → A2 (`ef06d210`, `9f9a2f19`, `ad17cb89`); only tasks.md conflicted. Node 20: dashboard tsc clean, 398 tests; automation 4100 tests (with PG: one known parallel-PG race in `directive-lifecycle.e2e.pg.test.ts`, green on rerun), nest build, lint 0 errors. Browser on the mock: 41 routes render at 1280 with no crash or page-wide horizontal scroll; 375 drawer, short window (680px: More tools reachable by scrolling the menu), v1 → v2 menu migration, Inbox badge 45 = 42 unread + 3 approvals.
- Adversarial review (4 lenses, each finding checked by a skeptic): 6 confirmed, 9 refuted. Fixed:
  - **A dashboard press on a note with no owner-bot card did not count for the A10 demotion** (a demoted `info` note never gets a card; with the bot's cards off no note has one). `stampReaction` now inserts a closed card that only carries `resolved_by = 'dashboard:owner'` when the note has none (same no-overwrite rule as before). The bot then never sends a card for that note; `/waiting` after a mark-unread would requeue it without buttons (accepted, rare). PG test extended.
  - The rail's More tools menu closed when its own list scrolled (window capture listener); now only a page scroll closes it.
  - The rail trigger could not close its menu (outside-mousedown then click reopened it) and focus fell to `<body>` on close: the trigger toggles, `NavContextMenu` takes an `anchor` and returns focus to it (or to the element focused before) on close.
  - The More tools dot rolled up sub-view counters that the list does not show; it now rolls up the More tools list itself.
  - "Edit in menu settings…" on a hidden page focused nothing: the Hidden panel's Restore button now has `navc-hidden-<id>` and gets the focus.
  - Danger text on the danger tint was ~3.8–4.5:1: new `--color-danger-ink` for text on tints (nav counters, `.sev-critical`, selected danger tab, `.chip-danger`, danger toast action), ≥5:1.

### B1
Header and Needs you:
- **The headline counts what needs a decision**: unread critical and action notes, posts to approve, cards waiting in a chat (D6). FYI notes are neither counted nor listed; they only add to the "Open inbox · N" counter, which is the menu's sum (every unread note plus approvals). Until the inbox has answered the title is the greeting alone, so a slow server never flashes "Nothing needs you".
- **A failed inbox never says "All clear"**: the panel says the notes could not be loaded and offers Try again.
- **Queue rows come in addition to the top 4 notes**: one row "N posts to approve" (Review posts, to `/app/agents/inbox?tab=approvals`) and one "N actions wait for your confirmation" (Open chat). When only approvals wait, "Open inbox" goes to the Approvals tab (the Unread tab would be empty).
- **Dismiss marks the note read at once** (no delayed POST). The toast offers Undo, which calls mark-unread and puts the row back; a failed request puts the note back. Undo after the owner bot's sweep closed the Telegram card brings the note back to the list, not to Telegram (A3's note).
- **Button heights are normalised in CSS** (`.need-actions`): A3's `NoteActions` renders its link steps with inline compact padding, so they are forced to a 36px minimum height with a 44px hit area, to sit level with Dismiss.
- **The prototype's "streaming" pill is dropped** (it was a poll indicator); Live activity has an "Open map →" link instead.

Glance and timeline:
- **The ring and the timeline cover the Telegram lane only**: active plans (a replanned day's superseded plan never shows), slots with no `resourceRef`. The copies for Instagram, Facebook and Threads are not drawn; a quiet line under the ring says how many there are. Reserved slots are drawn and counted.
- **The ring**: published plus shadowed count as done; a skip the system chose (replan, mode change, cancelled draft, paused series) is not in the total; missed comes from `isMissed` on the plan's slots, not from the channel counters. The legend always lists Published, Missed and Skipped, the other rows only when they are not zero. Known limit (skeptic): a series slot an evergreen fallback filled is a miss on the server and a published slot here.
- **Timeline details**:
  - The axis is fixed at 06:00 to 24:00 Kyiv. A slot outside it sits on the edge, dimmed, and its tooltip says so.
  - Markers closer than 36 minutes stack into sub-rows (20px each) and the lane grows. 36 is what a 16px mark needs on the narrowest axis (760px).
  - The hit area of a marker is 44px tall in a one-row lane and 20px in a stacked lane (rows are 20px apart).
  - A live or shadow channel with no plan shows "No plan for today yet" in its lane; an off channel with nothing planned has no lane.
  - Below 760px the timeline scrolls sideways inside its panel (keyboard focusable); the page itself does not scroll sideways.
  - With no slot at all the panel is an empty state, not an empty axis.
- **The old "Upcoming slots (next 24 h)" card is gone.** Slots after midnight (tomorrow's first posts) are not on Today any more; the Calendar has them. `api/upcoming.ts` (`useUpcomingSlots`) and `upcomingName` / `upcomingTitle` in `lib/slot-plan.ts` have no user left; they are left in place (not B1's files) and can go once nobody else adds one.
- **Glance numbers come from different sources, by design**:
  - AI budget today is the global budget row from `useBudgets` (`pickGlobalBudget`, the sidebar footer's rule), which reads raw `llm_usage`. The 7-day KPI is the rollup (up to 5 minutes behind). Without a global row the glance shows `periods.today.usd` and a "No budget set" link.
  - It draws its own meter, not `BudgetBar`, for A2's reason (the header does not fit). `AiSpendCard.tsx` (with `BudgetBar`) is untouched and no longer used on Today.
  - "Agent runs today" is `/api/overview/agents` `runs.today` (every agent run, role children included); the Agents rows show the channel's own `today.runs`, so the two numbers differ.
  - "Busiest channel" is the channel with the highest share of its daily cap, else the biggest spender; nothing spent today hides it.
- **Class names are `slotring*`, not `ring*`**: Tailwind v4 emits a `.ring` utility (a 1px box-shadow) whenever the word appears anywhere in the sources, which drew a frame round the ring.

Agents, activity, KPI:
- **The Agents panel lists editor channels** (`ModeSwitch` keyed by channel, the Editor page's own control; live opens the autonomy dialog; it invalidates `['editor']`). Orchestrators of native platforms without an editor channel are not listed (no card, no mode switch). Names and emoji come from the agent tree (orchestrator with scope `telegram:<key>`), else the channel title. The footer shows the manager, builder and auditor roots with their last run and today's spend.
- **Live activity** reads `useMapSnapshot()` (new, `api/map.ts`; `MapPage` uses it too, same options, one cache entry and one timer). It shows the 6 newest events (the feed itself only goes back 24 hours). The pixel avatar is shown when the event's agent is a unit on the map, else the icon of the event kind; a failed event has a red edge. The event text is shown as the server wrote it. `ActivityList` imports `components/map/map.css` for `.map-avatar` (class names are all `map-*`, no global selectors).
- **KPI strip**:
  - Telegram subscribers: sum of `subsCount` over `filter: 'mine'`.
  - Meta followers: sum of `followers`; the warning line counts unmuted `token_invalid` and `no_access` connections of Threads, Instagram and Facebook from `useNetworkHealth` (an expiring token is not a reconnect yet), else the 24 h change.
  - Agent posts · 7 days: `overview.posts.d7.published`. The prototype's "88% of all content" has no source and is dropped.
  - AI spend · 7 days: `periods['7d']` with `fmtDelta` and a sparkline from the daily breakdown.
  - Under the strip a link "Network health · N problems →". `problems` includes muted connections and every stuck group (approvals among them), so it overlaps the headline; it is a pointer, not a second headline.
- **Removed from Today**: the 5-tile stat grid (its Errors tile counted failed legacy strategy runs), "Legacy strategy runs", the "Meta accounts" list (the Meta page has it), `AgentsCard.tsx` (deleted; nothing else used it), the AI spend and Network health cards. `NetworkHealthCard` in `components/agents/NetworkHealth.tsx` is B3's file: it stays and has no user on Today now.
- **The Meta accounts card's Refresh button is kept** as a ghost button "Refresh Meta numbers" under the KPI strip (it was the only UI for `useRefreshMetaStats`).

Files outside B1's list: `components/map/MapHud.tsx` (its local `useNow` moved to `lib/useNow.ts`, as the task says; one import line changed), `components/map/MapPage.tsx` (switched to `useMapSnapshot`, as the task says).

### B2
- **Files:** the route is now thin (`validateSearch`, the crumbs, the stylesheet import). The page is `components/inbox/InboxPage.tsx` (`search` and `onNavigate` as props, so it renders under `tsx` in the node tests; CSS is imported only by the route). The pure logic is `lib/inbox-view.ts` with its test (new files outside `components/inbox/`, in B2's lane by name). `NoteActions.tsx` is untouched, no bug found in it.
- **URL.** `tab=approvals|all|critical|action|fyi`, `unread=false` for Unread only off, `note=<id>`. Legacy: `?tab=unread` is All with Unread only on; `?tab=all` alone is every note (what the old All tab showed), so the page always writes `unread=` next to `tab=all`. Every other tab leaves `unread` out when it is on. The page uses `replace: true` and never adds history entries.
- **Bare URL.** All with Unread only on, or To approve when no note is unread and posts wait (the sidebar counter is notes plus approvals, so it can no longer land on an empty list). The choice is made once from the data and then held, so the page does not jump to another tab when the last unread note is marked done. A bare `?note=` opens All, with Unread only on when that note is unread and off when it is read, so the list holds it.
- **Counts** on All / Critical / Action / FYI are over the list as loaded with the current Unread only state (the server has no count endpoint for read notes); To approve uses `useApprovalsCount`. The inbox endpoint sends the 200 newest notes, no paging: the list says so when it hits 200.
- **Grouping by subject** only in the All view; the severity tabs list every note. The server marks older notes of a subject read when a newer one is posted, so with Unread only on a group is mostly one note; the history list ("Same problem, N notes") matters when read notes are shown. A row shows the newest note and "xN".
- **Selection.** Wide screens: `?note=`, else the row that was selected, else the first row; after Mark as done the neighbour at the same index moves up. Narrow screens: nothing is selected until a row is tapped. The selection is not written to the URL until the user clicks (the first row is selected visually, not by URL).
- **Sheet at 860px and below** is `Modal size="drawer"`: Modal turns a drawer into a bottom sheet only at 600px and below, so between 601 and 860px it is a right-hand sheet. The sheet title is the Modal head; the pane variant shows the title itself. Closing the sheet drops `?note=`.
- **Mark as done** sends every unread note of the row (a group is one problem). **Mark all as done** (page header) sends the unread notes in the current view and tab. Both toast "Marked as done" / "Marked N notes as done" with an Undo that calls `useMarkInboxUnread`. A plan that has its own "Got it" step (`read`) shows only NoteActions' button; the page intercepts `onDone` and replaces NoteActions' plain toast with the Undo one (the toast dedup replaces an identical message). So there are never two "done" buttons for one note.
- **Read notes** show a "Done" badge, "Mark as unread", and NoteActions' links only (A3's rule).
- **Crumb parent** stays "Agents" (registry entry `agents-inbox`, `parent: 'agents'`, A2's file); the Inbox sits in Home in the new menu. `useCrumbs('agents-inbox')` is kept in the route because `nav/registry.test.ts` (FR-013) pins it. Changing the parent is one field in `nav/registry.ts`.
- **Error state.** If the inbox endpoint fails (an older server) the tabs and To approve still work, and the notes area shows a danger callout instead of an empty "All clear".
- **Technical details** (id, kind, severity, refType, refId, subject, createdAt) are a closed-by-default toggle with a `.code-block`, not a `<details>` (CLAUDE.md).
- **Left for the browser pass:** clicks, the sheet and focus return, Undo after Mark all as done, 375px, reduced motion. The rendering tests are server-side (seeded query cache) and cannot see them.

### B3
- **Tabs:**
  - Two new leaves, so 17 in all: `settings` ("General", with Promo beside it) and `effects` ("In force now", orchestrators only). `inbox` is labelled "From @manager". `lib/agent-tabs.ts` is the one list; the route has no copy of it.
  - `?tab=` stays the leaf and the group is derived. `validateSearch` does not accept group names as aliases (the brief called that optional), and there is no "Notes from this agent" leaf (the prototype's placeholder has no data source).
  - A gated leaf falls back to Overview as before. Clicking a group opens its first visible leaf. A group with one visible leaf draws no second row.
- **Links:**
  - `lib/agent-tabs.test.ts` scans every dashboard `.ts`/`.tsx` and `apps/automation/src` for `?tab=` on a line that links to `/app/agents/` and fails on a value that is not a leaf.
  - The inbox links "Open active effects" (resource pause / resume notes, and the inbox page) now carry `?tab=effects`. The `series_paused` note keeps its link without a tab, because the banner is on every tab.
  - The backend texts "Overview → Paused series" (series-breaker, pause-resume-action, import-bundle) are left alone: the banner is the first thing under the header on every tab, Overview included.
- **Header:**
  - Run now is not drawn for kinds that answer `started:false` (ideator, idea_reviewer, executor, builder, sysadmin). It is disabled with a reason when the agent is paused or its mode is off. `useRunAgent` got `meta: { silentError: true }` so the page's own toast (readable texts for `agent_paused`, `channel_off`, `replan_in_progress`, `editor_disabled`, `manager_off`, `no_manager`) is the only one.
  - Chat with `<name>` opens `/app/chat?q=@handle `; for a role agent it goes through its orchestrator (the label names the parent).
  - A role agent has no mode switch: the header shows `FollowsBadge` and "Runs in the mode of @parent. Change it there."
  - The hint under the switch depends on the kind (`lib/mode-hints.ts`): @manager's Shadow means "directives are filed as previews", an orchestrator's means "plans and writes next to you". The approval line names the batch hour and zone from `schedule` of the plan.
  - More is `NavContextMenu` anchored under its button (no new dropdown component, no new icon: `ellipsis` was added by A2). Items: Set up from history (Telegram orchestrators), Pause… / Resume, Edit profile. Resume gets an Undo toast that restores the previous pause.
  - `AgentSetupButton.tsx` (not B3's file) was split into `useAgentSetup`; the old button stays as a thin wrapper. `useNetworkPlan` gained an `enabled` argument (default true).
- **Banners:**
  - Series pauses (Resume; the toast names the next plan time) and resource pauses by @manager (Lift, the same confirmation as In force now). Three at most, then "Show all". There is no Undo: resuming and lifting are the undo of the pause.
  - `PausedSeries.tsx` is deleted (the banners replace it). `ActiveEffects` exports `useLiftAction` for the banner.
- **Overview:**
  - The Mode tile is gone (the header has it) and so is the Last run tile (the Runs tile says when the last run was).
  - The MANAGER advice tile counts advice from `useDirectives({agent, binding:'advice'})` (30 days, shadow left out) instead of the KPI digest, which is heavy to build; it can differ slightly from the table on /app when the directive list is capped.
  - "Today, step by step" uses `useNetworkPlan(orchestrator, '')` (the card's today, the active plan only) with `useAgentRuns` and the open series pauses of today. It is not drawn for an agent without a Telegram card. A run that belongs to a slot is not listed twice. The skip text comes from `skipReason`; `series_paused` already had a branch.
  - "How posts look" sends the whole `format_prefs` back with new locks (the PUT replaces them). A lock switch has no Undo toast: it is its own way back, and a late Undo would overwrite what an agent changed meanwhile. The card's hashtag range, link style and emoji policy are shown read-only with a link to the card.
  - `ActiveEffects` and `SourcesSection` keep their `card row-lift` rows (they work; restyle left for a follow-up).
- **Files outside B3's ownership:** `lib/inbox-kinds.ts` (two links), `lib/inbox-kinds.test.ts` (reads the leaf list from `agent-tabs`), `routes/app.agents_.inbox.tsx` (one link), `lib/directive-view.ts` (a comment), `components/setup/AgentSetupButton.tsx`, `api/agents.ts` (`useRunAgent` meta), `api/network.ts` (`enabled`), `components/health/NetworkHealthView.tsx` (AgentLink tab type, Sources rows open `?tab=settings`).

### B4
- **"Pipelines" row is "Other channels".** The handoff's third row has no data source in this codebase. The last row holds the owner's channels that have no orchestrator (and any stray owner post whose channel cannot be resolved); it shows only when there is one. With exactly one such channel, "+ Add" in that row preselects it; with several, the owner picks in the drawer. The mock has an agent for every channel, so this row never shows there (the unit tests cover it).
- **Data: the per-agent schedule, not `upcoming`.** `GET /api/schedule/upcoming?hours=120` is clamped to 72 h and 50 items and has no past, so the grid reads `GET /api/agents/:handle/schedule?from=` for each orchestrator (7 days come back, 5 are shown) and `cellEntries()` (`lib/schedule-grid.ts`) turns it into cells. The query key is `['schedule', handle, from]` with an explicit `from`, so a change made on the agent's Schedule tab or in the drawer refreshes the grid. Series pauses use `['agents','series-pauses',handle]`, owner posts `['scheduled-posts']`, channels `['channels','mine',1,'',undefined]`. One request per agent; a failing agent keeps its row ("Schedule unavailable" badge, the reason in its tooltip) and still shows the owner's posts.
- **Missed uses `isMissed()`**, not the handoff's formula (it has an operator-precedence slip). That needs the slot's `error`, which `GET /api/agents/:handle/schedule` did not return: **outside B4's ownership, `apps/automation/src/editor/schedule/schedule.service.ts` now adds `error: s.error ?? null` to each slot (additive), with `schedule.slot-error.078.test.ts`**; `ScheduleSlot.error?` in `api/schedule.ts`. A server without it sends none, and then a skipped series slot stays "skipped" (never an invented miss).
- **Paused or off agents are quiet, not "not planned".** A series or pin with no slot yet is amber "not planned" only when the planner will write it. When its series (or pin, or the whole resource) is paused, or the agent is off or paused, it is a dashed grey "Series · paused" / "Series · agent off". On past days a bare projection is hidden (the series may not have existed then). "Add" is not offered on past days.
- **Time zones.** Agent chips (slots, series, pins) are on the resource's own local date and time, as on the agent's Schedule tab; the tooltip names the zone when it is not Kyiv's. The owner's posts and the drawer are on Kyiv time (`Time, Kyiv`), because that is how the owner types them. "Today" is the Kyiv day and turns at midnight without a reload.
- **A crowded cell** shows 5 chips picked by need (failed, missed, awaiting approval; then what is still ahead; then what is done), in clock order, and "+N more" expands the cell in place ("Show fewer"). On the mock one agent's today has 24 chips over its Telegram, Threads, Instagram and Facebook resources.
- **At 760px and below** the grid becomes one panel per day (`DayAgenda`) with the same chips and a 44px "Add". The row head is sticky when the grid scrolls sideways (min width 956px).
- **Click targets.** A slot opens `/app/editor/slot/$id`. The owner's own pending post opens in the drawer for editing (with "Cancel post"); one that was sent, failed or canceled opens read-only (status, time, preview, the error) with a link to Scheduled. A series or pin that is not planned yet is not clickable.
- **The drawer is the address:** `?compose=new&channel=@space&day=2026-10-30` or `?compose=edit&post=ID`. Opening pushes history (Back closes it; a copied link reopens it); closing replaces. `parseCalendarSearch` drops what is not valid (`compose=edit` without a `post` is ignored); the drawer ignores a `day` in the past and starts on tomorrow. `?channel=` is a channel key (`@space`) or an id. A new post starts at 12:00 on a later day, and on today at the next whole hour at least 10 minutes away (23:59 late in the evening). Closing over typed text asks "discard this unsaved post".
- **PostComposer has two layouts now.** `variant="page"` (`/app/compose`) keeps its layout and its browser-local `datetime-local`; `variant="drawer"` is the Calendar's. Both now show a field's problem only after the owner left that field or pressed Schedule, and the button stays enabled until the first press (it used to be disabled whenever anything was wrong); after the first press it is disabled while problems remain, and the first bad field takes focus. `lib/post-problems.ts` mirrors the server's rules (`scheduled-posts/post-validation.ts`); the server's answer is shown as one English sentence (`apiMessage`). The drawer's bot select hides under "More options": a channel brings its own bot, else the default bot.
- **Ask the agent** = a one-off pin rule (`POST /api/agents/:handle/schedule-rules`, kind `pin`, `at_local`, `format` = the channel's `text` if it allows it else its first format, `brief` 10 to 600 characters, `valid_from` = `valid_until` = the day). It is offered only when the Calendar passes it (some orchestrator exists) and disabled with a one-line reason when the channel has no agent, the agent is off or paused, or its schedule did not load; the time must be at least 5 minutes ahead on the agent's clock. The line under the buttons follows the agent: "writes it at 12:00 Kyiv, the draft lands in Inbox → To approve" (approval mode), "Shadow mode: nothing is published", or "writes and publishes it". The planner materialises a pin only for today and tomorrow (resource-local); a pin further out shows on its day as "Pin · not planned" until then. The server's first warning (quiet hours and the like) is appended to the toast.
- **Undo (10 s toast):** a scheduled post is canceled; an edited post is restored (PATCH with the old fields); an asked-for draft switches the pin off (`PATCH active:false`; the server drops a slot that has not run yet); a canceled post is re-created from its fields (it gets a new id; the canceled row stays in Scheduled's history).
- **Outside B4's ownership (besides the schedule DTO):** `components/AppShell.tsx` (the New post button and the ⌘K "New post" action now go to `/app/calendar?compose=new`; nothing else); `api/schedule.ts` (the `error?` field). Not touched: `nav/registry.ts:85` still carries the comment "until then it redirects to Scheduled" (A2's file; the entry itself is right). The Scheduled page's own "New post" buttons still go to `/app/compose`.
- **New files:** `api/calendar.ts` (hooks), `lib/calendar.ts`, `lib/post-problems.ts` (+tests), `components/calendar/{CalendarPage,WeekGrid,ComposerDrawer,useMinute}`, `calendar.css`, `post/composer.css`. `post/stub-css.test.ts` is a test helper (a node loader hook that stubs `.css` so `PostComposer.test.ts` can render the component); it holds no tests.
- **Tests:** `lib/calendar.test.ts` (window, `?from=`, Kyiv instants, chips, rows, the pin rule, the address), `lib/post-problems.test.ts`, `components/calendar/WeekGrid.test.ts` and `components/post/PostComposer.test.ts` (server-side render of the first paint, as in A3); typing, validation timing and the Ask the agent flow are in the browser checklist.
- **Browser checks for B4 (1280 and 375, reduced motion; mock on 3178):**
  - `/app/calendar`: headings "Calendar" and "Week calendar"; today's column head has the accent day number; AI Global's Thursday cell shows 5 chips and "+19 more" (attention first), "+N more" expands in place; `@pdr_dev_channel` (mode off) shows grey dashed "Series · agent off"; AI0 Prompts shows amber awaiting-approval and green approved marks; the legend names every mark. Prev/next move 5 days and Today returns; `?from=2026-11-02` keeps the window; hover a past cell: no Add; hover a future cell: dashed "Add" (always visible on touch).
  - A slot chip opens `/app/editor/slot/$id`; the agent name opens the agent page; the owner's chips (solid light) open the drawer (pending: edit with "Cancel post"; sent or failed: read-only).
  - Add on a future cell opens the drawer with that channel pressed, the day set, 12:00 Kyiv, the cursor in the text. Press Schedule on the blank form: the problems appear together and focus goes to the first one; before that, tabbing through fields shows each field's problem only after leaving it. More options holds sender, media and buttons. Sheet footer stays in view while the body scrolls; at 375px the drawer is a bottom sheet.
  - Ask the agent (only the mock's GETs work: on the mock a POST is the lead's call): pick `@pdr_dev_channel` (off): the one-line reason shows and the button is disabled; pick `@recipes_dev` (approval): the line says the draft lands in Inbox → To approve.
  - Top-bar New post and ⌘K "New post" open the drawer on `/app/calendar`; `/app/compose` and `/app/scheduled` still load. Back closes the drawer. `?compose=edit&post=nope` shows "This post is not here any more". Kill the API (or point it at a 404): the page shows its banners and "The calendar could not load" with Try again.

### B5
Landing (`/`), built from `research/landing.md` and `Main.dc.html` as a layout and behaviour reference (no hex, no Geist, no sample texts as data).
- **Data, not the prototype's story.** The hero pill, the agent log, the orbit, the explorer's lit roles and platforms, the marquee and the network heading all come from the existing public payloads; nothing is invented.
  - `agent.log` is phase 1: lines made from the pulse aggregates (posts, autonomy share, skips, ideas reviewed, owner decisions, runs). There is no activity endpoint (gap L1), so nothing is streamed.
  - The orbit draws the agents that the *networks* carry (`LandingNetwork.agent`). Agents of channels outside a network are not in the payload; the backend addition (`agent` on `LandingNetworkResource`) was not made. With no agent it draws ghost slots.
  - The explorer's "Orchestrator ×N" is live + in training (`orchestratorsLive + orchestratorsShadow`); the hero pill "Live · N agents" counts live only. They can differ, on purpose (the explorer's `title` says "live and in training").
  - The #networks heading is `networkHeadline(networks)` ("7 channels and profiles / 4 run by AI agents today"), neutral "The network" while loading, on error or with nothing to show. The prototype's "Seven channels. One agent in charge of each." is false for pipeline channels and was not used. Counters keep "followers reached / channels & profiles / platforms" (the prototype's "platform live" is not computed).
  - The explorer's platform pills have no "soon" claim; a pill glows only when an agent published there this week.
  - `ProofStrip variant="row"` leaves out the agents-live tile (it is the pill now); the default tiles of `/white-label` are unchanged. Zero-hide, the "?" definitions, the stale note and the pulse-error hide are kept.
- **Hero entrance is CSS** (keyframes with `both` fill), not motion, so the text never waits on requestAnimationFrame; the headline finishes in 0.8 s. Sections below the hero use motion `whileInView` once (`Reveal`, `DrawLine`). The mesh "breathing" animation of the prototype was dropped; marquee dots are static.
- **Compositor-only loops**, with two documented exceptions: the approval deck's `z-index` step (discrete, in `lp-deck`) and the loading skeleton's `background-position` shimmer (it was already there). Prototype loops that animated `top`, `left`, colour, border or shadow (scan, travel, token, step and gate lighting) are transform / opacity: a lit step or gate is an overlay pseudo-element fading in and out, the token moves with `translateX(cqw)`. Pinned by `landing-motion.test.ts`.
- **Off-screen pause**: `LoopScope` (an IntersectionObserver toggles `.is-offscreen`, one rule pauses everything under it, no React state). Every section that loops is a scope: hero, marquee, how, loop, human, networks, white-label (inside `WhiteLabelSection`) and the closing call to action; the advertise section has nothing that loops.
- **Reduced motion** is the global block of `index.css`; no override was written for an animation. The only reduced-motion rule in the landing css changes layout (the marquee becomes a wrapped list of channels, the outline words go). Still states: the deck is a stacked pile, the token rests at the start of the rail, the sweep rests, no step or gate is lit, the connector dots are hidden. `Reveal` and `DrawLine` render plain (final state) under reduced motion and where there is no IntersectionObserver.
- **No-JS**: there is no such state (the dashboard is a client-rendered SPA, `index.html` has only `#root`). What is guaranteed instead: counters carry their final number in the markup and in an sr-only span, entrances end visible.
- **"| DEV"**: `publicTitle()` (tested) is applied to channel cards, network headers, the marquee and the media kit (title, ad-link aria-label, "No Telegram?" target). Server side is untouched: the DM prefill text built by `landing-networks.service.ts` and `ads-public.controller.ts` still carries the dev title, and the tracker re-syncs the Telegram title, so the clean fix is to strip at read time on the server (`mapTracked`, media kit).
- **Anchors and CTAs unchanged**: `#top`, `#how-it-works`, `#networks`, `#advertise`, `#order-an-ad`, `#white-label`; placements topbar, hero (+ No Telegram), howitworks, advertise, mediakit, network, resource, footer, whitelabel; white_label beacons from hero and footer; `LandingCtaProvider`, `AdLeadModal`, the lead-form source regexes. The `howitworks` placement stays under the ad steps, so the advertise section has two ad buttons (steps, then after the media kit), counted apart. The steps' "See prices" fallback is gone: with neither a DM link nor the form (the admin preview) there is no button. The nav's White label link is new (the old page had none in the top bar) and sends no beacon; white_label beacons stay on the hero link, the footer link and the section's offer button.
- **White label on the landing**: three cards chosen by title (`LANDING_WL_TITLES`: Agents for your resources, MANAGER and a KPI digest, Guard rails in code), because "Shadow first" is the demo and the delivery is the single-tenant note. `WhiteLabelFeatures` got a `titles` prop; `WL_FEATURES` is not reordered; `/white-label` still shows all six. `/white-label` itself was not restyled (no landing css, no demo).
- **Network cards**: hover lifts 6px with the individual `translate` property, not `transform`, because motion leaves an inline `transform: none` on the card after its entrance and that beats a hover `transform` (the old -3px lift probably never showed). The spotlight is the existing per-platform glow, `opacity` 0.35 to 1 over 0.35 s on hover or focus. Both show in the `/app/landing` preview (shared component). Grouping, "Ads here", "Advertise in this network", the 3-state badge and the empty state are kept.
- **Copy**: the human-in-the-loop lead says "from 20:00 the agents write most of tomorrow's posts" (true: `approval-timing.ts`). The deck cards are English placeholders ("Morning digest", "Quiz question", "Daily pick"), aria-hidden, with an "Illustration" note; the "Approved" stamp is not uppercase (only `.text-overline` is).
- **Files outside B5's ownership**: `components/ui/Icon.tsx` (appended `gauge`, `moon`, `power` and a second lucide import line, the same place A2 appended `ellipsis`, `logout`: expect a trivial conflict); `lib/no-cyrillic-ui.test.ts` (ALLOW: `HowItWorks.tsx` and `routes/index.tsx` replaced by `components/landing/AdSteps.tsx`; the `#реклама` lead in `index.tsx` is gone, the label lives in step 4).
- **Removed / kept**: `HowItWorks.tsx` and `AgentHierarchy.tsx` are deleted; `diagramNodes` stays in `landing-view.ts` but is unused. `MediaKit.tsx` exports `MediaKitCards` (presentational) next to `MediaKit` (the hook), so it renders in a test.
- **Mock bug found**: the mock API returns `autonomyShare` as a fraction (0.86); the real backend sends an integer percent. The landing shows what the payload says, so the hero reads "1%" on the mock.
- **Not verified in a browser** (the lead's pass): 375px layout, the orbit and ring geometry, the hover lift, the Shadow / Live switch, the deck and token timing, `prefers-reduced-motion`, off-screen pausing, the sticky nav on anchor jumps. Full-page screenshots taken without scrolling show the sections below the hero empty until they are scrolled into view (that is how `whileInView` entrances behave).

### Lead: wave B merge and review
- Merged B1 → B2 → B3 → B4 → B5 (`da39d51e`, `8e376816`, `7f3d625f`, `e2850d2f`, `08832621`). B3's change of `routes/app.agents_.inbox.tsx` lost to B2's thin route (the effects link lives in `lib/inbox-kinds.ts`). The stamp unit test follows A's upsert (`4b671097`); the Inbox and its approvals view have no "Agents" parent crumb (`4a5ddafc`). Browser on the mock at 1280 and 375: the 12 prototyped routes render, no page-wide horizontal scroll; at 1280 they match the prototypes.
- Lead calls: the Today errors tile stays removed, "Run now" stays hidden, the 601–860px Inbox drawer is accepted. B1's `NetworkHealthCard`, `useUpcomingSlots` and `AiSpendCard` lost their users; removed after wave C if nothing else picks them up.
- Adversarial review (lenses: correctness, data truth, interaction and focus, motion and accessibility; each finding checked by a skeptic): 13 confirmed. Fixed:
  - **The Today timeline was an hour off on the two DST days**: minutes counted from Kyiv midnight as elapsed time, not wall clock. `axisMinutes(at, day)` reads the wall-clock parts (test on 2026-10-25 and 2027-03-28).
  - Today's headline could claim a count before the approvals answered: `loaded` waits for both.
  - "Got it" in the Inbox detail toasted twice (the note's own toast and the page's): `NoteActions` takes `onRead`, the page's handler owns the toast.
  - **Undo after a mark-read could reopen a note the owner had settled in Telegram** in the meantime: `POST /api/agents/inbox/read` answers the ids it changed (`OwnerInbox.markReadIds`); the Inbox's Undo and Today's Dismiss only reopen those, and Today says "Already done" for the rest. PG test added.
  - The agent page's More menu: the button now toggles it, the menu gets the button as its `anchor` (focus returns there), and `onClose` is stable (it re-ran the menu's effect on every render).
  - Resume's Undo restored a stale or past `paused_until` (the server refuses a past one): it now puts back an open-ended pause, or the date only while it is ahead.
  - The Overview's Lock switch sent back the formatting as the page loaded it, overwriting an agent's change made since: it refetches, then flips only that lock.
  - The Calendar composer remounted at Kyiv midnight (its key held a day computed from today) and dropped typed text: the start day is fixed when the drawer opens and only an address `day` is in the key.
  - The composer's unsaved flag outlived the composer (a post that went out while open then asked "discard?" on a read-only sheet): cleared on unmount.
  - A failed posts request showed "This post is not here any more" for an edit link: it now says the post could not load, with Try again.
  - With the channels failed, every own post landed in "Other channels" labelled "0 channels without an agent": a banner says the channels did not load (Try again), and a row that holds only posts reads "Your posts".
  - Landing under reduced motion: the agent log kept its 196px masked window over a list that no longer scrolls, and its aria-hidden loop copy showed; now the log shows whole, once.
  - Landing orbit: a tile that mounted after its ring started spinning kept a tilted label; each tile's counter-rotation is put on its ring's clock (`getAnimations`) when the tiles change.

### C1
Restyle only: data flow, endpoints, routes and search params are unchanged. The exceptions are listed under "Behaviour that differs".
- **Area file and shared parts.** All page CSS is `components/channels/channels.css` (prefixes `ch-`, `ent-`, `roi`, `rec-`, `gr-`). `components/channels/ChannelsUi.tsx` holds `SearchField`, `ListSkeleton`, `ErrorCallout`, `LoadingNote`, `SectionCaption` and `ChannelGlyph`. `lib/channel-view.ts` (+ 4 tests) holds `TRACKING_META`, `channelInitial`, `channelName`. Worth promoting to `ui/` if other batches want them: `SearchField`, `ListSkeleton`, `ErrorCallout` (the "failed load" callout, red, with what failed and why) and `ChannelGlyph`.
- **Entity header is local.** `components/channels/ChannelHeader.tsx` (64px glyph, title with badges, about, one mono meta line, actions) is presentational; the page owns mutations and confirmations. If B3 or another entity page ends up with the same shape it can become a shared primitive.
- **Glyph.** Channel rows use the neutral `ChannelGlyph` (initial on `.hub-glyph.is-neutral`, mono) instead of `ChannelAvatar`: the avatar's palette is rgba and hex literals and the file is frozen. `ChannelGlyph` takes an optional `src` (recommendation photos) and falls back to the initial if the photo fails. `ChannelAvatar` is now used only by `post/PostComposer`. SectionCards on these pages pass no `icon` (no glyph tile), as in the prototype.
- **Two local tone maps, three entries each, because `lib/status-tone.ts` is frozen and has neither:** `runTone` (legacy strategy last run: ok green, error red, anything else neutral, in the channel page) and `CONFIDENCE_TONE` (ROI low / medium / high, in `RoiPanel`). Both are categories, not statuses of the app. If a later batch wants them shared, move them to `status-tone.ts`.
- **Framing moved to the callers.** `RoiPanel` has no frame; the channel page, Analytics and `ChannelDialog` wrap it in a SectionCard. `ForwardRoutesPanel` and `CrosspostSection` render their own flush SectionCard (they take `delay`).
- **Channel page.** The error state has an "All channels" button, not "Back to channels": `nav/registry.test.ts` (FR-013) forbids `Back to ` and `← ` on detail pages. The page's own shadowing `StatStrip` function was removed in favour of the primitive. Tier change and pause / resume keep their confirmations.
- **Tracked.** The tracking-state legend row is gone (each Badge has the explanation as its title). On Channels the `?bot=` filter is a removable `chip-toggle` beside the search field.
- **Add / Edit channel modals.** The `tabs-pill` markup is `SegmentedTabs`; Cancel is `btn-ghost`; errors are `ErrorCallout`; the `as any` link casts are removed (the typed `Link` compiles).
- **Behaviour that differs from before (all small, none touch data):**
  - Recommendations with no target channel (the query is disabled) rendered nothing under the controls; it now shows "Pick a target channel", and with a zero budget "Enter a budget". The "Sort" box is gone (the order is fixed and named in the page subtitle). With zero results, "Edit themes" is offered as the next action. `TargetChannelPicker` stays a disabled select while loading or after an error (it was a text line, so the form jumped).
  - `ChannelDialog` linked to a literal `/channels/${id}` (not a route; the page is `/app/channels/$id`); it is a typed `Link` now, with an "Open on Telegram" button beside it.
  - `ChannelDialog` and `EdgePanel` are on `Modal` (`lg` and `drawer`), so they close with Escape and the backdrop and become a bottom sheet on phones. The hand-rolled fixed sheets did none of that. `EdgePanel` dropped the repeated per-post avatar (the source channel is the subtitle) and its emoji stats (mono "views / forwards / reactions / comments").
  - Graph: the layout switch moved into the `PageHeader` actions; the nodes / edges `Metric` pair is a two-tile `StatStrip`. Link kinds are `chip-toggle[aria-pressed]`; with no kind picked every chip is pressed, as before.
- **Graph colours.** `GraphCanvas` is untouched. Its `themeColors()` reads `--color-ink`, `--color-ink-muted`, `--color-accent`, `--color-surface-2`, `--color-hairline-strong` and `--color-canvas`; all six still exist in `index.css`, and nodes, labels and the frame render in the new palette on the mock. The `?synthetic=` harness is unchanged.
- **Left as is:**
  - Error callouts print `Error.message`, which for an API error is the JSON body (`{"message":"..."}`). `api/client.ts` is read-only here; parsing the message there once would fix every page.
  - Analytics picks the channel or account with a native select (many options), next to the Telegram / Meta tabs.
  - The recommendations table is a real table: at 375px it scrolls inside its own frame (the shared `ActionsTh` is 240px wide).
  - A failed "Track" in the recommendations table shows nothing (unchanged; the button is disabled for private invite links).
  - On a phone the Discovery search field sits on its own line in the panel head.

### C2
- **Panel glyphs dropped on the Connections managers.** The rulebook example shows a `SectionCard` icon, but five panels in a row with five identical-weight glyphs added noise next to the 36px row glyphs; the title and the Add button carry the head. The Meta account page keeps `icon` on its token and chart panels.
- **`components/connections/ConnUi.tsx` is a local helper, not a new shared primitive** (`ConnPanel`, `ConnAdd`, `ConnState`, `ConnError`, `ConnRow`, `ConnStat`, `ConnFact`). If C1 or C4 want the same row, promote it; nothing outside `connections/` and the Meta account route imports it.
- **Meta rows gained the 24 h change and a "Refresh stats" button** (`useRefreshMetaStats`, already in `api/meta-accounts.ts`). B1 removes the Meta block from Today, so this is the one place left that shows the change and triggers a collection. No endpoint or data-flow change.
- **Eyebrow of `/app/connections`** reads "N connections · M with errors" from the five list queries (`lib/connection-counts.ts`); a count stays `undefined` until its list loads, so a 404 on one endpoint hides that tab's count and the total instead of showing a wrong one.
- **The info notes in the Add dialogs use `.inset`, not `callout-warning`.** They say where the secret goes; nothing needs the owner, so amber (the colour of the human) would be wrong. Errors go through `describeError`.
- **Meta account page:** the hand-made header (`h1.text-display-md`, avatar, chips) became `PageHeader`; the avatar and the state chips moved into an "Account" row (36px lead, handle, platform chip, Active / Paused, Verified / Verify error, target id, last verify). The full `verify_error` text is now shown under the row (it was a tooltip only). The local `Field` that shadowed `ui/Field` is replaced by `ConnFact`. The three tiles became a `StatStrip`; Followers has a sparkline of the last 30 points.
- **Health: a clear section is one compact row, not an `EmptyState`.** Four stacked empty states would bury the two panels that have content, and "nothing wrong" is a status line, not an empty list. The head count ("clear" / "2 problems") stays. Statuses are `SeverityPill` with the state's own label (critical for token invalid, no access, blocked, failing; action for rate limited, expiring, nothing new). The budget bar is a 6px `.hl-meter` with `anim-grow-x`.
- **Health eyebrow and the status line:** `app.health.tsx` calls `useNetworkHealth()` itself (same query key, one cache entry) for the eyebrow "N things need attention · updated 2m ago"; the old inline status line in `NetworkHealthView` is gone. The `StatStrip` shows what needs fixing per section and the fullest cap (a blocking cap wins over a higher percentage).
- **`NetworkHealthView.tsx` is shared with B3 (`AgentLink` tab type).** The `AgentLink` block is textually unchanged and keeps its place; the neighbours (`List` removed, `Count` rewritten) are separated from it by one blank line each, so a merge should be clean but check it.
- **Map HUD bug fixed on the way:** `.map-feed-text { color: var(--color-danger) }` was unconditional (every feed line was red) and `.map-feed-icon` had its box styles only under `.is-bad`. Now only a failed event is red (`danger-ink`) and the icon box applies to all.
- **Map HUD sizes:** the legend mode pill (8.5px), the beacon number (9px) and the unit emoji in the drawer lead (10px) are 11px now; the half-pixel sizes of the HUD (12.5px) are 13px. The SVG stage text (building titles, unit labels, level badges at 7.5 to 10.5px) is geometry that scales with the zoom, so it is left alone, as the brief says.
- **Map reduced-motion block kept as is.** `map.css` still uses `animation: none !important` for `.map-drawer`, `.map-fx`, `.map-beacon` and a few more. The rule against it is about elements that start at `opacity: 0` (`.compose-rise`); none of these do (the drawer's base opacity is 1, the effects are one-offs), and the block also stops the infinite loops (beacon, live dot, working units). Not worth a risky rewrite of a SMIL-adjacent file.
- **Map HUD touch targets:** icon and toggle buttons stay 32px in the flow (so the bar fits at 375px) and get a 44px hit area through `::after` on coarse pointers only.
- **Left alone:** `MapLinks.tsx` and `MapAvatar.tsx` (not in the C2 list); `.map-subhead` (used by `MapLinks`) is restyled in `map.css` as an overline. The per-destination tints in `MetaGroupsManager` (`#229ED9`, `#4a7dff`, `#e1497f`, `#c7c7c7`) are kept: they are the allowed tints.

### C3
Editor pages (`app.editor`, `$channel`, `run.$id`, `slot.$id`, `CardEditorModal`, `EditorUi`, `SlotPlan`):
- **`EditorUi` exports and signatures are unchanged** (12 importers); two additive exports: `SlotStatus({slot, mark})` (decorative `StatusMark` + `Badge`, "Missed" amber from `slotMark`) and `runStatusLabel(status)`. `SlotRow` is a `.panel-row` (mono 48px time, status, chips, clamped topic link, description, Preview, `RowActions`); its `delay` prop stays in the type and is ignored. `SlotCounts` is `Badge`s with `slotTone`. `ModeSwitch` got an `ariaLabel`. `JsonBlock` is `.code-block`.
- **No CSS import in `EditorUi` / `SlotPlan`.** `AgentsUi` imports `EditorUi` imports `SlotPlan`, and `NoteActions.test.ts` (node) renders that chain, so a `.css` import there breaks the test run. Both style themselves with the global classes plus inline layout. `editor.css` is imported by the routes and by `CardEditorModal`.
- **`CardEditorModal` is a `size="drawer"`** (it was a centred dialog), form groups are hairline-divided `.form-group`s, sources wrap on a phone, Cancel is `.btn-ghost`.
- **Run trace is a timeline:** each step is a `button.panel-row.trace-row` (index, dot on a spine: ring = model turn, dot = tool call, square = error; Badge; clamped summary or error excerpt; tokens, cost, ms; chevron) that opens the same Args / Result dialog. The spine is a `::before` on the row; it only lines up because the grid columns are fixed (36px index, 14px dot).
- **`.no-caps`:** an eyebrow (`.text-overline`) that holds a handle or a resource ref keeps its case.
- **Day label helpers** `lib/day-groups.ts` (`fmtDayShort`, `dayEyebrow`, `previousDay`, `dayHeading`, `groupByDay`) are pure, Kyiv-based and node-tested (5 tests); the editor eyebrow and the logs timeline use them.
Scheduled and compose:
- **Scheduled:** every row leads with the decorative "yours" `StatusMark`; the status Badge is `publicationTone` / `publicationLabel`, so `pending` now reads "Scheduled" (it printed the raw word). A failed row shows its error as a danger line under the preview (it was a warning icon with a tooltip, unreachable on touch). Cancel is a danger icon button behind a divider. The three hand-made skeleton cards are one quiet placeholder panel. **No status filter was added** (new behaviour; the spec says the page later becomes `calendar?view=list`).
- **Compose:** the hint band is an `.inset`. New: a `.callout-danger` when the post to edit cannot be loaded (before, `?id=` with a 404 showed a silent blank form under "Edit post"). `PostComposer` and the `--color-tg-*` preview colours are untouched.
Logs:
- **The CSS is in `components/activity/activity.css`, not `components/logs/`:** `apps/dashboard/.gitignore` ignores anything named `logs`, so a file there cannot be committed without `-f`.
- **The spinner and its page-level `<style>` are gone.** A running event is a `StatusMark` (it pulses through the global `is-pulse`), so the hand-rolled `prefers-reduced-motion` override is not needed. The hover wash is `.panel-row:hover`, not `onMouseEnter`.
- **Counts:** `/activity` returns only the total of the filter in force, so the number rides on the selected type tab (hidden while a new filter loads); the other tabs have no count (one request per tab would be new data flow).
- **Event tone comes from the status map** (`posted` = published, `error` = failed, `skipped` = skipped, `running` = running). `skipped` is therefore neutral (it was amber); labels stay "Posted / Error / Skipped / Running".
- Strategy-run rows are real `<button>`s (`aria-expanded`), not clickable divs. Times are Kyiv (`formatIn`) with a "Kyiv time" note in the panel head and one heading per Kyiv day (Today / Yesterday / "Thu, 29 Oct"). The filter selects and date inputs got `aria-label`s.
Spend:
- **Section tabs are `variant="underline"`.** The blocking count is a `count` plus the `ban` icon on Budgets; the old label "Budgets · N blocking" lost the word "blocking" (the tab's own callout says it). A tone on an underline tab does nothing, so the count is neutral.
- **Caps and per-agent caps are rows with a 6px meter** (`.spend-bar`, fill colour from `budgetBarColor` through `--bar`), not 9-column tables; the report breakdown and the price table stay tables in padded panels. `.callout-*` are flex rows now, so the multi-line warnings got an icon and a column wrapper. "Shadow runs only" is a `.chip-toggle`. Modals use `.modal-foot` with a ghost Cancel.
- **`SpendChart` is untouched.**
Local helpers worth promoting to the shared CSS (the lead's call):
- `.kv-list` / `.kv-row` (key / value rows), `.panel-note` and `.block-divider` in `editor.css`.
- The spine-dot-text row: `.trace-row` (editor.css) and `.log-row` (activity.css) are two copies of one idea; both could be a `.timeline-row`.
- `.spend-bar`: the 6px meter is hand-drawn in the sidebar budget card, `overview/BudgetBar` and here.
Left as-is, and why:
- The price table is 11 columns with the 240px `ActionsTh`, so it scrolls inside `table-wrap` at 1280 (preexisting; a column diet would change the data shown).
- "Tokens in / out" in the report strip wraps its value at ~1280 with the sidebar open (five tiles in one strip).
- `PostComposer` (B4's), the compose page's `--color-tg-*` colours, the logs filter selects' inline 12px type.
- `ApprovalCard`, `DraftCard`, `AgentPlan` (in `SlotPlan`) only lost stray sizes; their layout is as before.
Gotchas:
- `.panel-row:first-child { border-top: 0 }` removes every hairline when each row is wrapped in its own element (the logs `.log-ev`); `activity.css` puts it back with a more specific rule.
- The Browser pane is shared: another agent's navigation moved my tab to port 3121 mid-session. Use an own tab and front it (`tabs_select`): a background tab freezes `compose-rise`, so a screenshot shows the page half faded.

### C4
Area files: `components/agents-list/agents-list.css`, `components/strategies/migration.css`, `components/models/{models,model-select}.css`, `components/dm/dm.css`, `components/settings/settings.css`. Behaviour, endpoints, routes, search params, element ids and hook order are unchanged.

- **Deviations from the prototype language**
  - Glyph tiles (`SectionCard icon`) are dropped from every C4 panel head, as in the prototype; `AgentGlyph` stays on agent rows.
  - `/app/agents`: Orchestrators come before System agents; the KPI strip is "Agents today" (Orchestrators with "N live · M not live", Paused, Runs today, Spend today). `components/agents/*` is frozen, so `OrchestratorRow`, `ChildRow` and `SystemRow` stay in the route, as before. `NeedsYou` (C5) is untouched.
  - `routes/app.agents.tsx` imports `strategies/migration.css`, not `MigrationBanner.tsx`: `lib/strategies-legacy.test.ts` imports `needsAttention` from the banner under `tsx --test`, which cannot load a `.css` file. Any module a node test imports must stay CSS-free.
  - `/app/models`: the Workspace SegmentedTabs became two pressed-state option buttons (`.mdl-ws-option[aria-pressed]`) with the explainer text inside, because the choice is the control and each option has a sentence of its own; clicking still calls the same `change(w.id)`. The legacy channel overrides table became rows in a flush panel; the per-row entrance animation of the agents table was dropped (it was rows, not panels).
  - `ModelSelect`: all styles moved to `model-select.css`; only the popover position and max-height stay inline. `onMouseEnter={() => setHi(i)}` is kept on purpose: it syncs the keyboard cursor with the pointer (state, not a hover style).
  - `/app/dm`: the Telegram status is a KPI strip (Polling with the cadence as delta, Last polled, Pending actions, New opportunities) and an EmptyState when there is no agent session (also when `/api/agent/status` 404s). One extra request: the unfiltered `useAgentInbox({})` feeds the category tab counts; with the "All" tab it is the same query key as the list, so no second request there. `CAT_TONE.spam` went from warning to neutral (amber is the colour of the human; spam is not a call). The empty-thread note is category-aware. "Connections → Sessions" in the no-session note is a typed `Link`.
  - `/app/settings`: section tabs are `variant="underline"`; Configuration group tabs carry counts that follow the search box; each group is a flush panel with one `.panel-row` per setting; "Restart service" is `Button variant="warning" size="sm"` (it is the human's call); the restarting state is a panel with a live `status-dot`; Diff pills in the confirm dialog are mono classes; sessions are rows, the sign-in audit stays a table (in `.table-wrap` inside a padded panel, not a flush one, so the table frame does not double the panel frame).
  - NavigationTab: restyle only; `navc-label-<id>` / `navc-hidden-<id>` and all behaviour are as in wave A. The `.navc-*` base block in `index.css` (frozen) is tuned from `settings.css` (radius-lg groups, 14px inputs, mono meta and preview titles). The sticky bar uses `var(--shadow-2)`, which falls downward while the old inline shadow rose upward; the bar's hairline border carries it at the bottom of the window. `btn-tiny` in the bar and the two callouts became `btn-ghost|secondary btn-sm`; row buttons in the Hidden panel stay `btn-tiny`.
- **Local helpers worth promoting** (all in area files; the lead may lift them into `index.css`)
  - `.btn-secondary.is-danger` (settings.css) and `.btn-ghost.dm-danger` (dm.css): the quiet destructive button (Sign out everywhere, Reject, Archive). `.btn-danger` is for a confirm only and `btn-tiny-danger` is too small for a panel head.
  - `.mdl-ws-option` (models.css): a large pressed-state option tile; `.chip-toggle` is too small to hold a sentence.
  - `.mdl-note` / `.set-intro` / `.set-muted` / `.set-dim`: muted prose and dim-text helpers; today every page writes `color: var(--color-ink-muted)` inline or invents a class for it.
- **Left as is, on purpose**
  - `routes/app.agent.tsx` (redirect-only), `components/agents/AgentsUi` `Toggle` in the Configuration rows, `nav/NeedsYou` (C5), `ConfirmDialog` (frozen `ui/*`).
  - `AgentGlyph` is called with a numeric `size={28}` on child rows; B3 owns `components/agents/*` and may change the signature.
  - The `.navc-*` copy in `index.css` is now partly overridden by `settings.css`; the lead can fold the overrides back and delete the duplicate rules.
  - `CompactCard` dialogs (DM threads and pending actions) keep their own footer via `dialog.actions`; only their bodies were restyled.

### C5
Restyle only: no endpoint, search param, route, data flow or keyboard behaviour changed. `app.setup.tsx` and `app.steering.tsx` are redirect-only and untouched. No file outside C5's ownership was edited (apart from this file).

- **Where the CSS lives, and why artifacts have none.** `components/chat/chat.css` (chat page, menus, tool chips, card dialogs) is imported by `routes/app.chat.tsx` and by `nav/NeedsYou.tsx`; `components/nav/needs-you.css` by `NeedsYou.tsx`. `tsx --test` cannot import `.css`, and `SlashMenu`, `ArtifactChip`, `ArtifactList` (and through it `ArtifactPanel`) are loaded by node tests (`lib/align.test.ts`, `launch.test.ts`, `sysadmin-audit.test.ts`). So those components import no CSS: the menus rely on `chat.css` being loaded by the page that renders them, and the artifacts components use only global classes from `index.css` (inline styles for layout). Overrides of global classes in the area files use compound or element selectors (`h1.chat-title`, `textarea.chat-input`, `.hub-glyph.chat-glyph`, `div.chat-text`, `.input-field.chat-channel`, `.inset.example-item`) so they win regardless of chunk load order.
- **Local helpers worth promoting to `index.css` / `ui/*` if a second page needs them:** `.chat-suggest` (empty-state suggestion button), `.verdict` plus `.chip-toggle.is-bad` (a two-way good / bad toggle), `.chat-menu*` (an anchored pick list with keyboard highlight), `.chat-item` (selectable list item with an accent bar), `.chat-sched-list`, and the NeedsYou panel (a flush panel with an amber 30% border, for "a human has to act").
- **Chat layout.** The 3-column grid, the full-bleed layout, the scroll containers, the composer keyboard handling and the Mention / Slash menus stay. The h1 stays a compact `text-subhead` (`h1.chat-title`), no `PageHeader`. The composer has a `:focus-within` accent ring. Escape now closes the chat-list drawer (new, small), and the drawer enters with `anim-fade-up` (`anim-slide-left` drifts in from the wrong side at 16px).
- **`ApprovalStrip` is a button disclosure** (`aria-expanded`, `aria-controls`, rotating chevron) instead of `<details>`. `ToolChips` use `aria-expanded` and a `role="img"` status.
- **Chat list.** The delete-chat button is now `btn-act btn-act-danger hover-reveal` (shown on hover / focus, always visible on touch); it was always visible. Scheduled posts are rows in one hairline group, not a stack of cards, and their format is a neutral `Badge`.
- **Tones.** `DRAFT_TONE` (DraftCard) now derives from `publicationTone` (`lib/status-tone.ts`), so a `scheduled` draft is neutral where it was warning, as the status map says. `ACTION_TONE` (ActionCard, what kind of change a proposal is) and `artifactTone` (`lib/artifacts.ts`, artifact lifecycle) are separate domains with their own words and were left alone.
- **NeedsYou.** Now a flush `SectionCard`-style panel (`panel is-section is-flush`) with rows. The severity label "Info" became "FYI" because it uses `SeverityPill` instead of a local map. The `More` line is a `.panel-foot` with a `.panel-link`. `CardOpener` and `chatsWaiting` are unchanged.
- **Card dialogs** (`ActionCard`, `DraftCard`, `ContentExamplesCard`): key / value facts are `.card-kv` with a `.text-overline` key, payloads are `.inset`, code is `.code-block`, quotes are `.card-quote`, mono is `.mono`. The good / bad verdict toggle is a `role="group"` of two `chip-toggle` buttons.
- **Left on purpose.** `TelegramPreview` and `RichMessageView` keep their `<details>` (Telegram's own rich-message blocks and the fallback disclosure) and their colours (they imitate Telegram, per the design language's per-destination tint rule). `onMouseEnter` in `MentionMenu` / `SlashMenu` stays: it only sets the keyboard-highlight index, not a style.
- **`ArtifactPanel.GenericActions`:** the first non-danger action is `btn-primary`, the others `btn-secondary`, danger stays a ghost in the danger colour (the old code painted all of them the same).
- **Artifacts page.** `PageHeader` with a shorter subtitle and Setup from history (secondary) / New steering (primary); no eyebrow. The type filter is `chip-toggle` buttons with a mono count; the status filter is `SegmentedTabs` with counts. Both counts come from `useArtifacts({ agent, limit: 200 })`, which is the list's own cache entry when no type is picked, so it costs no extra request; they are left out if the endpoint fails (the list shows its error). `ArtifactList` props and `MAKE_HINT` are unchanged (it is also the Agent page's Artifacts tab).
- **Verification.** Node 20.19.6: dashboard `tsc --noEmit` clean, 398 node tests pass, `vite build` builds (chat and NeedsYou area CSS appear as their own chunks). An SSR smoke render of `ToolChips` and `SlashMenu` gave the expected markup. Not done (lead's): the browser checklist below.
- **Browser checklist for the lead (mock API, 1280 and 375, reduced motion):**
  - `/app/chat`: three columns; list drawer at 375 (Escape closes it); artifact panel as a sheet; composer focus ring; `@` and `/` menus (keyboard highlight, mobile variant); ApprovalStrip disclosure; empty state with suggestions; delete button reveal on hover and focus; no page-wide horizontal scroll.
  - NeedsYou on `/app/chat` and `/app/agents` (amber border, FYI pill, More line).
  - `/app/artifacts`: type chips, status tabs with counts, agent select pushed right, empty states for a type and for "Needs you", the card dialog with the panel (rules, memory, versions, diff, actions), `?open=type:id` and `?type=` deep links.
  - The Agent page Artifacts tab (same list).
  - A dialog from `ActionCard`, `DraftCard` and `ContentExamplesCard` (`.card-kv`, `.inset`, the verdict toggle, warnings).

### C6
- **No section glyph on the C6 panels.** The prototype's panel head (`.ph`) has a title only, so the data, ads, landing-admin, leads, CTA and report panels pass no `icon` to `SectionCard` (it stays optional). Empty states keep their medallion icon.
- **Local `SkeletonRows` (`components/SkeletonRows.tsx` + `skeleton-rows.css`), a candidate for `ui/`.** A few shimmering rows (`rows`, `height`, `flush` to pad like a `.panel-row`, `label` for the status region). It replaces three hand-rolled shimmers (`la-skeleton`, the data pages' "Loading…" text, the report's grey box) and relies on the global reduced-motion block (the old `.la-skeleton` had its own `animation: none` guard, which is gone). Used by data, ads, landing admin and the report.
- **Status maps stay local where the domain is not a slot or a publication.** `lib/status-tone.ts` covers slots and publications only, so the dataset status (`DATASET_STATUS` in `lib/data-store.ts`), the import status (`ImportHistory`), the ad order status (`lib/ad-orders.ts`, node-tested: names, tones, why a paid order is flagged, the counts) and the lead status (`LeadsCard`) are typed `Tone` maps next to their pages. If the lead wants one place for every status, these four are the ones to move.
- **KPI strips are derived on the client from the lists the pages already load, no new endpoint:** `summarizeDatasets` (datasets, rows, unposted, last import; "Unposted" reads "—" until the stats job has run), `summarizeOrders` (awaiting payment, paid and still to schedule, scheduled, flagged, published; hidden while there are no orders) and the CTA totals (the old Total row of the table became a six-tile `StatStrip`, so the table has no Total row any more).
- **Ads: New order is a drawer.** The inline form that sat above the list is now `Modal size="drawer"` opened by the page's primary button ("New order"); fields, validation, `useCreateAdOrder` and the reset-on-success are unchanged. Order rows are `.panel-row`s with a `Badge` status; the payment-link and schedule dialogs keep their fields and the `useConfirm` flow of the price list is unchanged. The Cyrillic allow-list strings of `routes/app.ads.tsx` are kept verbatim.
- **Filter tabs without counts.** `SegmentedTabs` options get no `count` on the Leads kind filter and on the dataset Rows filter, because the list endpoints are filtered on the server and give no per-option totals (the total is in the panel head instead). The dataset and landing section tabs are `variant="underline"` and take none.
- **Landing admin.** Its tabs are `variant="underline"` (they are sections of one page). The four inline `<style>` blocks (page, Networks, Public page, Leads) are one file, `components/landing/landing-admin.css` (`la-`, `nc-`, `pp-`, `ld-`, `cs-`). `Panel` from `ui/Card` is no longer used there; resources and networks are rows in flush panels (a featured resource is `.is-selected`, a hidden one recedes with `.la-hidden`). The lead dialog lost its double padding (the wrapper padded inside the dialog's own).
- **Import wizard.** The "Into" radio is a `SegmentedTabs` ("An existing dataset" / "A new dataset from this file"); `Check` and `RoleSelect` are still exported with the same props. The wizard's logic is untouched.
- **Schema editor.** The floating save bar is `role="region"`, sticky at the bottom with `--shadow-2` (the only floating element of the data pages); the table inputs got `aria-label`s.
- **Sign-in and 404 are a `.panel.is-section`** (`card-featured` is no longer used by C6 pages) with the classes in `components/auth/auth.css`. The 404 button reads "Go to Today" because that is the registry label of `/app`; `routes/app.index.tsx` (frozen here) still titles itself "Overview", which B1/the lead may want to align. `.auth-pending-dot` in `index.css` (frozen) still carries its own `@media (prefers-reduced-motion)` rule with `animation: none`; harmless for a dot at full opacity, but it breaks the A1.5 rule if the lead sweeps for it.
- **Report.** `report.css` keeps the `.rp-*` names; the page uses `PageHeader` (the stage badge is its action), `StatStrip` for the four metrics and `SectionCard` for the curve and the link note. The curve is drawn at the width of its box (`ResizeObserver`, 240 to 760 units, 1 unit = 1px), so its 11px axis labels stay 11px at 375px instead of shrinking with the 640-unit viewBox; the tick thinning (56px) now works in real pixels.
- **Files outside the C6 ownership list:** `lib/data-store.ts` (+ test) gained `summarizeDatasets`, new `lib/ad-orders.ts` (+ test), new `components/SkeletonRows.tsx` and `skeleton-rows.css`, and this file. Nothing frozen was edited.
- **Not touched on purpose:** routes, search params and endpoints of every page; `routeTree.gen.ts` (no route change); `components/landing/*` besides the four admin cards; `Modal`, `SegmentedTabs`, `ui/*`, `index.css`.
- **For the lead's browser pass:** `/app/data` and `/app/data/<key>` (all three tabs; the save bar appears after an edit on Schema; Rows filter chips; the import wizard), `/app/ads` (the empty list, a list with a flagged order, the New order drawer, the payment-link dialog), `/app/landing` (three tabs; reorder arrows; the sticky preview below 1024px becomes static), `/login` (token form, `?reason=`), `/report/<token>` (both stages, a report with fewer than two curve points, a bad token), an unknown `/app/xyz` path. Each at 1280 and 375, with reduced motion on.

### Lead: wave C merge and review
- Merged C1 → C6 (`8e1e51f9`, `fc00ff92`, `e72f4899`, `75a666c4`, `06e4aa3f`, `c24a4d1f`). `NetworkHealthView` conflicted (C2 against B3): C2's version, with B3's `AgentLink` tab links put back. Orphans removed in `0c37e078` (`NetworkHealthCard` and the cards only Today used); the KPI digest it carried had no other home, so D4 brings it back on `/app/health`. A10's note-window test was flaky under load (a note exactly 3 days old crossed the edge; `72ca8c45`). Browser on the mock: 48 routes at 1280 and 375, no crash, no page-wide horizontal scroll.
- **Area stylesheets lost to `index.css`.** `main.tsx` imported `./router` (and through it the route modules with their area CSS) before `./index.css`, so the build put the area files first and every area rule with the same specificity as a global one lost: the channel post rows stayed one line, the indents of child agents, model children and spend roles were gone, the settings inputs kept the global padding, the `.navc-*` tuning did nothing, the landing overlines stayed grey. `index.css` is now the first import. A computed-style diff of all 48 routes before and after showed only the intended area values winning, plus one regression: the directive link in a pause banner (`.agent-banner-sub.link-accent`) turned grey; it is accent again (`agent-detail.css`).
- Review, two passes, each finding checked by a skeptic. Pass 1 (design contract, data truth, interaction, accessibility): 19 confirmed. Pass 2 (lost or changed behaviour, one finder per package): 11 confirmed, 2 refuted. Fixed:
  - Scheduled's tiles read "All posts" / "Scheduled" / "Sent" / "Failed" from `publicationLabel`, so the tile and the badge use one word.
  - Artifacts: the type and status counts come from a list capped at 200; when the cap is hit the counts are hidden, never lower than the list.
  - Run trace: the empty note follows the run ("No step has finished yet" while running; "The step details were removed after 30 days" when the run counted steps; otherwise "ended before its first model turn").
  - The views sparkline on the channel page and Analytics read the same posts as the average (own posts only: `ownViewsSpark`, tested); the channel page's "Avg views" and "Own vs reposts" tiles show "—" until the posts load, not 0.
  - Ads: the tile is "Paid" (it counted paid digest sponsorships too, which have nothing to schedule).
  - Data: the list's "Rows" tile sums all rows like the table under it; the dataset page's "Rows" is the total again (it showed active rows). The dataset key is back in its real case in the meta line (the overline uppercased it).
  - The legacy-bindings banner shows no count when its request failed (it showed an amber 0).
  - Connections: a group's remove button shows on keyboard focus. Danger hovers in DM and Settings use `--color-danger-ink`. Map HUD small buttons reach 44px on coarse pointers.
  - A failed background refetch no longer replaces data on screen: the target picker, the ROI panel (and its Recompute), Discovery's queue, Recommendations' table and the Analytics tabs keep the cached data; the error callout replaces content only when nothing was loaded.
  - DM opportunity summaries are shown in full again (they were clamped to two lines with no way to read the rest).
  - Logs: a day heading of another year names the year (`dayHeading`, tested).
  - `ErrorCallout` takes `error` and shows `describeError` (the server's sentence, not a raw JSON body). Recommendations' Track errors are toasted by the global mutation handler already.
  - The `.auth-pending-dot` reduced-motion rule (`animation: none`) is gone; the global block covers it.
- Not true as written above: C3's "`EditorUi` / `SlotPlan` style themselves with the global classes plus inline layout" and C5's "the artifacts components use only global classes" — both carry inline colours and sizes, as do about 200 other places outside wave D. Wave E1 moves them to area classes (area files of test-loaded components are imported from `routes/app.tsx`).
