# 078 — Dashboard redesign

Status: done · Linear AI0-249 · Builds on 027 (navigation), 060 (series pauses, inbox note actions), 012 (owner bot) · No migrations

## Why

The owner asked for this on 2026-10-28:

> візьми UI із - Downloads - "ai0-redesign" і імплементуй, також по таких же підходах додай стилі на сторінках яких немає у цих прототипах

The handoff is in the repo:

- `docs/redesign/HANDOFF.md` (Ukrainian), with prototypes in `docs/redesign/prototypes/*.dc.html`. The prototypes are canvas files; read them as text. Markup is plain HTML, CSS sits in `<helmet>`, and data and handlers are in `<script type="text/x-dc">`.
- The handoff was written against `docs/ui-inventory.md` and a `docs/ui-data-contract.md`. **The data contract does not exist in the repo.**

So every endpoint, field and line number in the handoff was re-checked against the code by eight researchers, each followed by a skeptic. Their briefs are in `research/`:

| File | Area |
|---|---|
| `research/design-language.md` | The prototype's visual system mapped onto our tokens and classes |
| `research/nav.md` | §3 navigation and sidebar |
| `research/today.md` | §4 Today |
| `research/inbox.md` | §5 Inbox, plus backend gaps #1–#3 |
| `research/agent.md` | §6 Agent detail |
| `research/calendar.md` | §7 Calendar |
| `research/landing.md` | §8 landing |
| `research/other-pages.md` | Every page without a prototype, and how to batch them |

**Precedence:**

1. **Lead decisions** in this spec.
2. Then the research briefs, including their **"Skeptic"** sections, which correct the brief above them.
3. Then the handoff.

Where the handoff and a brief disagree, the brief is right about the code (for example ids, endpoints and the `isMissed` precedence bug).

## Goals

1. Ship the prototype's look and information architecture in the real dashboard, built with our tokens and our components:
   - the 11-item menu;
   - Today, Inbox, Agent detail and Calendar;
   - landing motion.
2. Restyle **every other page** in the same language, so nothing looks like the old design. Most of this comes for free from the shared classes and primitives; each page then gets a pass of its own.
3. Close the backend gaps that the redesigned Inbox needs, so a note's buttons work in the dashboard as they do in Telegram.

## Non-goals and anti-goals

- **No prototype code.**
  - Do not use the prototype's hex colours, the Geist font, or `<x-dc>` markup.
  - Colours, radii and spacing come from `apps/dashboard/src/index.css` tokens. The font stays InterVariable.
- **No new npm dependencies.**
- **No migrations**, and no changes to how agents plan, write or publish.
- **No invented data.**
  - The prototypes' sample texts, names and numbers (Ukrainian agent names, "88% of all content", "| DEV" channel titles, the `agent.log` lines) are illustrations.
  - Show only what an endpoint returns. A block with no data source is either dropped or shows an honest empty state.
- **Nothing breaks:**
  - every existing route, deep link and `?tab=` value keeps working;
  - the Telegram owner bot behaves exactly as before.
- **Dashboard text stays English**, including action labels the backend stores in Ukrainian. Content (post text, note bodies the backend wrote) stays as written.

## Lead decisions

These override the handoff and the briefs.

### D1. Tokens (index.css)

- **Ink colours:**
  - `--color-ink-dim: #949494`.
  - `--color-ink-muted: #b0b0b0`, so muted and dim stay distinguishable.
- **`--font-mono`** is defined in `@theme`: `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`. No webfont.
  - Replace the 13 hard-coded mono stacks listed in `research/design-language.md` with the variable or a `.mono` class.
- **New tokens:**
  - `--color-on-warning: #1f1503`.
  - Shadow tokens: `--shadow-1`, `--shadow-2`, `--shadow-pop`, `--shadow-modal`.
  - Motion tokens: `--ease-out: cubic-bezier(.2,.8,.2,1)`, `--dur-fast: 120ms`, `--dur-base: 200ms`, `--dur-enter: 360ms`.
- **Radius and spacing values do not change.**
  - Prototype radii map 18/20 → `xl`, 14/12 → `lg`, 10 → `md`, 7–9 → `sm`.
  - **Buttons keep `--radius-sm`** (handoff §1).
- **`.text-heading-md`** is defined (15/600/1.3/-.01em). The inline sizes at its four users go.

### D2. Status system

- **`src/lib/status-tone.ts`** is the one map for both `editor_slots` statuses and `scheduled_publications` statuses (handoff §2 table).
- **Mode tones** (`MODE_TONE`, `EditorUi.tsx:20`): off neutral, shadow neutral, approve **warning**, live success. This is the prototype's "warning is the colour of the human".
- **`isMissed(slot)`** — the handoff's pseudo-code has an operator-precedence bug. The correct rule:
  - the slot belongs to a series or rule: `seriesName != null || scheduleRuleId != null`;
  - and its status is `skipped`, `failed` or `expired`;
  - and its trimmed `error` matches **none** of these prefixes:
    - `NOT_A_MISS`: `superseded by a new plan`, `mode_changed`, `draft canceled`, `series_paused`;
    - `OWNER`: `rejected by owner`, `resource_paused`, `agent @… is paused`, `agent paused`.
  - These lists mirror `apps/automation/src/editor/silent/skip-reasons.ts`, and a unit test pins them.
- **`components/ui/StatusMark.tsx`** draws the shape per status (handoff §2):
  - it carries `role="img"` and an `aria-label`;
  - it is 14px and scales up on hover;
  - the pulse is off under reduced motion.
  - `Badge` stays the component for status cells in tables.

### D3. Visual language

Apply `research/design-language.md` §2–§4 as written, with these calls:

**Buttons**
- Primary and secondary are min-height 40 (44 under `@media (pointer: coarse)`), weight 600.
- Secondary becomes the bordered ghost.
- `.btn-ghost` becomes the quiet button.
- Dense controls (`.btn-tiny`, `.btn-act`) keep their 30px look and gain a `::after` hit area.
- `.btn-danger` gets AA text contrast.

**Panels, cards and tabs**
- `SectionCard` panels get `--radius-xl` through `.panel.is-section`, plus a `flush` prop that turns children into full-bleed `.panel-row`s.
- Raw `.panel` / `.card` are flattened (no wash) but keep their radius, because their inline padding is tight.
- `SegmentedTabs`:
  - the default becomes the neutral **track**;
  - option `count` and `tone`;
  - `variant: 'underline'`;
  - `size: 'lg'` for the big mode switch.

**Headers and KPIs**
- `PageHeader`: `.page-title` 32/600/-.035em, plus an `eyebrow` prop (mono overline).
- `StatTile`: sentence-case label, 28/600 value, no hover lift, a `spark` prop, and a `StatStrip` wrapper.
- `Badge` is 11px/600 and keeps sentence case.
- `EmptyState` gets `tone: 'clear'`.

**Toast and Modal**
- `Toast`: the prototype look plus an optional action, e.g. `toast.success(text, {action:{label:'Undo', onClick}, ttlMs})`. The item becomes a `div role=status`. The ~200 existing calls must not change.
- `Modal`:
  - a `size: 'drawer'` (right sheet);
  - a real bottom sheet at ≤600px;
  - hairline head and foot lines;
  - a quiet close button.

**Global rules**
- **Reduced motion:** use `animation-duration: .01ms; animation-iteration-count: 1; transition-duration: .01ms`. **Never `animation: none`**, because `.compose-rise` starts at opacity 0.
  - Recharts gets `isAnimationActive={!reduced}` from a new `usePrefersReducedMotion()` hook.
- `*:focus-visible` no longer forces a radius.
- `a:hover { opacity }` is limited to bare text links.

**Docs**
- Update **`apps/dashboard/CLAUDE.md`**: bordered ghost buttons, the overline label, rows-in-a-flush-panel lists, the Inbox master-detail exception to "compact cards", the status system, and the reduced-motion rule.
- Update the stale `index.css` comments to match.

### D4. Navigation

Follow `research/nav.md`, including its skeptic corrections.

**Ids and groups**
- Use the real ids: `agents-inbox`, `network-map`, `dm-inbox`, plus the new `calendar`. **Never rename an id.**
- Keep every existing group id:
  - `g_home` "Home"; `g_agents` retitled "Network"; `g_analytics` retitled "Insights"; `g_system` "System".
  - The other five groups get `legacy: true`: they still resolve titles for saved menus but are not in the default.

**Default menu (11 items)**

| Group | Items |
|---|---|
| Home | Today (`overview`), Inbox (`agents-inbox`), Chat |
| Network | Agents, Calendar, Channels, Map |
| Insights | Analytics, Spend, Health |
| System | Settings |

- Every other page is `hiddenByDefault` and reachable from **More tools** and ⌘K.
- Pages that become hidden get a `defaultGroup` that exists in v2, so "Restore" lands them somewhere sensible:
  - Publishing and Content → Network;
  - Analytics and Intelligence → Insights;
  - Connections and Marketing → System.
- `calendar` is added now and points at `/app/calendar`, which wave B turns into a real page.

**Badges**
- **Inbox** = `agentInboxUnread + approvalsWaiting`.
  - Tone is danger when there is a critical note, else warning.
  - Its title spells out both parts.
- **Agents** uses the `directives` key.
- The `agents` BadgeKey goes away. `COVERS = { agentsInbox: ['approvals'] }`.
- `rollup` stops double counting: a counted item's covered keys are added to `seen`.

**Saved menus**
- A client schema migration **v1 → v2** (the `MIGRATIONS` hook in `nav/resolve.ts`), together with `NAV_SCHEMA_MAX = 2` on the server.
- The migration starts from the v2 default and keeps:
  - pins, custom links, overrides and custom groups;
  - pages the owner hid themselves (anything hidden that was not hidden by default in v1);
  - pages the owner had un-hidden from v1's hidden list (they stay visible, in their v2 default group).
- It drops reorders inside built-in groups. Document that in the runbook.
- It must tolerate any shape (`{schemaVersion:1}` alone, junk arrays) without throwing, because it runs during render.

**More tools**
- A `<button aria-expanded>` disclosure in the sidebar, rendered as wrapped link chips like the prototype.
- Each chip shows a dot when its page has a counter. Its aria-label says so.
- Open state is remembered in localStorage. It auto-opens when the current route is inside.
- In the collapsed rail it is an icon button that opens a menu.
- Items come from the resolved nav, never from literals (`registry.test.ts` "no menu literals").
- Sub-views (approvals, directives, bots, telegraph, connections-meta/tiktok, settings-*) are left out.

**Sidebar footer**
- The **AI budget today** card: `useBudgets()`, global row, `BudgetBar` labelled "AI budget today", linking to `/app/spend?tab=budgets`. It has an empty state when there is no global row.
- The **operator row**: `useAuth().me` initials, name, `@username` and Log out.
- Name and Log out leave the header.
- A small env pill shows only when `import.meta.env.VITE_ENV_LABEL` is set. No CI change in this spec.

**Top bar (AppShell)**
- A wide ⌘K search field.
- A "**N agents live**" pill: the count of editor channels in `live` mode from `useEditorChannels()`, hidden at ≤760px.
- A primary **New post** button. It links to `/app/compose` until wave B points it at the Calendar composer.
- Main padding is 32/32/48 (16 on mobile), max-width 1240.

**Active state**
- The longest visible prefix wins, so `/app/agents/inbox` lights Inbox and not Agents.

### D5. Inbox actions (backend gaps #1–#3, plus mark-unread)

Follow `research/inbox.md` §4, with:

**Gap #1: what the list returns**
- `GET /api/agents/inbox` items add `subject`, `parts` and `actions: {key, type, label, target}[]`.
- Labels are **English**, made by a new `actionView`. The stored Ukrainian labels stay for Telegram.

**Gap #2: running an action**
- `POST /api/agents/inbox/:id/actions {key}`.
  - The key must be one of the note's stored actions (the same rule as the Telegram callback).
  - It runs `SeriesPauseActions.run(id, key, 'dashboard')` and returns `{outcome, code, item}`.
- `via` is threaded through the log and reason texts, so the trace says the dashboard did it.
- Outcomes gain an English-mappable `code`.
- **Dashboard actions count as owner reactions** for the A10 demotion: `resolved_by` like `dashboard:%` counts as well as `telegram:%`.

**Gap #3: pausing a series from the dashboard**
- `POST /api/agents/:handle/series-pauses {action:'pause', key, label}`, alongside `resume`.
- It accepts `series:` / `rule:` keys and refuses `resource:` keys.

**Mark-unread (new)**
- `POST /api/agents/inbox/unread {ids}` clears `read_at` and `resolved_by` for the given ids. It powers **Undo** after Dismiss on Today and Inbox.

**Front end**
- **`src/lib/inbox-kinds.ts`** (pure, node-tested) covers every kind the backend writes (`research/inbox.md` §2; keep `critic_failed`). It gives:
  - a short English "Why it matters";
  - a primary action and an optional secondary action, as descriptors (link or operation);
  - ref parsing: `#hash`, `|day`, `telegram:@x`, and a first-colon split for series refs;
  - resolution of a handle from the agent tree when `agentId` is null.
- **`components/inbox/NoteActions.tsx`** executes the descriptors with the existing hooks plus the new ones (`useInboxAction`, `usePauseSeries`, `useMarkInboxUnread`).
  - After a decision it marks the note read and invalidates `['agents','inbox']` and the badges.
  - It shows English toasts.
  - Today and the Inbox page both use it.

### D6. Pages with a prototype (wave B)

**Today (`/app`)** — handoff §4 with `research/today.md` and its skeptic.

- **Needs you**
  - Data: `useAgentInbox(true)`, critical and action notes first, top 4.
  - A "**N posts to approve**" row when approvals are waiting.
  - Rows are card-rows inside a flush panel, with `NoteActions` and Dismiss, plus an Undo toast through mark-unread.
- **Headline**
  - Text: "N things need you".
  - Count = unread critical and action notes + `approvals.waiting` + pending chat cards. Directives arrive as notes, so they are not counted twice.
- **Ring and timeline**
  - Data: `useEditorPlans()` active plans. The Telegram lane is slots with no `resourceRef`.
  - A new `DayTimeline` with a fixed 06–24 axis and StatusMark markers, a now-line (refreshed each minute), past shading and a legend.
  - It scrolls horizontally at ≤860px.
- **Agents panel**
  - `ModeSwitch` keyed by channel (`EditorUi.tsx:72`), plus runs and spend today from `useEditorChannels()`.
  - Names and emoji come from the agent tree when it matches, with a fallback to the channel title.
- **Live activity**
  - A new `useMapSnapshot()` hook in `api/map.ts`. `MapPage` switches to it, so the cache is shared.
  - The 6 newest events, with a link to `/app/map`.
- **KPI strip**
  - Telegram subscribers, Meta followers, agent posts over 7 days, and AI spend over 7 days with a sparkline from the spend breakdown by day.
  - "Network health · N problems" is a link line from `useNetworkHealth()`.
- **Removed:**
  - the Errors and Meta Δ 24h tiles;
  - the legacy strategy runs block;
  - the Meta accounts block;
  - the empty health card.
  - Components left with no users are deleted. `BudgetBar` stays where it is, because the sidebar uses it.

**Inbox (`/app/agents/inbox`)** — handoff §5 with `research/inbox.md`.

- **Tabs:** To approve (`ApprovalList`, with its count) / All / Critical / Action / FYI, plus an Unread only switch (default on).
- **Search params:** `{tab, unread, note}`.
  - Legacy `tab=unread` → All with unread on. `tab=all` → All with unread off.
- **Layout:** master-detail at >860px. At ≤860px the details open in the Modal bottom sheet.
- **Detail pane:**
  - severity `Badge` and kind chip;
  - agent and time;
  - title;
  - What happened (body);
  - Why it matters;
  - `NoteActions`;
  - Mark as done;
  - a Technical details toggle (button) showing kind, severity, refType, refId and createdAt.
- **Also:**
  - Mark all as done.
  - Notes are grouped by `subject` in the All view.
  - The page title is "Inbox".

**Agent detail (`/app/agents/$handle`)** — handoff §6 with `research/agent.md`.

- **Tabs**
  - Five groups (Overview, Content, Brain, Activity, Settings) with `SegmentedTabs variant="underline"`, and a second level for groups that hold several tabs.
  - `?tab=` stays the leaf, and the group is derived from it.
  - There is a new `settings` leaf.
  - Every old link works.
- **Header**
  - Agent glyph (xl), name, kind chip, description, and `@handle → scope`.
  - A big 4-up mode switch with one line of explanation per mode. The text depends on the kind: @manager's shadow differs.
  - Actions: Run now, Chat with `<name>` (role agents → the parent), More (Pause/Resume, Edit, Set up channel).
- **Banners** for series pauses (with Resume) and for @manager resource pauses (with Lift).
- **Overview**
  - KPI strip.
  - "Today, step by step": `useNetworkPlan` merged with runs, with StatusMark and the skip reason.
  - Compact Channel and How-posts-look summaries that link to Settings.

**Calendar (`/app/calendar`)** — handoff §7 with `research/calendar.md`.

- **Grid**
  - Rows are the orchestrators, plus an "**Other channels**" row (the prototype's "Pipelines" has no source).
  - Columns are 5 days starting today, with prev/next/today navigation and `?from=`.
  - The per-agent schedule range endpoint provides slots and projections. Owner posts come from `/scheduled-posts`.
- **Chips**
  - Each chip uses StatusMark. A click opens the slot page, or edits the owner's post.
  - "Not planned yet" projections get a dashed warning chip.
- **Composer drawer** (`?compose=new&channel=&day=`)
  - Built on `PostComposer` and `post/TelegramPreview`, with errors shown only after submit or blur.
  - "Ask the agent" creates a one-off pin rule when the brief's route exists. Otherwise it is disabled with a one-line reason.
  - After a save, a toast offers Undo (cancel the pending post).
- **Other changes**
  - The header's **New post** button opens this drawer.
  - `legacy-redirects.test.ts` is updated.
  - `/app/scheduled` and `/app/compose` keep working.

**Landing (`/`, `/white-label`)** — handoff §8 with `research/landing.md`.

- Use the section components named in the handoff.
- Infinite loops are CSS `transform`/`opacity` keyframes, paused off-screen with IntersectionObserver.
- Entrances use `motion` `whileInView once`. The hero entrance is ≤900ms.
- Reduced motion stops every loop. A no-JS visitor sees final values.
- Remove "| DEV" from public channel names in `lib/landing-view.ts`.
- CTA, lead forms and the beacon behave exactly as before.

### D7. Pages without a prototype (wave C)

`research/other-pages.md` §3 has a per-page plan, and its §5 has six batches. Each batch:

- **Pages:** every page gets the new page header (with an eyebrow where a context line helps).
- **Lists:** entity lists become rows in a flush panel; dense data stays in `ui/table` inside a panel; KPIs become a `StatStrip`.
- **Controls:** filter bars use the track tabs with counts; mode controls use the tones.
- **Clean-up:**
  - no hand-rolled hover JS;
  - no literal hex;
  - no font sizes below 11px;
  - phone layouts work at 375px.
- **Must not break:** the graph canvas, the map SVG engine and the chat composer.
- **File ownership:** shared files (`ui/*`, `index.css`, `SegmentedTabs`, `Modal`, `nav/*`, `AppSidebar`, `AppShell`, chart files) are **frozen** in wave C. Page-specific CSS goes in an area file next to the route's components.

## Waves and file ownership

See `tasks.md` for the task lists. Waves run in this order: **A → merge and verify → B → merge and verify → C → merge and verify.**

Inside a wave, an agent edits only the files its task list owns. Exceptions are small appends to shared files, which the task lists name.

## Verification

Every agent, before every commit (Node 20):

- **Dashboard:** `npx tsc --noEmit`, `npm test` and `npm run build`.
- **Automation, when touched:** `npm test`, `npm run build` and `npm run lint`, plus the PG tests of touched files against the scratch Postgres.

The lead, after each wave's merge:

- the full suites;
- a browser pass of every touched page against the mock API (A4) at 1280px and 375px, with reduced motion on and off;
- an adversarial review of the merged diff.
