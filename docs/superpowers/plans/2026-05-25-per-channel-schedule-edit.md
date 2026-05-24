# Per-Channel Schedule Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow operators to edit a strategy binding's cron schedule directly from the channel detail page via an inline click-to-edit cell, without leaving for the `/strategies` page.

**Architecture:** Pure frontend change. Extract the existing cron preset chips + input from `EditStrategyModal.tsx` into a reusable `SchedulePicker`. Wrap it in an `InlineScheduleEditor` that owns local edit state and calls the existing `usePatchStrategy({ schedule })` mutation. Wire it into the primary-rows of `StrategiesPanel` in `channels_.$id.tsx`. Forward-bound rows get a caption and stay read-only. No DB migration, no backend changes — `strategy_bindings.schedule` is already per-(type, channel) and the PATCH endpoint already accepts a schedule-only body.

**Tech Stack:** React 18, TanStack Query v5, TanStack Router, TypeScript. Dashboard lives under `apps/dashboard/`. Builds with Vite (`pnpm --filter dashboard build`). Dashboard has no frontend unit tests today — verification is `tsc` + manual smoke in cost-safe local mode.

**Spec:** `docs/superpowers/specs/2026-05-24-per-channel-schedule-edit-design.md`

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `apps/dashboard/src/components/SchedulePicker.tsx` | **create** | Reusable cron input + preset chips. Exports `SchedulePicker` and `COMMON_SCHEDULES`. |
| `apps/dashboard/src/components/InlineScheduleEditor.tsx` | **create** | Click-to-edit cell wrapper. Collapsed: text + pencil. Expanded: picker + Save/Cancel + inline error. |
| `apps/dashboard/src/components/EditStrategyModal.tsx` | **modify** | Replace inline cron input + `COMMON_SCHEDULES` constant with `<SchedulePicker>` import. |
| `apps/dashboard/src/routes/channels_.$id.tsx` | **modify** | `StrategiesPanel` tracks `editingId`; primary rows render `<InlineScheduleEditor>` in the schedule cell; forward rows render `(forwarded — edit on source)` caption. |

No backend files. No migration. No `apps/dashboard/src/api/*` changes — `usePatchStrategy` from `apps/dashboard/src/api/strategies.ts` already accepts `{ schedule?: string }` in its PATCH body type and is the same hook used by `EditStrategyModal`.

---

## Task 1: Extract SchedulePicker component

**Files:**
- Create: `apps/dashboard/src/components/SchedulePicker.tsx`

The current `EditStrategyModal.tsx` has the cron input + preset chip strip inlined. Pull both the markup and the `COMMON_SCHEDULES` constant into a self-contained component so the same UI can render inside the modal and in the new inline editor.

- [ ] **Step 1: Create the file**

Write `apps/dashboard/src/components/SchedulePicker.tsx`:

```tsx
// apps/dashboard/src/components/SchedulePicker.tsx
//
// Cron expression editor: a free-text input plus one-click preset chips.
// Used both inside EditStrategyModal (full strategy edit) and inside
// InlineScheduleEditor (per-row inline edit on the channel detail page).
// Kept here as a single source of truth so both call-sites stay in sync
// on the preset list and look identical.

export const COMMON_SCHEDULES: Array<{ label: string; expr: string }> = [
  { label: 'Every hour (top of hour)', expr: '0 * * * *' },
  { label: 'Every 30 minutes',         expr: '*/30 * * * *' },
  { label: 'Daily at 09:00',           expr: '0 9 * * *' },
  { label: 'Daily at 18:00',           expr: '0 18 * * *' },
  { label: 'Weekdays at 09:00',        expr: '0 9 * * 1-5' },
  { label: 'Every 4 hours',            expr: '0 */4 * * *' },
];

interface Props {
  value:    string;
  onChange: (next: string) => void;
  disabled?: boolean;
  /** Render the preset chips inline vs hidden. Inline editor uses compact layout. */
  compact?:  boolean;
  /** Optional input id for label-for wiring in the modal. */
  inputId?:  string;
}

export function SchedulePicker({ value, onChange, disabled, compact, inputId }: Props) {
  return (
    <>
      <input
        id={inputId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="input-field"
        style={{ width: '100%', fontVariantNumeric: 'tabular-nums' }}
      />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: compact ? 6 : 8 }}>
        {COMMON_SCHEDULES.map((s) => (
          <button
            key={s.expr}
            type="button"
            onClick={() => onChange(s.expr)}
            disabled={disabled}
            className={value === s.expr ? 'chip is-active' : 'chip'}
            style={{ cursor: disabled ? 'default' : 'pointer', border: 'none' }}
          >
            {s.label}
          </button>
        ))}
      </div>
    </>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter dashboard exec tsc --noEmit`
Expected: passes (the file is self-contained and uses only existing classes).

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/components/SchedulePicker.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): extract SchedulePicker for cron edit UX

Pulls the cron input + preset chip strip out of EditStrategyModal so the
same component can also power the upcoming inline schedule editor on the
channel detail page. No behaviour change yet — picker is unused.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Migrate EditStrategyModal to SchedulePicker

**Files:**
- Modify: `apps/dashboard/src/components/EditStrategyModal.tsx`

Replace the inline `COMMON_SCHEDULES` constant and the inline `<input>` + chip markup inside the `Field label="Schedule (cron)"` block with a `<SchedulePicker>` call. Drop the now-unused local constant.

- [ ] **Step 1: Add the import**

In `apps/dashboard/src/components/EditStrategyModal.tsx`, edit the imports block (lines 7–14 area). The existing imports look like:

```tsx
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { trackingApi } from '../api/tracking';
import { usePatchStrategy } from '../api/strategies';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { STRATEGY_DESCRIPTIONS, describeStrategy, SOURCE_KIND_LABEL, channelOptionLabel } from '../lib/labels';
import type { Strategy } from '../api/types';
```

Add one line below the `Icon` import:

```tsx
import { SchedulePicker } from './SchedulePicker';
```

- [ ] **Step 2: Delete the local COMMON_SCHEDULES constant**

In the same file, the constant block (lines 16–23) is:

```tsx
const COMMON_SCHEDULES: Array<{ label: string; expr: string }> = [
  { label: 'Every hour (top of hour)', expr: '0 * * * *' },
  { label: 'Every 30 minutes',         expr: '*/30 * * * *' },
  { label: 'Daily at 09:00',           expr: '0 9 * * *' },
  { label: 'Daily at 18:00',           expr: '0 18 * * *' },
  { label: 'Weekdays at 09:00',        expr: '0 9 * * 1-5' },
  { label: 'Every 4 hours',            expr: '0 */4 * * *' },
];
```

Delete this whole block.

- [ ] **Step 3: Replace the inline schedule field markup with SchedulePicker**

Find the `<Field label="Schedule (cron)">` block (around lines 129–149). Currently:

```tsx
<Field label="Schedule (cron)">
  <input
    value={schedule}
    onChange={e => setSchedule(e.target.value)}
    className="input-field"
    style={{ width: '100%', fontVariantNumeric: 'tabular-nums' }}
  />
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
    {COMMON_SCHEDULES.map(s => (
      <button
        key={s.expr}
        type="button"
        onClick={() => setSchedule(s.expr)}
        className={schedule === s.expr ? 'chip is-active' : 'chip'}
        style={{ cursor: 'pointer', border: 'none' }}
      >
        {s.label}
      </button>
    ))}
  </div>
</Field>
```

Replace the whole body of the `<Field>` with:

```tsx
<Field label="Schedule (cron)">
  <SchedulePicker value={schedule} onChange={setSchedule} />
</Field>
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter dashboard exec tsc --noEmit`
Expected: passes.

- [ ] **Step 5: Manual sanity check**

Run the dashboard locally and confirm the strategies page → Edit modal still shows the cron input and the six preset chips, and clicking a chip still fills the input. Cost-safe — read-only check, no Save click required.

```bash
pnpm --filter dashboard dev
# then open http://localhost:5173/strategies → click any strategy → verify Schedule field still works
```

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/components/EditStrategyModal.tsx
git commit -m "$(cat <<'EOF'
refactor(dashboard): EditStrategyModal uses SchedulePicker

Drops the duplicated cron input + preset chip markup. Behaviour is
unchanged; the picker is now the single source of truth for both this
modal and the upcoming inline editor.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: InlineScheduleEditor component

**Files:**
- Create: `apps/dashboard/src/components/InlineScheduleEditor.tsx`

A small click-to-expand cell. Collapsed state shows the cron expression + a pencil affordance on hover. Expanded state shows `<SchedulePicker>` plus Save/Cancel buttons and an inline error line for failed PATCHes. Parent owns the "which row is editing" id so only one cell can be open at a time.

- [ ] **Step 1: Create the file**

Write `apps/dashboard/src/components/InlineScheduleEditor.tsx`:

```tsx
// apps/dashboard/src/components/InlineScheduleEditor.tsx
//
// Click-to-edit schedule cell for the Publishing-strategies panel on the
// channel detail page. Parent owns the editing-id so only one row can be
// expanded at a time. Save patches just { schedule }; the scheduler
// hot-reloads via config:changed on the backend and React Query's
// invalidation on ['strategies'] refreshes the cell to its new value.

import { useEffect, useState } from 'react';
import { usePatchStrategy } from '../api/strategies';
import { SchedulePicker } from './SchedulePicker';
import { Icon } from './Icon';

interface Props {
  strategyId: string;
  current:    string;
  isEditing:  boolean;
  onStartEdit: () => void;
  onDone:      () => void;
}

export function InlineScheduleEditor({
  strategyId, current, isEditing, onStartEdit, onDone,
}: Props) {
  const [draft, setDraft] = useState(current);
  const patch = usePatchStrategy();

  // When parent toggles us into edit mode, reset the draft to the live
  // value. When parent flips us out (because another row was opened), drop
  // any local mutation error state so reopening starts clean.
  useEffect(() => {
    if (isEditing) {
      setDraft(current);
      patch.reset();
    }
  }, [isEditing, current]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isEditing) {
    return (
      <button
        type="button"
        onClick={onStartEdit}
        title="Click to edit schedule"
        className="inline-edit-trigger"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          background: 'transparent',
          border: 'none',
          padding: '2px 6px',
          margin: '-2px -6px', // negate padding so the cell metrics don't jump
          borderRadius: 'var(--radius-sm)',
          color: 'var(--color-ink-muted)',
          fontVariantNumeric: 'tabular-nums',
          cursor: 'pointer',
        }}
      >
        <span>{current}</span>
        <Icon name="edit" size={11} style={{ opacity: 0.5 }} />
      </button>
    );
  }

  const trimmed = draft.trim();
  const dirty   = trimmed !== current && trimmed.length > 0;

  const save = async () => {
    if (!dirty) return;
    try {
      await patch.mutateAsync({ id: strategyId, patch: { schedule: trimmed } });
      onDone();
    } catch {
      // error rendered inline below; stay open so the user can fix it.
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 280 }}>
      <SchedulePicker value={draft} onChange={setDraft} compact disabled={patch.isPending} />
      {patch.error && (
        <p className="text-micro" style={{ color: 'var(--color-danger)', margin: 0 }}>
          {(patch.error as Error).message}
        </p>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        <button
          type="button"
          className="btn-secondary"
          onClick={onDone}
          disabled={patch.isPending}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={save}
          disabled={!dirty || patch.isPending}
        >
          {patch.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify the `edit` icon exists**

Run: `grep -n "edit" apps/dashboard/src/components/Icon.tsx`
Expected: an entry mapping the `edit` name to a lucide icon (the codebase already uses `Icon name="edit"` elsewhere — see channel and strategy rows). If it doesn't exist, replace `<Icon name="edit" ...>` in the file above with `<Icon name="pencil" ... />`. If neither exists, drop the icon and keep just the text — the click-to-edit affordance can rely on hover/cursor alone.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter dashboard exec tsc --noEmit`
Expected: passes. (The component is unused at this point — TS will accept it as long as the imports resolve.)

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/components/InlineScheduleEditor.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): InlineScheduleEditor click-to-edit cell

Self-contained cell that toggles between a read-only cron display and a
SchedulePicker with Save/Cancel. Uses the existing usePatchStrategy
mutation so the backend path is unchanged. Parent component owns the
editing-id so only one cell can be open at a time.

Unused at this commit; wired into channel detail next.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Wire InlineScheduleEditor into the channel page

**Files:**
- Modify: `apps/dashboard/src/routes/channels_.$id.tsx`

`StrategiesPanel` becomes a stateful component holding the currently-editing strategy id. `StrategyTableRow` accepts the edit-state props and renders `<InlineScheduleEditor>` for primary rows and a `(forwarded — edit on source)` caption for forward rows.

- [ ] **Step 1: Add the import**

In `apps/dashboard/src/routes/channels_.$id.tsx`, add to the existing import block near the top:

```tsx
import { InlineScheduleEditor } from '../components/InlineScheduleEditor';
```

Place it next to other component imports.

- [ ] **Step 2: Make StrategiesPanel hold edit state**

Find the existing `StrategiesPanel` function (around lines 280–314). Replace it with:

```tsx
function StrategiesPanel({
  primary, forwards, isLoading,
}: { primary: Strategy[]; forwards: Strategy[]; isLoading: boolean }) {
  // One row open at a time. null = none. Parent state lives here so opening
  // row B implicitly closes row A.
  const [editingId, setEditingId] = useState<string | null>(null);

  if (isLoading) {
    return <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Loading…</p>;
  }
  const total = primary.length + forwards.length;
  if (total === 0) {
    return (
      <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)', margin: 0 }}>
        No strategies publish to this channel. <Link to="/strategies" className="link-accent">Add one</Link>.
      </p>
    );
  }
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Strategy</th>
            <th>Type</th>
            <th>Schedule</th>
            <th>Next run</th>
            <th>Last run</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {primary.map(s => (
            <StrategyTableRow
              key={s.id}
              s={s}
              role="primary"
              isEditing={editingId === s.id}
              onStartEdit={() => setEditingId(s.id)}
              onDone={() => setEditingId(null)}
            />
          ))}
          {forwards.map(s => (
            <StrategyTableRow
              key={s.id}
              s={s}
              role="forward"
              isEditing={false}
              onStartEdit={() => {}}
              onDone={() => {}}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

Make sure `useState` is in the React import at the top of the file; it should already be there (the route component already uses hooks). If not, add it to the existing `import { … } from 'react'` line.

- [ ] **Step 3: Update StrategyTableRow signature and schedule cell**

Find the existing `StrategyTableRow` function (around lines 316–365). Replace it with:

```tsx
function StrategyTableRow({
  s, role, isEditing, onStartEdit, onDone,
}: {
  s: Strategy;
  role: 'primary' | 'forward';
  isEditing: boolean;
  onStartEdit: () => void;
  onDone: () => void;
}) {
  const meta = describeStrategy(s.type);
  const typeTooltip = meta
    ? `${meta.title} (${SOURCE_KIND_LABEL[meta.source]})\n\n${meta.description}`
    : s.type;
  return (
    <tr>
      <td>
        <Link to="/strategies" className="link-accent" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {s.ext_id}
        </Link>
        {role === 'forward' && (
          <span className="chip" style={{ marginLeft: 8 }} title={STRATEGY_ROLE_HELP.forward}>↩ forward</span>
        )}
      </td>
      <td><span className="chip" title={typeTooltip}>{s.type}</span></td>
      <td style={{ color: 'var(--color-ink-muted)', fontVariantNumeric: 'tabular-nums' }}>
        {role === 'primary' ? (
          <InlineScheduleEditor
            strategyId={s.id}
            current={s.schedule}
            isEditing={isEditing}
            onStartEdit={onStartEdit}
            onDone={onDone}
          />
        ) : (
          <span title="Cron schedule. Inherited from a forward route — edit it from the source channel's strategy on /strategies.">
            {s.schedule}
            <span className="text-micro" style={{ marginLeft: 6, color: 'var(--color-ink-dim)' }}>
              (forwarded — edit on source)
            </span>
          </span>
        )}
      </td>
      <td>
        {s.enabled && s.next_run_at
          ? <span className="text-body-sm" style={{ color: 'var(--color-ink)', fontVariantNumeric: 'tabular-nums' }} title={new Date(s.next_run_at).toLocaleString()}>
              {formatRelativeFuture(s.next_run_at)}
            </span>
          : <span className="text-body-sm" style={{ color: 'var(--color-ink-dim)' }}>—</span>}
      </td>
      <td>
        {s.last_run ? (
          <span
            className={
              s.last_run.status === 'ok'    ? 'chip chip-success'
            : s.last_run.status === 'error' ? 'chip chip-danger'
            : s.last_run.status === 'skipped' ? 'chip chip-warning'
            : 'chip'
            }
            title={
              (RUN_STATUS_HELP[s.last_run.status] ?? s.last_run.status)
              + (s.last_run.error ? `\n\n${s.last_run.error}` : '')
            }
          >
            {s.last_run.status}
          </span>
        ) : <span className="text-body-sm" style={{ color: 'var(--color-ink-dim)' }} title="No execution recorded yet.">never</span>}
      </td>
      <td>
        {s.enabled
          ? <span className="chip chip-success" title={STRATEGY_STATUS_HELP.enabled}><Icon name="check" size={12} style={{ marginRight: 4 }} />enabled</span>
          : <span className="chip" title={STRATEGY_STATUS_HELP.paused}>paused</span>}
      </td>
    </tr>
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter dashboard exec tsc --noEmit`
Expected: passes.

- [ ] **Step 5: Production build**

Run: `pnpm --filter dashboard build`
Expected: build succeeds. Vite must not warn about unused imports of the deleted `COMMON_SCHEDULES`.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/routes/channels_.\$id.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): inline schedule edit on channel page

Primary-strategy rows in the Publishing strategies panel now expose
click-to-edit on the cron cell. Forward-bound rows stay read-only with
a "(forwarded — edit on source)" caption — they're owned by the source
channel and editing them here would surprise users by re-timing the
post on every other forward target.

No schema or backend changes; reuses the existing PATCH /strategies/:id
endpoint and the config:changed hot-reload that already drives the
scheduler.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Manual end-to-end smoke

This is dev-only, cost-safe. Local strategies are already disabled per the project's cost-safety constraint, so no Telegram publishes or Claude API calls fire even on Save.

- [ ] **Step 1: Start the dashboard + automation locally**

```bash
# in two terminals
pnpm --filter automation start:dev
pnpm --filter dashboard dev
```

- [ ] **Step 2: Open a channel detail page**

Navigate: `http://localhost:5173/channels/<id-of-motivation-local>`

The id can be looked up with:

```bash
docker exec ai0_global-postgres-1 psql -U ai0 -d ai0global -c \
  "SELECT id, channel_key FROM tracked_channels WHERE is_mine = true ORDER BY channel_key"
```

- [ ] **Step 3: Verify collapsed state**

Confirm: in the "Publishing strategies" panel, each primary row's Schedule cell shows the cron expression plus a small edit pencil. Hovering the cell shows a tooltip "Click to edit schedule" and changes cursor to pointer.

- [ ] **Step 4: Verify expand → cancel**

Click a primary row's schedule cell. The cell expands to show the input + the six preset chips + Save/Cancel. Click "Cancel". The cell collapses back to the original value.

- [ ] **Step 5: Verify preset → save**

Click the schedule cell again. Click a different preset (e.g. "Every 30 minutes"). Save becomes enabled. Click Save. The cell collapses; the new cron is visible. Open `/strategies` in a new tab and confirm the same binding shows the new cron.

- [ ] **Step 6: Verify single-row-open invariant**

Click row A's schedule cell. Click row B's schedule cell. Row A collapses; only row B is expanded.

- [ ] **Step 7: Verify forward row read-only**

If a forward-bound strategy is bound to this channel (look for the `↩ forward` chip on the Strategy column), confirm its schedule cell shows the cron + "(forwarded — edit on source)" caption and is **not** clickable.

If no forward route exists for this channel, you can create one quickly:

```bash
# pick any two channel ids from the SELECT above
docker exec ai0_global-postgres-1 psql -U ai0 -d ai0global -c \
  "INSERT INTO forward_routes (source_channel_id, target_channel_id, topic, description) VALUES ('<src>', '<tgt>', 'test', 'tmp');"
```

Refresh and verify. Clean up afterwards:

```bash
docker exec ai0_global-postgres-1 psql -U ai0 -d ai0global -c \
  "DELETE FROM forward_routes WHERE topic = 'test' AND description = 'tmp';"
```

- [ ] **Step 8: Verify backend hot-reload**

Tail the automation logs while saving a schedule change:

```bash
# in a third terminal
pnpm --filter automation start:dev 2>&1 | grep -i 'config:changed\|Reconcile\|Scheduled '
```

Expected log lines on Save: a `config:changed` notification followed by a `Reconciled scheduler:` log line and a `Scheduled "<binding-name>": <new-cron>` line.

- [ ] **Step 9: Verify invalid cron is rejected with inline error**

Click schedule cell on a primary row. Type `not a cron`. Click Save. The editor stays open, the red error line appears under the picker showing the backend's rejection message. Cancel to restore original value.

- [ ] **Step 10: Push the branch**

```bash
git push -u origin feat/config-in-db
```

(If the user wants a PR opened, do `gh pr create` per the standard repo workflow — but only on explicit request.)

---

## Self-review

**Spec coverage:**
- "Click cron cell → expand inline" → Task 3 + Task 4 step 3 ✅
- "Preset chips one-click fill" → Task 1 ✅
- "Save disabled if expression unchanged" → Task 3 step 1 `dirty` flag ✅
- "Inline error on save failure" → Task 3 step 1 + Task 5 step 9 ✅
- "One row at a time" → Task 4 step 2 (parent owns editingId) + Task 5 step 6 ✅
- "Forward rows stay read-only with caption" → Task 4 step 3 ✅
- "Reuse existing PATCH /strategies/:id" → Task 3 step 1 (usePatchStrategy) ✅
- "Extract COMMON_SCHEDULES into shared module" → Task 1 + Task 2 ✅
- "No backend / migration / endpoint" → enforced by file map ✅
- "Manual smoke instead of new unit tests" → Task 5 covers each spec checkpoint ✅

**Placeholder scan:** no TBDs / TODOs / "as appropriate" phrases. All code blocks are complete.

**Type consistency:** the `InlineScheduleEditor` props (`strategyId`, `current`, `isEditing`, `onStartEdit`, `onDone`) match exactly between Task 3 (component definition) and Task 4 (call site). The `SchedulePicker` props (`value`, `onChange`, `disabled`, `compact`, `inputId`) match between Task 1 (definition) and both call sites (Task 2 in modal — uses `value`/`onChange` only; Task 3 in inline editor — uses `value`/`onChange`/`compact`/`disabled`). `COMMON_SCHEDULES` is exported from Task 1 and re-import isn't needed in Task 2 (the modal no longer references it).
