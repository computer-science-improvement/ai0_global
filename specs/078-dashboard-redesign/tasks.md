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
- [x] C3 Publishing & spend: editor, editor_.$channel, editor_.run.$id, editor_.slot.$id, scheduled, compose, logs, spend.
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

### C3 Publishing & spend (worktree `wf_6e3bf934-224-3`, base `8f674e50`), done
- C3.1 `83432af3` editor, editor/$channel, run, slot: flush-panel rows, StatStrip, status marks, trace timeline; `EditorUi`, `SlotPlan`, `CardEditorModal` restyled; new `editor.css`, `lib/day-groups.ts` (+ test).
- C3.2 `a482ea24` scheduled, compose: StatStrip, queue as rows with the "yours" mark, publication Badge, inset hint band.
- C3.3 `7ec56399` logs: day-grouped Kyiv-time timeline, status marks on a spine, buttons that expand to the trace, CSS hover (`components/activity/activity.css`).
- C3.4 `c34a7297` spend (report, prices, budgets): underline section tabs, StatStrip, caps as meter rows, callouts, ghost Cancel (`components/spend/spend.css`).
- C3.1b `cbbdcb9a` editor: type classes instead of inline sizes, token radius for the trace error dot.
- Checked under Node 20: `tsc --noEmit` clean, 403 node tests pass (398 + 5 in `day-groups.test.ts`), `VITE_ALLOW_DEV_AUTH=true npm run build` builds. Browser pass on the mock at 1280 and 375 (no page-wide horizontal scroll on any of the 8 pages, 3 spend tabs); 404 states of scheduled and logs through a patched `fetch`.

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
