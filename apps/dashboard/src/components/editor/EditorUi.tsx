// Shared bits of the editor-agent pages (/app/editor*, spec 006): status tones,
// the off/shadow/live switch (live behind a confirmation), slot rows and small
// formatters.

import { Link } from '@tanstack/react-router';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { TableAction, RowActions } from '../ui/table';
import { SegmentedTabs } from '../SegmentedTabs';
import { useConfirm } from '../ui/ConfirmDialog';
import { useRunSlot, useSetEditorMode, useSkipSlot } from '../../api/editor';
import type { Tone } from '../ui/primitives';
import type { EditorMode, EditorRunStatus, EditorSlot, EditorSlotStatus } from '../../api/types';

export const MODE_TONE: Record<EditorMode, Tone> = { off: 'neutral', shadow: 'warning', live: 'success' };

export const SLOT_TONE: Record<EditorSlotStatus, Tone> = {
  planned: 'neutral', running: 'warning', shadowed: 'accent', published: 'success', skipped: 'neutral', failed: 'danger',
};

export const RUN_TONE: Record<EditorRunStatus, Tone> = {
  running: 'warning', ok: 'success', error: 'danger', budget_exceeded: 'danger', max_steps: 'warning', disabled: 'neutral',
};

export const SLOT_ORDER: EditorSlotStatus[] = ['planned', 'running', 'shadowed', 'published', 'skipped', 'failed'];

export const fmtUsd = (n: number | null | undefined) =>
  n == null ? '—' : `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(n < 10 ? 3 : 2)}`;

export const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

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

const MODE_OPTIONS = [
  { key: 'off' as const,    label: 'Off' },
  { key: 'shadow' as const, label: 'Shadow' },
  { key: 'live' as const,   label: 'Live' },
];

/**
 * off / shadow / live switch. Going live publishes to the real channel, so it
 * needs an explicit confirmation with the go-live checklist (runbook §3).
 */
export function ModeSwitch({ channelKey, mode }: { channelKey: string; mode: EditorMode }) {
  const confirm = useConfirm();
  const setMode = useSetEditorMode();

  const onChange = async (next: EditorMode) => {
    if (next === mode || setMode.isPending) return;
    if (next === 'live') {
      const ok = await confirm(`switch ${channelKey} to LIVE`, {
        danger: true,
        confirmLabel: 'Go live',
        details: (
          <div className="callout-warning" style={{ flexDirection: 'column', gap: 6 }}>
            <strong>The editor will publish to the real channel.</strong>
            <span className="text-micro">Checklist: ≥ 7 days in shadow, ≥ 80% of slots shadowed (not failed), previews read well,
              spend under the cap, and no legacy strategy still posting to this channel.</span>
          </div>
        ),
      });
      if (!ok) return;
    }
    setMode.mutate({ key: channelKey, mode: next });
  };

  return <SegmentedTabs size="sm" value={mode} onChange={onChange} options={MODE_OPTIONS} />;
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
