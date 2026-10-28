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
- [ ] A2.1 Registry (D4): group retitles + `legacy` flag, order, labels, `calendar` entry, hiddenByDefault list, re-pointed defaultGroups, `subview` flag, agents badge → `directives`, BadgeKey `agents` removed; tests.
- [ ] A2.2 Badges: Inbox = unread + approvals (tone/title), `COVERS`, `rollup` no double count; tests.
- [ ] A2.3 Schema v2: `NAV_SCHEMA_VERSION = 2`, `MIGRATIONS[1]` per D4 (shape-tolerant), literal `1`s replaced, server `NAV_SCHEMA_MAX = 2` + its tests; migration tests with frozen v1 fixtures.
- [ ] A2.4 Sidebar: group titles as `.nav-group-title` (no title over Home), active = longest visible prefix, More tools (button disclosure, chips with counter dots, localStorage, auto-open, rail menu), rollup dot moves to More tools, footer (AI budget card, operator row with Log out moved from the header, env pill when `VITE_ENV_LABEL`), width 248.
- [ ] A2.5 Top bar: ⌘K field, "N agents live" pill, New post → `/app/compose`, main padding/max-width; mobile header keeps the hamburger and its rollup dot.

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

A3 (worktree `wf_9569abf2-5cb-3`):
- `a39a7b9c` A3.1 `Inbox` list returns `subject`, `parts` and English `actions`; `OwnerInbox.get(id)`.
- `f0b19389` A3.2 `POST /api/agents/inbox/:id/actions`, `via` threaded through `pause-actions.ts`, outcome `code`, dashboard reactions count for the A10 demotion.
- `0689e01c` A3.3 series-pauses `{action:'pause'}` and `POST /api/agents/inbox/unread`.
- `a215b15b` A3.4 `lib/inbox-ref.ts` + `lib/inbox-kinds.ts` (48 kinds) with node tests.
- `4e718e1e` A3.5 `components/inbox/NoteActions.tsx`, `useInboxAction` / `usePauseSeries` / `useMarkInboxUnread`, `useResumeSeries` invalidates the inbox.

## Deltas from the spec
(each agent appends its own subsection)

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
