// Shared bits of the editor-agent pages (/app/editor*, spec 006): status tones,
// the off/shadow/approve/live switch (live behind a confirmation), slot rows and small
// formatters.

import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { AutonomyDialog } from '../approvals/AutonomyDialog';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { TableAction, RowActions } from '../ui/table';
import { SegmentedTabs } from '../SegmentedTabs';
import { useConfirm } from '../ui/ConfirmDialog';
import { useRunSlot, useSetEditorMode, useSkipSlot } from '../../api/editor';
import type { Tone } from '../ui/primitives';
import type { EditorMode, EditorRunStatus, EditorSlot, EditorSlotStatus } from '../../api/types';

export const MODE_TONE: Record<EditorMode, Tone> = { off: 'neutral', shadow: 'warning', approve: 'accent', live: 'success' };

/** Owner-facing mode names (spec 031: the approve mode reads "In approval"). */
export const MODE_LABEL: Record<EditorMode, string> = { off: 'Off', shadow: 'Shadow', approve: 'In approval', live: 'Live' };

export const SLOT_TONE: Record<EditorSlotStatus, Tone> = {
  planned: 'neutral', running: 'warning', shadowed: 'accent', published: 'success', skipped: 'neutral', failed: 'danger',
  awaiting_approval: 'warning', approved: 'accent', expired: 'neutral',
};

export const RUN_TONE: Record<EditorRunStatus, Tone> = {
  running: 'warning', ok: 'success', error: 'danger', budget_exceeded: 'danger', max_steps: 'warning', disabled: 'neutral',
};

export const SLOT_ORDER: EditorSlotStatus[] = ['planned', 'running', 'awaiting_approval', 'approved', 'shadowed', 'published', 'skipped', 'expired', 'failed'];

export const fmtUsd = (n: number | null | undefined) =>
  n == null ? '—' : `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(n < 10 ? 3 : 2)}`;

export const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

export const fmtDuration = (from: string, to: string | null) => {
  if (!to) return '—';
  const s = Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

/** Slot counts of the day as compact status badges. */
export function SlotCounts({ slots }: { slots: Partial<Record<EditorSlotStatus, number>> }) {
  const present = SLOT_ORDER.filter((s) => (slots[s] ?? 0) > 0);
  if (!present.length) return <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>no plan yet</span>;
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      {present.map((s) => <Badge key={s} tone={SLOT_TONE[s]}>{slots[s]} {s}</Badge>)}
    </span>
  );
}

export const MODE_OPTIONS = [
  { key: 'off' as const,     label: MODE_LABEL.off },
  { key: 'shadow' as const,  label: MODE_LABEL.shadow },
  { key: 'approve' as const, label: MODE_LABEL.approve },
  { key: 'live' as const,    label: MODE_LABEL.live },
];

/**
 * off / shadow / approve / live switch. Going live publishes to the real channel
 * (and every resource of its network) without the owner's approval, so it goes
 * through the autonomy dialog (spec 031 FR-010: 14 days of decisions and the
 * waiting posts). live → approve and the other moves are one click.
 */
export function ModeSwitch({ channelKey, mode, title }: { channelKey: string; mode: EditorMode; title?: string | null }) {
  const setMode = useSetEditorMode();
  const [goLive, setGoLive] = useState(false);

  const onChange = async (next: EditorMode) => {
    if (next === mode || setMode.isPending) return;
    if (next === 'live') { setGoLive(true); return; }
    setMode.mutate({ key: channelKey, mode: next });
  };

  return (
    <>
      <SegmentedTabs size="sm" value={mode} onChange={onChange} options={MODE_OPTIONS} />
      {goLive && <AutonomyDialog channel={channelKey} title={title} onClose={() => setGoLive(false)} />}
    </>
  );
}

/** One slot as a card-row: time, channel, format, topic, status; run/skip while planned. */
export function SlotRow({ slot, showChannel = false, delay = 0 }: { slot: EditorSlot; showChannel?: boolean; delay?: number }) {
  const confirm = useConfirm();
  const run = useRunSlot();
  const skip = useSkipSlot();
  const busy = run.isPending || skip.isPending;
  const planned = slot.status === 'planned' && slot.kind === 'content';

  return (
    <div className="card row-lift compose-rise" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '11px 16px', animationDelay: `${delay}ms` }}>
      <div className="tabular-nums" style={{ width: 52, flexShrink: 0, fontWeight: 600, color: 'var(--color-ink)' }}>{fmtTime(slot.scheduledAt)}</div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 3 }}>
          <Badge tone={SLOT_TONE[slot.status]}>{slot.status}</Badge>
          <span className="chip">{slot.format}</span>
          {slot.kind === 'reserved' && <span className="chip">reserved</span>}
          {slot.isExperiment && <span className="chip">experiment</span>}
          {showChannel && <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>{slot.channelKey}</span>}
        </div>
        <Link
          to="/app/editor/slot/$id"
          params={{ id: slot.id }}
          className="text-body-sm"
          style={{ color: 'var(--color-ink)', textDecoration: 'none', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {slot.topic}
        </Link>
        {slot.error && (
          <div className="text-micro" style={{ color: slot.status === 'failed' ? 'var(--color-danger)' : 'var(--color-ink-dim)', marginTop: 3 }}>{slot.error}</div>
        )}
      </div>
      <RowActions
        danger={planned ? (
          <TableAction
            icon="skip-forward"
            danger
            title="Skip slot"
            disabled={busy}
            onClick={async () => { if (await confirm(`skip the ${fmtTime(slot.scheduledAt)} slot "${slot.topic}"`, { confirmLabel: 'Skip' })) skip.mutate({ id: slot.id }); }}
          />
        ) : undefined}
      >
        {planned && (
          <TableAction
            icon="rocket"
            title="Run now (all publish guards apply)"
            disabled={busy}
            onClick={async () => {
              if (await confirm(`run the slot "${slot.topic}" now`, { danger: false, confirmLabel: 'Run now', details: (
                <p className="text-micro" style={{ margin: 0, color: 'var(--color-ink-muted)' }}>
                  The executor runs immediately with the normal tools and guards. In shadow mode it only stores a preview; in live mode it may publish.
                </p>
              ) })) run.mutate(slot.id);
            }}
          />
        )}
        <Link to="/app/editor/slot/$id" params={{ id: slot.id }} className="btn-act" title="Open slot" aria-label="Open slot">
          <Icon name="eye" size={14} />
        </Link>
      </RowActions>
    </div>
  );
}

/** Pretty-printed JSON in a scrollable block. */
export function JsonBlock({ value, maxHeight = 360 }: { value: unknown; maxHeight?: number }) {
  return (
    <pre
      className="text-micro"
      style={{
        margin: 0, padding: 12, maxHeight, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        background: 'var(--color-canvas)', border: '1px solid var(--color-hairline)', borderRadius: 'var(--radius-sm)',
        color: 'var(--color-ink-muted)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      }}
    >
      {value === undefined || value === null ? '—' : JSON.stringify(value, null, 2)}
    </pre>
  );
}
