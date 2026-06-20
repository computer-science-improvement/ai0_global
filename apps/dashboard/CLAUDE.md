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
          <RowActions>
            <TableAction action="edit"   onClick={…} />
            <TableAction action="delete" onClick={…} />
          </RowActions>
        </td>
      </tr>
    </tbody>
  </table>
</div>
```

**Row actions** — always `<TableAction>` from `ui/table`. The canonical vocabulary (one icon + label per semantic action) is the `ACTION` map; never pick a different icon/label for these:

| Action | `action` key | Icon | Label | Variant |
|---|---|---|---|---|
| Add | `add` | `plus` | Add | normal |
| Edit | `edit` | `pencil` | Edit | normal |
| Delete | `delete` | `trash` | Delete | **danger** |
| Verify | `verify` | `refresh` | Verify | normal |
| Pause | `pause` | `pause` | Pause | normal |
| Enable / activate | `enable` | `play` | **Enable** | normal |

For an action outside this list, pass `icon` + children to `<TableAction>` (still uses `.btn-tiny`); add it to `ACTION` if it recurs. Destructive actions use `danger`/`.btn-tiny-danger`. The page-level "Add X" button stays the larger `.btn-primary` (the `add` row-action is for in-table use).

**Status cells** — always the `<Badge tone>` component (`ui/Badge`), tone `success | warning | danger | accent | neutral`. Do **not** use the legacy `.chip chip-*` classes in tables.

**Numeric columns** — add `className="num"` to both the `<th>` and `<td>` (right-aligns, tabular figures).

**Actions column** — always the last column, rendered via `<ActionsTh>` (header) + a right-aligned `<td>` wrapping `<RowActions>`. Fixed width `ACTIONS_COL_WIDTH` (240).

## General

- Use the shared primitives in `ui/primitives.tsx` (`SectionCard`, `EmptyState`, `StatusDot`, `StatTile`, `Field`) and `ui/Badge`, `SegmentedTabs`, `Pagination`, `Modal` rather than re-implementing.
- Modals: `components/Modal.tsx` (portals to `<body>`, `.modal-head`/`.modal-foot`, `icon` prop).
- Colors/spacing/radius: always CSS variables (`--color-*`, `--space-*`, `--radius-*`), never hard-coded hex (except small per-destination tints).
