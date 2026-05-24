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
  strategyId:  string;
  current:     string;
  isEditing:   boolean;
  onStartEdit: () => void;
  onDone:      () => void;
}

export function InlineScheduleEditor({
  strategyId, current, isEditing, onStartEdit, onDone,
}: Props) {
  const [draft, setDraft] = useState(current);
  const patch = usePatchStrategy();

  // Reset only on isEditing transitions, never on `current` updates:
  //   - background refetch ticks (useStrategies has a 30s refetchInterval)
  //     can change `current` mid-edit — re-running the effect on that change
  //     would wipe the user's in-progress draft, so `current` is deliberately
  //     omitted from the dep array.
  //   - on each open/close, draft re-syncs to the latest `current` snapshot
  //     and any prior mutation error is cleared.
  // `patch` is a stable object reference from useMutation; omitting it is
  // well-known for TanStack Query v5.
  useEffect(() => {
    setDraft(current);
    patch.reset();
  }, [isEditing]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!isEditing) {
    return (
      <button
        type="button"
        onClick={onStartEdit}
        title={`Click to edit schedule (UTC unless TZ is configured) — current: ${current}`}
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
        <Icon name="pencil" size={11} style={{ opacity: 0.5 }} />
      </button>
    );
  }

  const trimmed = draft.trim();
  const dirty   = trimmed !== current.trim() && trimmed.length > 0;

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
