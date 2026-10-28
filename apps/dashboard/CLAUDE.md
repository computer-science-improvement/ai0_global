# Dashboard UI conventions

Instructions for building/editing the dashboard (`apps/dashboard`). Follow these so the UI stays consistent. The design system lives in `src/index.css` (CSS variables, dark theme, single green accent `--color-accent`, amber for "a human has to act"). Shared primitives are in `src/components/ui/`.

## Design language (spec 078)

Dark surfaces, hairlines instead of shadows, one green accent, **amber is the colour of the human** (approve, missed, "needs you"), mono for machine-ish facts. Build a page from the parts below and it matches every other page. Inline styles are for layout only (flex, gap, margin, min-width), never for colour, radius or type size.

### A page, top to bottom

```tsx
<PageHeader eyebrow="Wed, 28 Oct · Kyiv" title="Spend" subtitle="What the agents cost."
            actions={<Button variant="secondary" size="sm">Export</Button>} />

<StatStrip label="Key numbers">        {/* 3+ numbers: ONE panel split by hairlines, not a grid of cards */}
  <StatTile label="Today" value="$1.20" delta="+$0.30 vs yesterday" deltaTone="warning" spark={last7} />
  <StatTile label="7 days" value="$8.40" />
</StatStrip>

<SectionCard title="Providers" icon="spend" flush
             action={<Link className="panel-link" to="/app/spend">Open budgets →</Link>}>
  {rows.map((r) => (                    {/* a list of entities = rows in a flush panel */}
    <div className="panel-row" key={r.id}>
      <AgentGlyph agent={r.agent} />
      <div style={{ flex: 1, minWidth: 0 }}>{r.name} <span className="mono">@{r.handle}</span></div>
      <Badge tone="success">live</Badge>
      <RowActions><TableAction action="edit" onClick={…} /></RowActions>
    </div>
  ))}
  <div className="panel-foot">…optional footer line or "Show all" ghost button…</div>
</SectionCard>
{!rows.length && <EmptyState tone="clear" title="All clear" note="Nothing needs you." />}
```

### Which part for which situation

| Situation | Use |
|---|---|
| Page title, context line, page actions | `PageHeader` (`eyebrow` is the mono overline above the title: date, place or parent page). Never a hand-made `<h1>`. |
| 3+ KPIs / one KPI / a KPI with a trend | `StatStrip` of `StatTile` / one `StatTile` / `StatTile spark={[…]}` (last N values, oldest first) |
| A titled block | `SectionCard` (padded). Add `flush` when its content is rows. The title is `.text-heading-md`; do not size it inline. |
| A list of entities (agents, channels, posts, rules) | **Rows in a flush panel**: `SectionCard flush` + `.panel-row` (flex row, hairline between rows, hover wash, `.is-selected` = accent edge). A clickable row is `<a className="panel-row">` or `<button className="panel-row">`. Row actions: `RowActions` / `.btn-act`. |
| Dense, column-oriented data | `ui/table` (below) inside a `SectionCard`, KPIs above it as a `StatStrip`. |
| Facts inside a panel / code, JSON, logs | `.inset` (darker box; use a `.text-overline` key per fact) / `.code-block` |
| Filters or views of one list | `SegmentedTabs` (track). Give every option a `count`. For a state switch (the mode) give options a `tone`. The big 4-up switch is `size="lg"`. Sections of a detail page are `variant="underline"`. |
| An on/off choice | `.chip-toggle` with `aria-pressed` (`.is-warning` when it is a human-owned switch like Lock) |
| A status in a **table or row** | `Badge tone=…`; tone and label come from `lib/status-tone.ts` (`slotTone`, `slotLabel`, `publicationTone`, `publicationLabel`). Never write a local tone map. |
| A status on a **timeline, calendar chip or legend** | `StatusMark status={slotMark(slot)}`. Each status has its own shape, because green already means "success" in several statuses. "Missed" and "not planned" are computed: `isMissed(slot)`. |
| Severity of a note | `SeverityPill` (labelled), `SeverityMark` (8px lead of a list row) |
| "N agents live" | `LivePill`. A pulsing dot alone: `<span className="status-dot is-live" />` |
| An empty list | `EmptyState` with a one-line `note` and, when there is one, the next action. `tone="clear"` is the good kind ("All clear"). Inside a panel it loses its dashed frame. |
| A banner that asks for attention | `.callout-warning` (needs you) / `.callout-danger` (failed) / `.callout-success`; the action button goes last (`.btn-warning` or `.btn-secondary btn-sm`) |
| A form in a side sheet | `<Modal size="drawer">` (right sheet; a bottom sheet on phones automatically) |
| A confirmation with a way back | `toast.success('Post canceled', { action: { label: 'Undo', onClick } })` |

### Buttons

`.btn-primary` is the one main action of a view. Everything else is `.btn-secondary` (bordered ghost). Cancel, Close and "Show more" are `.btn-ghost`. `.btn-danger` only in a confirm. `.btn-warning` is for the human's call (Resume planning, Lift the pause). Standalone buttons are 40px (44px on touch); add `btn-sm` (36px, still a 44px hit area) in panel heads and toolbars. In tables and rows use `TableAction`, `.btn-tiny` or `.btn-act` (30px look, 44px hit area); a `.btn-*` inside a `.table` shrinks to 32px on its own. The radius is always `--radius-sm`. `Button` takes `variant` and `size="sm"`.

```tsx
<div className="modal-foot">
  <button className="btn-ghost" onClick={close}>Cancel</button>
  <button className="btn-primary" onClick={save}>Save</button>
</div>
```

### Type

- Sizes come from the `.text-*` tiers: `.page-title` 32, `.text-heading-md` 15/600, `.text-body` 15, `.text-body-sm` 14, `.text-caption` 13, `.text-micro` 12. **Nothing below 11px**, no half-pixel sizes.
- **Mono** (`.mono`, or `var(--font-mono)`): handles (`@space`), times and relative ages, counts in pills, kind codes, ids, money in dense rows, technical details, breadcrumbs. **Never** for titles, prose or big KPI values.
- **Overline** (`.text-overline`: mono 11px, uppercase, wide tracking): the line above a page title, the key of a key/value block, a group title. It is not a form-field label (that is `.text-eyebrow`, which `Field` uses: sentence case, 13px). No other text is uppercase.
- Sentence case everywhere ("Needs you", "Open inbox"), English only.

### Colour, radius, space, elevation

- Colour: `var(--color-*)` only. No literal hex or rgb, except a per-destination tint (Telegram blue and the like). Tints of a token: `color-mix(in srgb, var(--color-accent) 8%, transparent)`. Ink ladder: `ink` (text), `ink-muted` (secondary), `ink-dim` (tertiary: labels, placeholders; AA contrast). Text on a solid accent, warning or danger fill uses `--color-on-accent`, `--color-on-warning`, `--color-on-danger`.
- Radius: `--radius-xl` panels and dialogs; `--radius-lg` insets, callouts, KPI tiles, tab tracks; `--radius-md` inputs, tabs, toggles; `--radius-sm` buttons; `--radius-pill` pills. No numeric `borderRadius` except `'50%'` for dots.
- Elevation: hairlines first. `--shadow-1`, `--shadow-2`, `--shadow-pop`, `--shadow-modal` only for things that float or lift: a hovered panel, a sticky bar, a menu, a toast, a dialog.
- Space: 8px base (`--space-*`). Panel padding is 20px (16px on phones), row padding 12px 20px. The page gutter is set by `AppShell`.

### Motion

- Entrances: `compose-rise` with a staggered `animationDelay` (`SectionCard delay={n}` does it). Small swaps: `.anim-fade-up`, `.anim-slide-in`, `.anim-pop`, `.anim-slide-left`. Bars: `.anim-grow-x` / `.anim-grow-y`. Durations and easing are `--dur-fast|base|enter` and `--ease-out`; hover and press transitions stay under 200ms.
- **Reduced motion is handled globally**: the last block of `index.css` collapses every animation and transition duration and delay to about zero. Your rules: never write `animation: none` (an element that starts at `opacity: 0`, like `.compose-rise`, would stay invisible); never hand-roll a `prefers-reduced-motion` override for a CSS animation; for motion driven from JS (recharts, canvas) gate on `usePrefersReducedMotion()` from `lib/useReducedMotion` (`isAnimationActive={!reduced}`).
- No hover-style JS (`onMouseEnter` that swaps a style): use a class and `:hover`. A control that appears only on hover: `.hover-parent` on the row plus `.hover-reveal` on the control (it stays visible on touch).

### Responsive

Every page works at 375px: panels stack, `.stat-strip` wraps, tables scroll inside `.table-wrap`, dialogs become bottom sheets, tap targets reach 44px. Put `min-width: 0` on flex children that hold text, `flex-wrap: wrap` on rows with actions, and `.clamp` on long text.

## Language

All interface text is **English**: labels, buttons, tabs, dialogs, toasts, empty states, errors, chart legends and the public pages (landing, `/report/$token`). Dates and times use an English locale (`en-GB`), with the time zone named when it matters. Only content is left as written: post previews, captions and agent replies.

## Icons

Two icon modules exist — **prefer `components/ui/Icon.tsx`** (typed Lucide wrapper, `name` + `size`, exports `IconName`). The hand-rolled `components/Icon.tsx` also accepts `style`; use it only when you need to spread style onto the SVG. Invalid icon names fail `tsc`, so stick to the `IconName` set.

## Tables

All data tables follow ONE structure. The shared helpers are in **`src/components/ui/table.tsx`** — use them; do not hand-roll row-action buttons or invent new action icons.

**Markup:**
```tsx
<div className="table-wrap">
  <table className="table">
    <thead><tr>
      <th>Label</th>
      <th className="num">Numeric</th>   {/* right-aligned numeric columns */}
      <ActionsTh />                        {/* always last; right-aligned, 240px */}
    </tr></thead>
    <tbody>
      <tr>
        <td>…</td>
        <td className="num">…</td>
        <td style={{ textAlign: 'right' }}>
          <RowActions danger={<TableAction action="delete" onClick={…} />}>
            <TableAction action="edit"   onClick={…} />
            <TableAction action="enable" onClick={…} />
          </RowActions>
        </td>
      </tr>
    </tbody>
  </table>
</div>
```

**Row actions** — always `<TableAction>` from `ui/table`. It renders a bordered square **icon button** (`.btn-act`); the label is a hover tooltip (pass `label` only when you want the text shown too, which tables normally don't). The **destructive action goes in `<RowActions danger={…}>`** — it's rendered after a divider so it can't be misclicked next to Enable/Pause. The canonical vocabulary (one icon + tooltip per semantic action) is the `ACTION` map; never pick a different icon for these:

| Action | `action` key | Icon | Label | Variant |
|---|---|---|---|---|
| Add | `add` | `plus` | Add | normal |
| Edit | `edit` | `pencil` | Edit | normal |
| Delete | `delete` | `trash` | Delete | **danger** |
| Verify | `verify` | `refresh` | Verify | normal |
| Pause | `pause` | `pause` | Pause | normal |
| Enable / activate | `enable` | `play` | **Enable** | normal |

For an action outside this list, pass `icon` + children to `<TableAction>` (still uses `.btn-tiny`); add it to `ACTION` if it recurs. Destructive actions use `danger`/`.btn-tiny-danger`. The page-level "Add X" button stays the larger `.btn-primary` (the `add` row-action is for in-table use).

**Status cells** — always the `<Badge tone>` component (`ui/Badge`), tone `success | warning | danger | accent | neutral`. Slot and publication statuses take their tone and label from `lib/status-tone.ts`, the one status map of the app. Do **not** use the legacy `.chip chip-*` classes anywhere a status is shown — tables, entity rows, detail pages. (Neutral `.chip` is still fine for non-status metadata tags like a channel kind.) On timelines, calendar chips and legends the status is a `StatusMark` instead (shape plus colour).

**Numeric columns** — add `className="num"` to both the `<th>` and `<td>` (right-aligns, tabular figures).

**Actions column** — always the last column, rendered via `<ActionsTh>` (header) + a right-aligned `<td>` wrapping `<RowActions>`. Fixed width `ACTIONS_COL_WIDTH` (240).

## Entity lists (rows in a flush panel)

Connection/entity managers (Strategies, Bots, Telegraph, MTProto sessions, Meta
accounts, Tracked channels, agents, rules) render **rows in a flush panel, not
tables and not stacks of cards**: `<SectionCard title="…" flush>` with one
`.panel-row` per entity — identity block left (title + `<Badge>` statuses +
muted or mono meta line), numbers and `RowActions`/icon-only `btn-act` buttons
right, destructive action last with the `btn-act-danger` variant behind a
`useConfirm()` dialog. A text-link `action` of the panel takes
`className="panel-link"`. Stagger the `compose-rise` entrance of the panels
(`SectionCard delay`), not of each row. Pages that still render `card row-lift`
rows keep working until they are restyled; do not start new ones. Tables
(`ui/table.tsx`) remain for dense, column-oriented data (logs, recommendations).

## Compact cards (rich items)

Lists of rich items — posts to approve, directives, ideas, reviews, inbox messages, data items — never
render tall cards with the whole content inline. Use **`<CompactCard>`** (`components/ui/CompactCard.tsx`):
the card shows 3–5 key facts (badges/chips in `top`, the time in `meta`, a one-line `title`, a `body`
clamped to 2 lines, an optional `note` that asks for attention) and a click opens a dialog with
everything else (`dialog.body`) and the actions (`dialog.actions`, a sticky footer). Grid: `.compact-grid`.

- The card is a `<button>`: no buttons, links or inputs inside it — actions live in the dialog.
- Put the details in a `XxxDetails` component and the actions in `XxxActions({ onDone })`; call `onDone`
  (the dialog's `close`) once the item is settled. See `DirectiveCard` and `ApprovalCard`.
- Deep links (`?directive=`, `?idea=`…) pass `focused` — the card scrolls into view and opens.
- Sub-dialogs (edit, reject, confirm) open on top: `Modal` keeps a stack, Escape closes only the top one.
- Rows of entities with toggles or icon buttons stay rows in a flush panel (see "Entity lists"); just clamp long text (`.clamp`, `--clamp`).
- Never use `<details>` or inline expand toggles for long content — open a dialog.
- **One exception, the Inbox** (`/app/agents/inbox`): a master-detail page. At more than 860px a list of notes on the left
  and the selected note's details and actions in a pane on the right; at 860px and below the details open in a
  bottom-sheet `Modal`. Its list rows are selectable rows (`.panel-row` with `.is-selected`), not `CompactCard`s.
  Everywhere else rich items stay compact card, then dialog.

## Graph page

`components/GraphCanvas.tsx` renders via `force-graph` on a single canvas —
never introduce per-node DOM/SVG rendering there (that's what froze the page at
scale). Perf harness: `/app/graph?synthetic=2000` in dev builds.

## General

- Use the shared primitives in `ui/primitives.tsx` (`SectionCard`, `EmptyState`, `StatusDot`, `StatTile`, `StatStrip`, `Field`), `ui/PageHeader`, `ui/Badge`, `ui/StatusMark`, `ui/Pills` (`SeverityPill`, `SeverityMark`, `LivePill`), `ui/Sparkline`, `ui/Button`, `SegmentedTabs`, `Pagination`, `Modal` rather than re-implementing.
- Modals: `components/Modal.tsx` (portals to `<body>`, `.modal-head`/`.modal-foot`, `icon` prop, `size`: `md | lg | xl | drawer`).
- Toasts: `toast.success(text)` / `toast.error(text)` from `ui/Toast`; the second argument is `{ action?: { label, onClick }, ttlMs? }`.
- Colors/spacing/radius: always CSS variables (`--color-*`, `--space-*`, `--radius-*`), never hard-coded hex (except small per-destination tints).
