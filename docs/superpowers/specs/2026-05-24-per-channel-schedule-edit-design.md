# Per-channel schedule editing — design

## Context

A strategy in this codebase is not a separate entity from its channel. The
`strategy_bindings` table stores one row per `(strategy_type, channel)` pair,
and each row carries its own `schedule` cron expression:

```sql
CREATE TABLE strategy_bindings (
  id         UUID PRIMARY KEY,
  ext_id     TEXT UNIQUE NOT NULL,    -- e.g. "quotes:local_motivation"
  type       TEXT NOT NULL,           -- e.g. "quotes"
  channel_id UUID NOT NULL,           -- the channel this binding posts to
  schedule   TEXT NOT NULL,           -- cron — already per-(type,channel)
  params     JSONB NOT NULL DEFAULT '{}',
  enabled    BOOLEAN NOT NULL DEFAULT true,
  notes      TEXT
);
```

So the data model already supports running the same strategy type on different
channels with different cadences. What's missing is the **UI affordance** on
the channel detail page: today the "Publishing strategies" panel
(`apps/dashboard/src/routes/channels_.$id.tsx`) renders the cron expression
in a read-only `<td>` and points users to `/strategies` to edit it.

This spec adds in-place schedule editing to that panel so an operator looking
at one channel doesn't have to leave the page to retime its strategies.

## Goal

From the channel detail page, click the cron cell on any **primary** strategy
row to edit just that binding's schedule. Save commits via the existing
`PATCH /strategies/:id { schedule }` endpoint. The scheduler hot-reloads via
`config:changed` (already wired) and the cron starts firing on the new
expression within a tick.

## Non-goals

- Editing `params`, `enabled`, channel reassignment, type — those keep living
  in `EditStrategyModal` on the `/strategies` page.
- Editing **forward-bound** strategies from the channel page. Those are
  defined on a different channel (the source) and inherited here via
  `forward_routes`. Editing them from a forward target would also affect
  every other channel that forwards from the same source, which is
  surprising. They stay read-only on the channel page; the user can still
  edit them from `/strategies`.
- Backend changes. The endpoint, scheduler reconcile loop, and
  `config:changed` notification all exist and work.
- Schema changes. No migration, no new column.

## UX

### Today

```
Publishing strategies
┌──────────────────────┬──────────────┬─────────────┬──────────┐
│ Strategy             │ Role         │ Schedule    │ Status   │
├──────────────────────┼──────────────┼─────────────┼──────────┤
│ Quotes (#quotes)     │ Primary      │ */5 * * * * │ Enabled  │
│ Birthday (#birthday) │ Primary      │ 0 9 * * *   │ Enabled  │
│ Ad reposts (#ads)    │ Forward      │ */15 * * * *│ Enabled  │
└──────────────────────┴──────────────┴─────────────┴──────────┘
                                          [Manage strategies ↗]
```

The schedule column is plain text. Editing requires:
1. Click "Manage strategies ↗"
2. Find the right row in the strategies page
3. Open EditStrategyModal
4. Change one field, save

### After

The schedule cell on **primary** rows becomes interactive:

```
│ Quotes (#quotes)     │ Primary      │ [*/5 * * * * ✎]    │ Enabled  │
```

Click the cell → it expands inline into the editor (the row height grows;
no modal, no page navigation):

```
│ Quotes (#quotes)     │ Primary      │ ┌──────────────────────────────┐  │ Enabled │
│                      │              │ │ [*/5 * * * *           ]     │  │         │
│                      │              │ │ [Every hour] [Every 30m]…    │  │         │
│                      │              │ │           [Cancel] [Save]    │  │         │
│                      │              │ └──────────────────────────────┘  │         │
```

- The text input is prefilled with the current cron expression
- Preset chips (same six as `EditStrategyModal.tsx` already defines) one-click
  fill the input
- **Save** is disabled if the expression hasn't changed from the original
- **Save** patches `{ schedule: <new> }`; on success the cell collapses back
  to the new value
- **Cancel** discards the edit, cell collapses to the original value
- Save errors render inline above the buttons (red, one line)
- Only one row can be editing at a time — opening edit on row B cancels row A

Forward rows keep the plain text schedule and get a small `(forwarded — edit on source)`
caption to make the asymmetry obvious.

The "Manage strategies ↗" link stays — it's still the entry point for everything
that isn't schedule.

## Components

### New: `SchedulePicker`

`apps/dashboard/src/components/SchedulePicker.tsx`

A small controlled component used both inline on the channel page and (later
or now, as a no-op extraction) inside `EditStrategyModal`. Pulls the
`COMMON_SCHEDULES` constant currently inlined in `EditStrategyModal.tsx` into
one place so both call-sites stay in sync.

```tsx
interface Props {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}

export function SchedulePicker({ value, onChange, disabled }: Props) {
  // text input + preset chips, same as the current modal layout but
  // self-contained so it can render in either context.
}
```

Constants exported from the same module:

```ts
export const COMMON_SCHEDULES: Array<{ label: string; expr: string }> = [ … ];
```

`EditStrategyModal.tsx` imports `SchedulePicker` and `COMMON_SCHEDULES` from
here instead of redefining them. This is a small refactor that removes
duplication created by the new use site, not unrelated cleanup.

### New: `InlineScheduleEditor`

`apps/dashboard/src/components/InlineScheduleEditor.tsx`

The expand-on-click cell wrapper. Owns the local "editing" state and the
patch mutation.

```tsx
interface Props {
  strategyId: string;
  current:    string;          // current cron expression
  onSaved:    () => void;      // parent uses this to clear "currently editing" id
}
```

States:
- **collapsed** — renders `<span>{current}</span>` + a small pencil icon on hover
- **expanded** — renders `<SchedulePicker>` + Save/Cancel buttons

Uses `usePatchStrategy()` from `apps/dashboard/src/api/strategies.ts` to
PATCH the binding. On success it calls `onSaved()` and lets React Query's
existing invalidation refresh the list.

### Modified: `StrategiesPanel` in `channels_.$id.tsx`

- Holds one piece of local state: `editingId: string | null` — which row is
  currently expanded. Clicking edit on a new row cancels the previous one
  (single-row-edit invariant).
- For **primary** rows, replaces the plain `<td>{s.schedule}</td>` with
  `<InlineScheduleEditor strategyId={s.id} current={s.schedule}
    onSaved={() => setEditingId(null)} />` and surrounds it in a click handler
  that sets `editingId`.
- For **forward** rows, keeps the plain text + adds the small caption
  `(forwarded — edit on source)`.

## Data flow

```
[click cron cell]
        │
        ▼
InlineScheduleEditor expands, prefilled with s.schedule
        │
        ▼  user types or clicks preset
SchedulePicker → onChange → local state
        │
        ▼  click Save
usePatchStrategy.mutateAsync({ id, patch: { schedule } })
        │
        ▼
PATCH /strategies/:id  → strategies-api updates row → publishes config:changed
        │
        ▼
Backend SchedulerService picks up config:changed → reconciles cron job for this binding
        │
        ▼
React Query invalidates ['strategies'] → channel page re-renders → cell collapses to new value
```

No new endpoint, no new event, no new repository method.

## Error handling

- **Invalid cron expression** — backend already validates (or fails to register).
  We render the error message returned by the mutation inline above the buttons.
  The editor stays open so the user can fix it.
- **Network/timeout** — same inline error. Cancel and try again is always available.
- **Stale schedule (someone edited it in another tab)** — last-writer-wins, same
  as the modal today. Acceptable for a single-operator tool.

## Testing

- **Unit (frontend):** none new required — the existing components have no test
  coverage and adding it here would expand scope. The mutation hook and PATCH
  endpoint are already exercised by the modal use site.
- **Manual smoke (in cost-safe local mode, per CLAUDE.md):**
  1. Open `/channels/<motivation_local_id>` — see Quotes binding with cron.
  2. Click the cron cell — editor expands.
  3. Click a preset chip — value changes.
  4. Click Save — cell collapses, value visible is the new cron.
  5. Open `/strategies` — same binding shows the new cron.
  6. Open the channel page in two tabs — edit in tab A, refresh tab B,
     verify B sees the new value.
  7. Edit a *forward* row — confirm there's no editor, caption is visible.

Cost safety: this is read-mostly UI work. The only writes are PATCHes to
strategy bindings the user is already editing today via the modal; the
strategies stay disabled in local mode so no publishes fire.

## Files touched

| File | Change |
|---|---|
| `apps/dashboard/src/components/SchedulePicker.tsx` | new — picker + COMMON_SCHEDULES |
| `apps/dashboard/src/components/InlineScheduleEditor.tsx` | new — click-to-edit cell |
| `apps/dashboard/src/components/EditStrategyModal.tsx` | import SchedulePicker, drop the inline copy of COMMON_SCHEDULES + cron input markup |
| `apps/dashboard/src/routes/channels_.$id.tsx` | wire InlineScheduleEditor into StrategiesPanel for primary rows; caption on forwards |

No backend files. No migrations. No `apps/dashboard/src/api/*` changes —
`usePatchStrategy` already takes a partial body and `schedule` is already
in the PATCH DTO whitelist.

## Out-of-scope follow-ups

- Show "next fire" preview next to the cron expression (already on the
  page header, would be nice per-row but is a separate change).
- Cron expression linter on the client (currently we rely on backend
  validation). Could add a tiny `cronstrue`-based humaniser as a follow-up.
- Bulk retime ("apply this schedule to all bindings on this channel") —
  not requested, skip.
