# nav: Handoff §3 (navigation IA) and the sidebar

## Checks

- [confirmed] The menu goes from 26 items to 11 — Today's default menu has 26 visible items (registry.ts:61-118; ui-inventory §5.2 lists them). The new IA has 11: overview, agents-inbox, chat / agents, calendar, channels, network-map / analytics, spend, health / settings.
- [wrong] Ids used in §3: agentsInbox, map, dm, approvals — registry.ts:64,74,78,79. 'agentsInbox' and 'dm' are BadgeKeys (registry.ts:23), not ids. → FIX: Use the real ids: 'agents-inbox', 'network-map', 'dm-inbox'. 'approvals' is correct. Never rename an id (registry.ts:5-7): saved menus store them.
- [missing] 'calendar' is a new id (§7) — There is no 'calendar' entry in NAV_REGISTRY. The route /app/calendar exists but only redirects to /app/scheduled (routes/app.calendar.tsx:6-9). git log -S shows the id was never used, so it is free. → FIX: Add { id:'calendar', to:'/app/calendar', label:'Calendar', icon:'calendar', defaultGroup:<Network> }. Until PR6 it lands on Scheduled.
- [missing] Groups Home / Network / Insights / System — NAV_GROUPS (registry.ts:46-56) has 9 groups and no Network or Insights. Saved menus use the old group ids. A removed id renders as 'Group' (resolve.ts:128,213), and deleteGroup refuses non-g_c_ ids (ops.ts:135). → FIX: Keep every old group id. Retitle g_agents to 'Network' and g_analytics to 'Insights'. Mark the other old groups legacy so defaultConfig skips them.
- [partial] This is a change to defaults in registry.ts, not a sidebar rewrite — Group order comes from array order in NAV_REGISTRY (registry.ts:8; resolve.ts:50), so chat, health and channels have to be moved in the array. More tools, the footer and the badges need code in AppSidebar.tsx and badges.ts.
- [confirmed] The hiddenByDefault list (17 ids) — All 17 exist (dm → 'dm-inbox'). Hiding them leaves exactly the 11 items. The 8 entries already hidden stay hidden (directives, bots, telegraph, connections-meta/tiktok, settings-*).
- [partial] Inbox badge = agentInboxUnread + approvals.waiting — Both counts already reach the client. agentInboxUnread comes from GET /api/nav/badges (nav-badges.service.ts:27). approvalsWaiting comes from GET /api/editor/approvals/count → {waiting}, merged in store.ts:121-122. badgeFor('agentsInbox') counts unread only (badges.ts:49-51). → FIX: Change case 'agentsInbox' and COVERS in badges.ts (see brief).
- [confirmed] Agents keeps only directivesAwaitingOwner — BadgeKey 'directives' already means directivesAwaitingOwner, tone danger (badges.ts:52-53). Set agents.badge to 'directives' and delete the 'agents' case.
- [confirmed] The '17' moves from Agents to Inbox — ui-inventory §5.5: the Agents pill is unread inbox notes plus directives.
- [confirmed] The owner's saved menu will not be overwritten by new defaults — normalizeNav keeps saved groups and hidden as they are (resolve.ts:123-130). It places only ids found nowhere (142-151). agents-inbox has been hiddenByDefault since cabd125c (2026-10-06), so it sits in the saved 'hidden' list. → FIX: Worse than the handoff says: labels and badge meanings DO change in a saved menu (resolve.ts:191-194). After the change the owner's Agents pill loses the unread count, and Inbox stays hidden.
- [confirmed] Settings → Navigation → 'Reset to default' exists — NavigationTab.tsx:193-199 → navApi.resetConfig (api/nav.ts:23) → DELETE /api/nav/config (nav.controller.ts:40-43) → DELETE FROM app_settings WHERE key='ui.nav' (nav-config.service.ts:70-73). It also deletes pins, renames, hidden pages and custom links.
- [partial] Alternatively, a one-time migration of ui.nav — No SQL migration writes or deletes app_settings rows (068, 077 and 078 say 'No rows are written here'). The data-repair pattern (083, 095) is guarded, idempotent and has a down file. Last file on disk is 096. 097–101 are earmarked in docs/reviews/2026-10-27-channel-onboarding.md:155-272. The client already has a hook for this: MIGRATIONS in resolve.ts:18-19, tested at resolve.test.ts:50-62. → FIX: Use a client schema migration v1→v2 plus server NAV_SCHEMA_MAX=2. If SQL is needed after all, the next free number is 102.
- [wrong] PR2: update src/nav/legacy-redirects.test.ts — legacy-redirects.test.ts:10,44-46,51 assert /app/calendar is redirect-only. PR2 does not change that route. → FIX: Change the test in PR6, when app.calendar.tsx gets a component.
- [missing] docs/ui-data-contract.md — The file is not in the repo.
- [confirmed] Sidebar AI budget card ($1.37 / $10) — GET /api/spend/budgets (spend.controller.ts:79-82) → BudgetsResponse {today, rows: BudgetStatus[], agentCaps, blocking} (api/spend.ts:125). Hook: useBudgets() (api/spend.ts:191-193, polls every 60 s). Component: BudgetBar (components/overview/AiSpendCard.tsx:39-57).
- [partial] Operator row (OP / Operator / @token) — GET /auth/me returns {tgUserId, firstName, username?, method:'session'|'bearer'|'dev', sessionId?, expiresAt?} (auth.controller.ts:66-77,149-151; api/types.ts:67-74). Read it with useAuth(). There is no avatar. The header already shows the name and Log out (AppShell.tsx:171-186).
- [missing] 'dev' pill in the brand row (prototype) — The dashboard has no environment label. Only me.method==='dev' (local bypass) or AUTH_MODE==='dev' (lib/env.ts:16) exist. → FIX: Needs a build arg, e.g. VITE_ENV_LABEL, added to deploy-develop.yml:70-73 and the Dockerfile.
- [missing] Health '2' and Agents '5 live' counters (prototype) — Neither has a BadgeKey or BADGE_SOURCES entry. NetworkHealth.problems exists (api/health.ts:30) but the endpoint is heavy. A live-agents count would need KpiDigest.agents[].mode or /api/overview/agents.

## Brief
## Brief: handoff §3, navigation IA and the sidebar

All paths are relative to `apps/dashboard/src` unless they start with `apps/` or `database/`.

### 1. Registry changes (`nav/registry.ts`)

**Ids are never renamed.** Map the handoff's names to the real ids:

| Handoff says | Real id |
|---|---|
| `agentsInbox` | `agents-inbox` |
| `map` | `network-map` |
| `dm` | `dm-inbox` |
| `calendar` | new (does not exist yet) |

**Groups.** Keep every existing `NAV_GROUPS` id, so saved menus keep their titles and stay deletable. If a saved group id disappears from `NAV_GROUPS`, it renders as "Group" and cannot be deleted (`resolve.ts:128,213`, `ops.ts:135`).

Recommended layout, which needs the fewest test changes:
- `g_home` → title **Home**
- `g_agents` → retitle **Network**
- `g_analytics` → retitle **Insights**
- `g_system` → **System**
- `g_publishing`, `g_content`, `g_intelligence`, `g_connections`, `g_marketing` → add a `legacy: true` flag. `defaultConfig` (`resolve.ts:50`) and `defaultNav` skip legacy groups, but their titles still resolve for saved menus.
- The prototype shows no title over the Home group. If you want that, suppress the title for `g_home` in `AppSidebar.tsx:99-101`.

**Order.** The order inside a group is the array order in `NAV_REGISTRY`, so entries must be physically moved:
- Home: `overview`, `agents-inbox`, `chat`
- Network: `agents`, `calendar`, `channels`, `network-map`
- Insights: `analytics`, `spend`, `health`
- System: `settings`

**Entry changes:**
- **`overview`:** label "Today". Add the keyword 'overview'.
- **`agents-inbox`:**
  - label "Inbox", `defaultGroup` `g_home`, remove `hiddenByDefault`.
  - Keep `parent:'agents'` and `badge:'agentsInbox'`.
  - Add keywords 'approve', 'approvals', 'posts to approve'.
- **`chat`:** move to `g_home`. Keep the label "Chat": "Chat with agents" breaks the palette spot check `'ch'→Chat` (`palette.test.ts:44`) because "Channels" would score higher.
- **`channels`:** move to `g_agents`, label "Channels".
- **`network-map`:** label "Map".
- **`health`:** move to `g_analytics`, label "Health".
- **`calendar`:** add as new: `{id:'calendar', to:'/app/calendar', label:'Calendar', icon:'calendar', defaultGroup:'g_agents', keywords:['schedule','plan','slots','upcoming','week']}`.
  - Until PR6, `/app/calendar` redirects to `/app/scheduled` (`routes/app.calendar.tsx`). That is harmless, but the item is never shown as active.
  - Add it in PR2 anyway, so the migration (§3) places it once. Otherwise PR6 would need a second migration to hide `scheduled`.
- **`hiddenByDefault: true`** on: `approvals`, `dm-inbox`, `models`, `artifacts`, `compose`, `scheduled`, `editor`, `logs`, `data`, `tracked`, `discovery`, `graph`, `recommendations`, `connections`, `groups`, `landing`, `ads`.
- **`agents`:** `badge: 'directives'`.
- **`FORCED_IDS`** (`overview`, `settings`) stays as it is.
- **Optional:** add a `subview: true` flag on `approvals`, `directives`, `bots`, `telegraph`, `connections-meta`, `connections-tiktok` and the three `settings-*` entries, so More tools can leave them out (§5).

### 2. How new defaults interact with a saved menu

Where it happens: `normalizeNav`, `resolve.ts:77-170`.

1. Saved groups are kept verbatim (123-129), and so is saved `hidden` (130). `hiddenByDefault` is consulted **only for ids found nowhere** (146).
   - So all 17 newly hidden ids stay visible wherever the owner's menu lists them.
   - `agents-inbox` has been `hiddenByDefault` since cabd125c (2026-10-06). Every saved config therefore lists it in `hidden`, so un-hiding it in the registry does nothing.
2. Ids found nowhere (only `calendar`) go into `newIds`. They are appended to their `defaultGroup` if the saved menu has that group, else to `g_home`, else to a recreated group (148-150). They show the "new" pill (`SidebarItem.tsx:61`).
3. A changed `defaultGroup` does not move a saved item.
4. These **do** apply to a saved menu, because they come from the registry unless overridden (`resolve.ts:191-194`): labels, icons, group titles and **badge meanings**.
   - Result: once Agents shows only directives, the owner's visible menu loses the "17". The inbox count survives only as the rollup dot on "Edit menu" (`AppSidebar.tsx:49`).
   - This is a regression. **The migration must ship in the same PR as the badge change.**

### 3. Safest rollout: client schema v1 → v2

This is the hook the code already has for this: `MIGRATIONS`, `resolve.ts:18-19`, with its test at `resolve.test.ts:50-62`.

**Dashboard changes:**
- `config.ts:5`: `NAV_SCHEMA_VERSION = 2`.
- `NavConfigV1.schemaVersion: 1` → `1 | 2`, or add `NavConfigV2`.
- Replace the literal `1` at `resolve.ts:49` and `resolve.ts:167` with `NAV_SCHEMA_VERSION`. `normalizeNav` output is what every PUT sends (`store.ts:93-100`, `NavigationTab.tsx`).
- `MIGRATIONS[1] = (c) => v2`:
  1. Start from the new `defaultConfig()`.
  2. Keep `pinned`, `custom`, `overrides`.
  3. Keep custom groups (`g_c_*`) with their items, and remove those items from the default groups.
  4. Keep owner-hidden ids hidden: anything in `c.hidden` that is not in a frozen `V1_DEFAULT_HIDDEN` list (`agents-inbox`, `directives`, `bots`, `telegraph`, `connections-meta`, `connections-tiktok`, `settings-navigation`, `settings-security`, `settings-ai`).
  5. A custom link that sat in a built-in group stays in that group if the group survives; otherwise it goes to `hidden` and appears in More tools.
  6. Drop `hidden` flags on built-in groups.

**Server change** (`apps/automation/src/settings/nav/nav-config.schema.ts:11`): `NAV_SCHEMA_MAX = 2`. Without it, PUT returns 400 `invalid_nav_config`. Ship it in the same PR; v1 stays valid.

**Rollback:** an older build sees v2 as `newer`, shows the default menu and blocks saving (`resolve.ts:93-96`). That is safe.

The migration runs on every read until the next save writes v2, and the localStorage cache holds raw config, so nothing breaks.

**Other options:**
- **Reset** (DELETE `/api/nav/config`): it works, but it wipes pins, renames, custom links and hidden pages (the confirm text at `NavigationTab.tsx:196` says so). It is acceptable only if `GET /api/nav/config` on prod shows nothing custom.
- **SQL migration:** no precedent for writing `app_settings` rows. Rewriting the JSON in SQL would duplicate registry knowledge. If one is needed anyway, use **102**: the last file on disk is 096, and 097–101 are earmarked for specs 072–077.

### 4. Badges (`nav/badges.ts`)

- **`case 'agentsInbox'`:**
  - Return `null` when neither `agentInboxUnread` nor `approvalsWaiting` is known. Otherwise `count = sum(agentInboxUnread) + sum(approvalsWaiting)`.
  - Tone: `danger` if `agentInboxCritical > 0`, else `warning`.
  - Title: `"N unread[, K critical] · M posts to approve"`.
- **Remove `case 'agents'`** and `'agents'` from `BadgeKey` (`registry.ts:23`); Agents now uses `'directives'`. `AppSidebar` and `AppShell` call `badgeFor` and `rollup` generically, so nothing else references `'agents'`.
- **`COVERS = { agentsInbox: ['approvals'] }`**: drop the `agents` entry.
- **Fix `rollup`:** after counting an item, add its `COVERS` keys to `seen`.
  - Today the mobile hamburger (`AppShell.tsx:102`, which passes no skip set) counts Agents and the hidden Agent inbox twice. It would also count Inbox and hidden approvals twice.
  - Visible items are iterated first, so this fixes both.
- **Data needs no backend change:** `useNavBadgeCounts` (`store.ts:112-123`) already merges `/api/nav/badges` (polled every 30 s) with `useApprovalsCount` (`GET /api/editor/approvals/count`, polled every 60 s).
- If the owner turns off the Inbox badge (`overrides[id].badge=false`), the hidden approvals counter rolls up again. That is correct.

### 5. "More tools" (`AppSidebar.tsx`)

- **Source:** `nav.hidden` from `useResolvedNav`, minus `unavailable`, minus `subview` registry entries. Custom links come last.
  - Put this in a pure helper, e.g. `moreTools(nav)` in `nav/model.ts` or a new `nav/more.ts`, with a node test.
  - With `subview` excluded that is 16 items. The prototype shows 10; it is illustrative only. The lead decides whether `compose` (the header already has a "New post" button) and `groups` also go.
- **Expanded sidebar and mobile drawer:**
  - A `.nav-link`-styled `<button aria-expanded aria-controls>` with a chevron. CLAUDE.md bans `<details>` for content, so do not use it here.
  - The prototype renders chips (`.sub` flex-wrap). Rows built with `SidebarItem` keep badges, the star and the context menu.
  - Persist the open state in localStorage (try/catch, like `COLLAPSED_KEY` in `AppShell.tsx:21`). Auto-open when the current route is one of these items.
- **Collapsed rail:** an icon button that opens `NavContextMenu` (`components/nav/NavContextMenu.tsx`), with actions that navigate.
- **Rollup dot:** move `hiddenRollup` (`AppSidebar.tsx:49,142-148`) from "Edit menu" to the More tools row. Hidden `dm-inbox`, `editor` and `scheduled` all have counters.
- **Icon:** there is no ellipsis icon in `components/ui/Icon.tsx`. Add lucide `Ellipsis`, or use `'wrench'` / `'layers'`.
- **Active state:** the `Link` default is fuzzy (no `activeOptions`, `SidebarItem.tsx:79`), so on `/app/agents/inbox` both Agents and Inbox highlight. Compute "longest visible prefix wins" in `AppSidebar` from `useRouterState`.

### 6. Sidebar footer

**AI budget card:**
- Use `useBudgets()` (`api/spend.ts:191`, key `['spend','budgets']`, shared with the Spend page). It calls `GET /api/spend/budgets` → `{today, rows: BudgetStatus[], agentCaps, blocking}`.
- Pick the global row the same way `apps/automation/src/editor/map/map.service.ts:364-369` does: `rows.find(b => b.scopeKind==='global' && b.dailyUsd!=null) ?? rows.find(b => b.scopeKind==='global')`.
- Render it with `BudgetBar` (`components/overview/AiSpendCard.tsx:39`; helpers `barPct`, `budgetBarColor`, `budgetBadge` in `lib/spend.ts:43-64`), labelled "AI budget today". It shows "no daily cap" when there is no cap.
- Link to `/app/spend?tab=budgets`. Hide the card in the rail.
- Do not use `/api/spend/summary`: it rolls up 60 days.

**Operator row:**
- `useAuth().me` → `firstName`, `@username`; initials from `firstName`. There is no photo.
- Move the header copy (`AppShell.tsx:171-175`) and Log out (`:186`) into this row so they are not shown twice.

**"dev" pill:** needs a new `VITE_ENV_LABEL` build arg, or show it only when `me.method==='dev'`.

**Optional, needs data that does not exist yet:**
- Health count: `NetworkHealth.problems` is heavy at 60 s; better as a new badge source.
- Agents "N live": no source.

**Styling:** restyle `.nav-*` (`index.css:928-948`) with tokens:
- active background `var(--color-success-soft)`
- pill `var(--color-warning-soft)`
- `--font-mono` comes from PR1

### 7. Tests that must change

- **`registry.test.ts:44-70`:** default shape; `approvals` at `groups[0].items[1]`; the hidden list contains `agents-inbox`. Add: legacy groups are not in the default; registry order matches the IA.
- **`badges.test.ts`:**
  - 16-29: `'agents'` cases.
  - 33: key list.
  - 47-53: approvals is now hidden; read it from `nav.hidden`.
  - 55-75: the roll-up and "covered by Agents" scenarios become "covered by Inbox". Add a test that `rollup` does not double-count.
- **`palette.test.ts`:** `:35` (`top.length >= 20` → ≥ 10); `:54` (`agents-inbox` is no longer hidden; use `models`); recheck the `:44` spot checks.
- **`config.test.ts:36-58`:** Home ids, `landing` visible after reset, `g_agents` custom-link target.
- **`ops.test.ts:51-71`:** `g_publishing` is not in the default config, so `moveItemBefore('compose', 'g_publishing', …)` becomes a no-op. Also the `g_agents` item list.
- **`resolve.test.ts`:**
  - 32-38: "newer" uses `schemaVersion 2` → 3.
  - 79-97: `data` is now hidden by default; pick another id.
  - 99-110: approvals is already hidden.
  - 129-135: chat is now in Home by default.
  - 139-148: `g_marketing` is not in the default.
  - Add v1→v2 migration tests with a frozen literal v1 config: pins, custom links, overrides, `g_c_*` groups and owner-hidden ids survive; `agents-inbox` becomes visible; `newIds` is empty.
- **Backend:** `apps/automation/src/settings/nav/nav-config.schema.test.ts:31-32` (`NAV_SCHEMA_MAX` 2) and `nav.controller.test.ts:152-155` (reject 3, not 2).
- **`legacy-redirects.test.ts`:** unchanged in PR2. In PR6 change lines 10, 44-46 and 51.
- **Also update:** the `NavigationTab.tsx` copy "Overview and Settings are always shown" (~line 176) becomes "Today…", and `docs/ui-inventory.md` §5.

Run with `npx tsx --test "apps/dashboard/src/**/*.test.ts"` and the automation nav tests.

## Skeptic: wrong

- Add 'calendar' in PR2 anyway, so the migration places it once. Otherwise PR6 would need a second migration to hide 'scheduled'. — PR6 would not need a migration. A registry id that a saved menu does not mention is placed automatically by normalizeNav (resolve.ts:142-151): it goes to its defaultGroup (or Home) and gets a "new" pill. 'scheduled' is hidden by the PR2 v1→v2 migration whenever calendar ships. The handoff puts the calendar registry entry in PR6 (HANDOFF.md:379). Shipped in PR2, the item points at a redirect-only route (routes/app.calendar.tsx:6-9) to /app/scheduled, which is hidden, so Calendar never shows as active. → Add 'calendar' in PR6 together with the real page. If the PR2 migration has already run, the next read auto-appends it to g_agents. The only cost is a "new" pill until the next save.
- Tests that must change: resolve.test.ts 99-110, 129-135 and 139-148 — These three still pass under the new defaults; they just stop testing anything. 99-110 adds 'approvals' to hidden a second time and the first copy is kept. 129-135 pushes 'chat' into Home where it already sits last, so at(-1) is still 'chat'. 139-148 hides a g_marketing group that is not there and expects 'ads' hidden, which it already is by default. Among the listed resolve tests, only 32-38 (newer schema → 3) and 79-97 ('data' is now hidden) actually fail. → Mark 99-110, 129-135 and 139-148 as optional rewrites so they keep their meaning. They are not failures.
- palette.test.ts:54 (agents-inbox is no longer hidden); NavigationTab copy "Overview and Settings are always shown" at ~line 176 — Wrong line numbers. → palette.test.ts:55 asserts that agents-inbox is hidden by default. The copy is at NavigationTab.tsx:165.
- Group order comes from array order in NAV_REGISTRY (registry.ts:8; resolve.ts:50) — Group order comes from the NAV_GROUPS array (resolve.ts:50, model.ts:54). NAV_REGISTRY order only sets the item order inside a group. The brief body says this correctly; the checks entry does not. → Group order = NAV_GROUPS order. Item order inside a group = NAV_REGISTRY order.
- CLAUDE.md bans <details> for content, so do not use it here (then proposes a <button aria-expanded> disclosure) — apps/dashboard/CLAUDE.md:86 bans both `<details>` and "inline expand toggles", and only for long content in the Compact cards section (rich item lists). The rule does not cover a nav disclosure. If it did, the button version would be banned too. → Say the rule does not apply to the sidebar's More tools. Pick the button-with-aria-expanded version for accessibility and styling, not because of CLAUDE.md.

## Skeptic: missed

- The v1→v2 migration has to tolerate any shape. normalizeNav calls `step(cfg)` without try/catch (resolve.ts:98-102). resolve.test.ts:46 feeds a bare `{schemaVersion: 1}` and expects it to be tolerated. The sidebar (useResolvedNav), the palette, useQuickNavEdit (store.ts:93) and NavigationTab (load/draftJson/preview) all run normalizeNav during render. So a migration that dereferences c.groups, c.hidden or c.custom without strArr/isObj-style guards crashes the whole /app shell.
- The proposed migration rebuilds from the new defaults. It keeps only g_c_* groups, pins, overrides, custom links and owner-hidden ids. It drops reorders inside built-in groups, items moved between built-in groups, and pages the owner un-hid into a built-in group (for example 'directives' or 'bots'). The spec should state this, or carry over un-hidden registry ids.
- Thirteen of the newly hidden entries (compose, scheduled, editor, logs, data, discovery, graph, recommendations, connections, groups, landing, ads, plus tracked) keep defaultGroup set to groups that will not exist in a v2 config. Settings → Navigation → Hidden → Restore (NavigationTab.tsx:493-496 → showItem, ops.ts:47-53) then puts them in the first visible group (Home). Re-point their defaultGroup to a live group, or accept that.
- The Inbox entry has no `search`, so it opens on the Unread tab (routes/app.agents_.inbox.tsx:35-36, default filterState 'unread'). The new combined badge can be made up entirely of approvals, which live under ?tab=approvals, so the owner clicks the pill and sees an empty list. The page title is also hard-coded "Agent inbox" (:52), and its breadcrumb parent is still Agents (useCrumbs('agents-inbox'), parent:'agents').
- registry.test.ts:98-103 ('AppSidebar has no menu literals') rejects any `to: '/app…', label:` object literal in AppSidebar.tsx. The More tools list must come from the resolved nav or registry. Footer links such as /app/spend must be written as JSX props, not as item objects.
- On /app/chat the sidebar is forced to the icon rail unless the viewer opened it there (AppShell.tsx:46-56, CHAT_NAV_KEY 'dashboard:chat-nav'). With Chat now in Home, the rail versions of More tools, the hidden budget card and the operator row are what the owner sees on the chat page by default.
- Moving Log out into the sidebar operator row: onLogout lives in AppShell (AppShell.tsx:108-115: authApi.logout, qc.clear, navigate to /login). It has to be passed down as a prop, and the `me.method !== 'dev'` guard (:186) must stay. The header name is currently hidden on mobile (:171).
- BudgetBar (AiSpendCard.tsx:39-57) prints `b.label`, the budget row's own label, not "AI budget today". It needs a wrapper or `{...b, label: 'AI budget today'}`. The card also needs an empty state when budgets.rows has no global row; map.service.ts:365 falls back to summing unit spend in that case.
- rollup().count is never rendered. AppShell.tsx:151-160 and AppSidebar.tsx:138-148 use only tone and title. Today's double count therefore shows only as duplicate lines in the tooltip and aria-label, and badges.test.ts:74 asserts the 4+4 sum on purpose. The COVERS-into-seen fix changes that tested behaviour.
- I ran the brief's proposed registry (labels, order, hidden list, calendar) through the palette fixture in a scratch copy. palette.test.ts:31-47 still passes, but 'Channels' is the top result only for the keyword-derived queries 'ow'/'own'. 'c', 'ch' and 'cha' all go to Chat, and 'te'/'tel' go to Telegraph. Dropping the 'own' keyword from channels breaks the 3-keystroke fixture. 'Chat with agents' breaks only the 'ch' spot check, not the fixture.