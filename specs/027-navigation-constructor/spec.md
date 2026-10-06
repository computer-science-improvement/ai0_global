# 027: Dashboard navigation: menu constructor, badges and information-architecture cleanup

**Status:** SPEC · **Depends on:** 017 (agent inbox), 018 (`pending_actions`), 021 (directives) · **Storage:** `app_settings` row (no migration) ·
**Owner comments addressed:** #13, #14 (from `plans/brd-comments-2026-10-06.md`)

## Why
The sidebar is a hard-coded array. The owner cannot shape it around their daily work. Nothing in it says "something needs
you". Several pages are reachable only by typing a URL or are leftovers.

- #13 on "Меню захардкоджене (немає прав на пункти, немає «бейджів» лічильників)": «варто додати управління (конструктор)».
- #14 on the pages that have no menu item (`/app/compose`, `/app/bots`, `/app/telegraph`, the `/app/calendar` stub…):
  «варто покращити UI/UX».

The goal: a single operator decides what the menu looks like. The menu shows live counters for what is waiting on them.
Every page can be reached with one keystroke (⌘K). Dead, duplicate and confusingly named routes are removed.

## Current state (as-is)
- **Sidebar** `apps/dashboard/src/components/AppSidebar.tsx`: a const `GROUPS` with 7 groups and 19 items
  (BR-CORE-11), `NavItem {to, label, icon, soon?, exact?, search?}`. The collapsed state is in `localStorage`
  (BR-CORE-13), and the mobile drawer opens at ≤860px. There are no badges, no favourites and no search.
- **Shell** `components/AppShell.tsx`: the header has `+ New post` → `/app/compose` (BR-CORE-14) and no breadcrumb.
  `components/ui/PageHeader.tsx` takes only `title`, `subtitle` and `actions`.
- **Orphan or duplicate routes** (BRD 01 §3.2 "Звʼязки", BRD 00 §4):
  - `/app/compose`: reachable only through the header button. It has its own "Back to scheduled" link.
  - `app.bots.tsx`, `app.telegraph.tsx`: duplicate pages "kept for deep links" that nothing links to. The canonical
    home is `/app/connections?section=telegram&tab=bots|telegraph`.
  - `app.calendar.tsx`: a `Placeholder` "Calendar soon" that nothing links to.
  - `app.connections.$platform.tsx`: a "soon" placeholder that nothing links to. The real pages are
    `/app/connections/meta` and `/tiktok`.
  - `app.agents_.inbox.tsx` (agent-platform inbox) and the `/app/agents/$handle?tab=directives` board have no menu item.
- **Naming:** "Agents" (`/app/agents`, the named agents) and "Agent" (`/app/agent`, the DM triage and chat intel)
  are easy to confuse (an open question in BRD 01). "Logs" (Analytics) and "Scheduled" (Publishing) show adjacent data
  but sit in different groups.
- **Detail pages** use ad-hoc back links (compose, `meta_.$accountId`, `agents_.$handle`) or none at all
  (`channels_.$id`, `editor_.run.$id`).
- **Settings storage:** `app_settings(key, value TEXT, updated_at)` (migration 015). `SettingsService` caches
  **every** row and lists all keys as `overrides[]` in `GET /settings` (BR-CORE-39). The page has 3 tabs (BR-CORE-37).
- **Counter sources** (all indexed today):
  - `agent_inbox.read_at IS NULL` (049, `idx_agent_inbox_unread`), with `severity` info/action/critical;
  - `agent_directives.status='awaiting_owner'` (053);
  - `editor_slots.status='failed'` by `scheduled_at` (042, `idx_editor_slots_due`);
  - `pending_actions.status='pending'` (050, the chat confirmation cards);
  - `agent_actions.status='pending'` (039) and `agent_dm_threads.status='new'` (038);
  - `scheduled_publications.status IN ('failed','unknown')` (014/045).
- The dashboard has no test runner and no DnD or command-palette library.

## Functional requirements
| ID | Requirement |
|----|-------------|
| FR-001 | **Nav registry** `apps/dashboard/src/nav/registry.ts`, the single source of truth for every navigable page: `{id, to, search?, label, icon, defaultGroup, exact?, keywords[], badge?, parent?}`. Ids are stable slugs (`overview`, `dm-inbox`, `compose`…) and are never reused. Pages outside the default menu are registered too (`agents-inbox`, `directives` → `/app/agents/@manager?tab=directives`, `connections-meta`, `connections-tiktok`). The sidebar, palette, breadcrumbs and constructor all read it. |
| FR-002 | **IA cleanup.** <br>• `/app/bots` and `/app/telegraph` become redirect-only routes (`beforeLoad`) to `/app/connections?section=telegram&tab=bots\|telegraph`. <br>• `/app/calendar` redirects to `/app/scheduled`, and the stub is deleted. <br>• `app.connections.$platform.tsx` is deleted. <br>• `/app/agent` is renamed **"DM inbox"** at `/app/dm`, and the old path redirects there with its search params. <br>• `/app/*` gets a not-found page (a link to Overview and a "Press ⌘K" hint). |
| FR-003 | **Default menu (schema v1):** <br>• **Home:** Overview <br>• **Agents:** Agents, Chat, DM inbox <br>• **Publishing:** Compose, Scheduled, Editor, Logs, Strategies, My channels <br>• **Analytics:** Analytics, Tracked <br>• **Intelligence:** Discovery, Graph, Recommendations <br>• **Connections:** Connections, Groups <br>• **Marketing:** Landing, Ads <br>• **System:** Settings <br>`+ New post` stays in the header. A **Pinned** section appears above Home when it is non-empty. |
| FR-004 | **Storage:** one `app_settings` row, key `ui.nav`, whose value is JSON: <br>`{schemaVersion:1, groups:[{id, title?, hidden?, items:[itemId]}], pinned:[itemId], hidden:[itemId], custom:[{id, label, icon, to, search?}], overrides:{[itemId]:{label?, icon?, badge?}}}`. <br>Built-in group ids are `g_home`…, and custom ids are `g_c_<nanoid>` / `c_<nanoid>`. `SettingsService` skips `ui.*` keys in its cache and in `overrides[]`. |
| FR-005 | **API** `@Controller('api/nav')` in `apps/automation/src/settings/nav/`, under `TrackingAuthGuard`: <br>• `GET /config` → `{config\|null, revision}` (revision = `updated_at`); <br>• `PUT /config {config, baseRevision}` → `{revision}`, or **409** on a stale revision; <br>• `DELETE /config` → reset. <br>Shape validation only: ≤ 32 KB; `schemaVersion` from 1 to `NAV_SCHEMA_MAX`; ≤ 20 groups, 150 refs, 50 custom links, 10 pinned; ids `^[a-z0-9_:-]{1,64}$`; labels 1–40 chars, trimmed; custom `to` starts with `/app` and has no `//`, `:` or `..`. |
| FR-006 | **Resolution** `src/nav/resolve.ts`, the pure `resolveNav(registry, config, routeExists)`: <br>• no config, or a newer schema → the default menu plus a warning; <br>• older schemas go through a `migrate[v]` chain; <br>• unknown ids are skipped with a warning; <br>• registry items found nowhere (not placed and not hidden) are appended to their `defaultGroup` (or Home) and flagged *new*; <br>• duplicate refs keep the first; <br>• empty or hidden groups are not rendered; <br>• **Overview and Settings are always visible.** <br>Unit-tested via a new dashboard `test` script (`tsx --test`). |
| FR-007 | **Custom links:** a label, an icon and an internal target, typed (`/app/channels?filter=external&q=crypto`) or captured with **"Add current page"**. The target is validated with `router.matchRoute`. A link that no longer matches renders disabled ("This page no longer exists"), is left out of the palette and is listed under *Unavailable*. |
| FR-008 | **Constructor:** a new Settings tab `?tab=navigation`, also opened from an "Edit menu" button in the sidebar footer. It shows a tree editor (groups → items) and a live preview. Operations: <br>• drag items and groups (native HTML5 DnD, plus ↑/↓ buttons and Alt+↑/↓); <br>• hide/show; <br>• rename (empty means the default label); <br>• icon picker; <br>• badge on/off; <br>• new or deleted custom group (its items go to Hidden); <br>• pin; <br>• add link; <br>• **Reset to default** (confirm, then `DELETE`). <br>Edits stay a local draft with sticky Save/Discard and a leave-guard. A 409 shows "Changed in another tab — Reload". A *Hidden / Unavailable* panel offers Restore/Remove. |
| FR-009 | **Quick actions in the sidebar:** hover shows a star (pin/unpin with an optimistic `PUT`). The context menu (right click or long press) offers Pin, Hide and Rename… (opens the constructor on that item). |
| FR-010 | **Badges** `GET /api/nav/badges` → `{generatedAt, counts}`. One SQL statement of scalar subqueries, with a 10 s in-memory cache. A failing subquery returns `null` for its key instead of a 500. The counts and their default bindings: <br>• `agentInboxUnread` (+ `agentInboxCritical`) and `directivesAwaitingOwner` → **Agents** (danger if critical or awaiting, else warning) <br>• `chatPendingActions` (`pending_actions`) → **Chat** <br>• `dmThreadsNew` + `dmActionsPending` (`agent_actions`) → **DM inbox** <br>• `slotsFailedToday` → **Editor** (danger) <br>• `scheduledFailedToday` (`failed`/`unknown`) → **Scheduled** (danger) <br>"Today" means since Kyiv midnight (BR-GEN-01). The registry items `agents-inbox` and `directives` carry their own counts. |
| FR-011 | **Badge rendering:** a `Badge` pill (`99+` cap). In the collapsed rail it is a dot with a `title`, and zero or `null` renders nothing. Hidden items roll up into a dot on the mobile hamburger. Polling is `refetchInterval: 30s` and refetch on focus, and stops in background tabs. The mutations that change a count invalidate `['nav','badges']`: inbox read, directive approve/decline, pending-action apply/discard, DM thread patch, agent-action approve/reject, and scheduled-post changes. |
| FR-012 | **Command palette (⌘K / Ctrl+K)** and a header search button. It lists: <br>• every registry page (hidden ones marked); <br>• custom links; <br>• agent handles (`GET /api/agents/handles`, loaded lazily); <br>• the actions New post, Pin current page, Edit menu and Collapse sidebar. <br>Fuzzy match on label, keywords and path; keyboard navigation; the last 5 picks first (`localStorage`, try/catch). The shortcut is ignored inside text fields. Built on `components/Modal.tsx`, with no new dependency. |
| FR-013 | **Breadcrumbs:** `PageHeader` gets `crumbs?`, built by `useCrumbs()` from the registry `parent` chain and the owner's renamed labels. Required on `agents/$handle`, `agents/inbox`, `channels/$id`, `editor/$channel`, `editor/run/$id`, `editor/slot/$id`, `strategies/new`, `strategies/$id`, `connections/meta`, `meta/$accountId`, `tiktok`, `groups` and `compose`, and these pages drop their ad-hoc back links. On mobile only `‹ Parent` shows. |
| FR-014 | **Mobile (≤860px):** <br>• the drawer shows Pinned, then the groups, with badges; <br>• the hamburger shows a dot on any danger/warning count; <br>• the palette is a full-height sheet; <br>• the constructor uses ↑/↓ instead of drag and hides the preview behind a toggle; <br>• long press replaces hover. |
| FR-015 | **First paint:** the last resolved menu is cached in `localStorage` (`dashboard:nav-cache`) to avoid flashing the default menu. Without storage, the default renders until `GET` resolves. |

## Corner cases
- **A route is removed in a later release:** its id is skipped, it is listed as *Unavailable* in the constructor, and
  nothing crashes.
- **A new page ships:** it is auto-appended to its default group with a *new* dot, so an old config never hides new
  features.
- **Everything is hidden:** empty groups disappear, and Overview and Settings stay visible, so the constructor is always
  reachable.
- **A stale tab after deploy reads a newer schema:** it shows the default menu, and saving is blocked until a reload, so
  the newer config is never overwritten.
- **Two tabs edit:** the second save gets 409, and the draft is kept.
- **The DB row is corrupt:** `GET` returns `config:null, warning:'unparseable'`, and the constructor offers Reset.
- **A legacy URL has params** (`/app/agent?cat=ad`): the params survive the redirect.
- **A badge source table is missing** (an older DB): that key is `null` and no badge shows.
- **Duplicate labels after a rename:** allowed. The palette shows the path as a second line.
- **A custom link points to an archived agent:** the route still matches, and the page shows its own not-found state.

## Non-goals
- Per-user or role-based menus and item permissions (single operator; auth hardening #15 is a separate spec).
- External links in the menu, and menu import/export.
- A real calendar view. It could later be a view toggle on Scheduled.
- A mobile bottom tab bar, badge counts in the document title, and push notifications.
- Indexing channels or posts in the palette.

## Success criteria
- The legacy paths redirect, `/app/connections/instagram` shows the not-found page, and the duplicate Bots/Telegraph
  pages are gone.
- `AppSidebar.tsx` has no menu literals. Every navigation surface renders from `nav/registry.ts`.
- Tests:
  - `resolveNav`: default, unknown id, auto-append, forced items, future schema, duplicates, migrate chain;
  - backend: every validation limit, 409, reset, `GET /settings` unchanged;
  - badges SQL on a scratch PG: the Kyiv-midnight boundary, and a missing table → `null`.
- Manual run at desktop and at 375px:
  - reorder, rename, hide and pin;
  - add `/app/agents/@manager?tab=directives` as "Directives" via *Add current page*;
  - reload, and the menu persists;
  - Reset restores the FR-003 default.
- Badges: p95 under 50 ms on prod data, and at most 2 requests per minute per open tab.

## Open questions for the owner
1. **Where does the constructor live?** *Default: a Settings → Navigation tab plus quick pin/hide in the sidebar.* The
   alternative is a full inline edit mode in the sidebar.
2. **Name and place of the DM page?** *Default: "DM inbox" at `/app/dm`, in the Agents group.* Marketing is the
   alternative, since most DMs are ad requests.
3. **Calendar?** *Default: redirect to Scheduled and delete the stub.* The alternative is to build a week calendar of
   scheduled posts and editor slots.
4. **Strategies item?** Spec 009 and comment #2 move away from strategies. *Default: keep the item, so the owner can
   hide it themselves.*
5. **What does a failure badge count?** *Default: failures since Kyiv midnight* (no acknowledge step, no migration). The
   alternative is "until acknowledged", which needs a new migration with `acknowledged_at`.
6. **Which drag library?** *Default: native DnD plus buttons.* `@dnd-kit` would give smoother touch drag for about
   30 KB gzip.
7. **Can Overview and Settings be hidden?** *Default: no*, as the safety net.

## Task breakdown

### T1: Clean up orphan routes and rename the DM inbox
**Scope:**
- Implement the FR-002 redirects and deletions.
- Move `app.agent.tsx` to `/app/dm`.
- Add the `/app/*` not-found page.
- Update the current `GROUPS` to the FR-003 default.

**Acceptance:** the redirects keep their params, `tsc` is green, nothing links to a removed path, and the BRD 01 §3.2
table is updated.
**Size:** S
**Depends on:** —

### T2: Introduce the nav registry and breadcrumbs
**Scope:**
- Add `nav/registry.ts` and render `AppSidebar` from it.
- Add `PageHeader.crumbs` and `useCrumbs`.
- Add breadcrumbs to every FR-013 page and remove the ad-hoc back links.

**Acceptance:** the sidebar looks identical to T1, every listed detail page shows a correct trail (including the mobile
form), and `AppSidebar.tsx` has no menu literals.
**Size:** M
**Depends on:** T1

### T3: Add the nav config API on `app_settings`
**Scope:**
- Add the `settings/nav` module with `GET`/`PUT`/`DELETE /api/nav/config`, the revision-based 409 and the FR-005 limits.
- Make `SettingsService` exclude `ui.*` keys.

**Acceptance:** the backend tests pass, `GET /settings` is unchanged, and the endpoint works through the existing `/api`
proxy (dev and nginx).
**Size:** S
**Depends on:** —

### T4: Apply the saved menu in the sidebar
**Scope:**
- Add `nav/resolve.ts` with its tests and the dashboard `test` script.
- Add `useNavConfig` with the first-paint cache.
- Render pinned items, overrides and custom links (route validation, disabled state).
- Add the star and the context menu (FR-009).

**Acceptance:** the tests are green, and a config written by `PUT` changes the sidebar after a reload with no flash.
Removing a registry entry shows *Unavailable* without a crash.
**Size:** M
**Depends on:** T2, T3

### T5: Build the menu constructor (Settings → Navigation)
**Scope:**
- Build the FR-008 UI: tree editor, DnD plus keyboard and button reorder, rename, icon and badge toggles, custom groups,
  Add link and Add current page.
- Add the Hidden/Unavailable panel, the draft with Save/Discard, the 409 banner, Reset and the live preview.
- Add the FR-014 mobile variant.

**Acceptance:** the manual scenario passes at desktop and at 375px, keyboard-only reorder works, and an unsaved draft
asks before navigation.
**Size:** L
**Depends on:** T4

### T6: Add live badges to the sidebar
**Scope:**
- Add `GET /api/nav/badges` (one query, 10 s cache, `null` per failed key).
- Add `useNavBadges` and the pill/dot/hamburger rendering.
- Add the per-item badge toggle.
- Add the FR-011 invalidations.

**Acceptance:** the PG fixture test passes, marking an inbox item read or approving a directive updates the badge on the
next round-trip, and p95 is under 50 ms.
**Size:** M
**Depends on:** T2 (the toggle needs T4)

### T7: Add the ⌘K command palette
**Scope:**
- Add `components/CommandPalette.tsx` on `Modal`, the global shortcut in `AppShell` and the header search button.
- Include pages, custom links, agent handles, actions and recent picks.
- Add a matcher fixture test (every top-20 page reachable in 3 keystrokes or fewer).

**Acceptance:** the palette opens everywhere in `/app` except inside text fields, hidden pages are reachable and marked,
Pin current page persists, and the mobile sheet works.
**Size:** M
**Depends on:** T2 (pinning needs T4)
