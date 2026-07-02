# Dashboard UI conventions

Instructions for building/editing the dashboard (`apps/dashboard`). Follow these so the UI stays consistent. The design system lives in `src/index.css` (CSS variables, dark Supabase theme, single green accent `--color-accent`). Shared primitives are in `src/components/ui/`.

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

**Status cells** — always the `<Badge tone>` component (`ui/Badge`), tone `success | warning | danger | accent | neutral`. Do **not** use the legacy `.chip chip-*` classes anywhere a status is shown — tables, card-rows, detail pages. (Neutral `.chip` is still fine for non-status metadata tags like a channel kind.)

**Numeric columns** — add `className="num"` to both the `<th>` and `<td>` (right-aligns, tabular figures).

**Actions column** — always the last column, rendered via `<ActionsTh>` (header) + a right-aligned `<td>` wrapping `<RowActions>`. Fixed width `ACTIONS_COL_WIDTH` (240).

## Card-row lists

Connection/entity managers (Strategies, Bots, Telegraph, MTProto sessions, Meta
accounts, Tracked channels) render **card-rows, not tables**: one `card row-lift`
(or surface-1 rounded) row per entity inside a `SectionCard`/page list — flex
layout, identity block left (title + `<Badge>` statuses + muted meta line),
numbers and `RowActions`/icon-only `btn-act` buttons right, destructive action
last with the `btn-act-danger` variant behind a `useConfirm()` dialog. Use a
staggered `compose-rise` entrance for lists. Tables (`ui/table.tsx`) remain for
dense, column-oriented data (logs, recommendations).

## Graph page

`components/GraphCanvas.tsx` renders via `force-graph` on a single canvas —
never introduce per-node DOM/SVG rendering there (that's what froze the page at
scale). Perf harness: `/app/graph?synthetic=2000` in dev builds.

## General

- Use the shared primitives in `ui/primitives.tsx` (`SectionCard`, `EmptyState`, `StatusDot`, `StatTile`, `Field`) and `ui/Badge`, `SegmentedTabs`, `Pagination`, `Modal` rather than re-implementing.
- Modals: `components/Modal.tsx` (portals to `<body>`, `.modal-head`/`.modal-foot`, `icon` prop).
- Colors/spacing/radius: always CSS variables (`--color-*`, `--space-*`, `--radius-*`), never hard-coded hex (except small per-destination tints).
