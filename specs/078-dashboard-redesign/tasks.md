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
- [x] B4.1 Week grid (rows = orchestrators + Other channels; 5 days; nav; chips with StatusMark; not-planned chips; click targets).
- [x] B4.2 Composer drawer (`?compose=new&channel=&day=`), validation after submit/blur, Ask the agent (pin rule or disabled), Undo toast.
- [x] B4.3 New post button → drawer; legacy redirect test; empty/404 states.

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

### B4 Calendar (branch `worktree-wf_a4c40803-5b3-4`, base `ad17cb89`)
- B4.1 `209f07f2` week grid: 5-day window and `?from=`, rows per orchestrator plus Other channels, chips with StatusMark, not-planned projections, phone agenda, legend; schedule DTO carries the slot `error`. `e0d690a8` follow-up: a crowded cell shows what needs the owner first.
- B4.2 `b517d15d` composer drawer (`?compose=new|edit`), PostComposer drawer layout and validation timing, Ask the agent, Undo toasts. `04d31d56` follow-up: a numeric `?post=` id survives the router's search parser.
- B4.3 `af8d9948` top-bar New post and the ⌘K action open the drawer; failed-to-load states; `legacy-redirects.test.ts` pins the new route and the New post target.
- Checked under Node 20: dashboard `tsc --noEmit` clean, 445 node tests pass, `VITE_ALLOW_DEV_AUTH=true npm run build` builds; automation `nest build` builds, `lint` has no errors, `src/editor/schedule/*.test.ts` pass (54 pass, 12 PG tests skipped without a database). `routeTree.gen.ts` did not change. Browser pass is the lead's.

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
