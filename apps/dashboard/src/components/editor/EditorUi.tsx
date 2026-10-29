// Shared bits of the editor-agent pages (/app/editor*, spec 006): status tones,
// the off/shadow/approve/live switch (live behind a confirmation), slot rows and small
// formatters. Imported by the agent pages and by node tests too, so no CSS file is imported here: everything below
// styles itself with the global classes of index.css (spec 078).

import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { AutonomyDialog } from '../approvals/AutonomyDialog';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { StatusMark } from '../ui/StatusMark';
import { TableAction, RowActions } from '../ui/table';
import { SegmentedTabs } from '../SegmentedTabs';
import { useConfirm } from '../ui/ConfirmDialog';
import { useRunSlot, useSetEditorMode, useSkipSlot } from '../../api/editor';
import type { Tone } from '../ui/primitives';
import type { EditorMode, EditorRunStatus, EditorSlot, EditorSlotStatus } from '../../api/types';
import { formatIn, zoneLabel } from '../../lib/zoned-time';
import { SLOT_TONE, slotLabel, slotMark, slotTone, type MissCandidate } from '../../lib/status-tone';
import { PREVIEW_STATUS_LABEL } from '../../lib/slot-plan';
import { CriticBadge, PreviewButton, SlotDescription, type SlotPlanView } from './SlotPlan';

/**
 * Badge tone of a mode. Warning is the colour of the human (spec 078 D2): a post in approval waits for the owner.
 * Shadow writes nothing real, so it is as quiet as off.
 */
export const MODE_TONE: Record<EditorMode, Tone> = { off: 'neutral', shadow: 'neutral', approve: 'warning', live: 'success' };

/** Owner-facing mode names (spec 031: the approve mode reads "In approval"). */
export const MODE_LABEL: Record<EditorMode, string> = { off: 'Off', shadow: 'Shadow', approve: 'In approval', live: 'Live' };

// The slot status map is lib/status-tone.ts (one map for every page); kept exported from here for its importers.
export { SLOT_TONE };

export const RUN_TONE: Record<EditorRunStatus, Tone> = {
  running: 'warning', ok: 'success', error: 'danger', budget_exceeded: 'danger', max_steps: 'warning', disabled: 'neutral', no_terminal: 'warning',
};

/** "budget_exceeded" -> "budget exceeded": the owner-facing text of a run status. */
export const runStatusLabel = (status: string) => status.replace(/_/g, ' ');

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

/** Slot counts of the day as compact status badges ("5 published"). */
export function SlotCounts({ slots }: { slots: Partial<Record<EditorSlotStatus, number>> }) {
  const present = SLOT_ORDER.filter((s) => (slots[s] ?? 0) > 0);
  if (!present.length) return <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>no plan yet</span>;
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      {present.map((s) => <Badge key={s} tone={slotTone(s)}>{slots[s]} {slotLabel(s).toLowerCase()}</Badge>)}
    </span>
  );
}

/**
 * The status of one slot, from the one status map: its mark (the shape tells green statuses apart) and a Badge with the
 * label. A series or pinned slot that did not go out for no good reason reads "Missed" (amber), not "Skipped".
 */
export function SlotStatus({ slot, mark = true }: { slot: MissCandidate; mark?: boolean }) {
  const kind = slotMark(slot);
  const missed = kind === 'missed';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {mark && <StatusMark status={kind} decorative />}
      <Badge tone={missed ? 'warning' : slotTone(slot.status)}>{missed ? 'Missed' : slotLabel(slot.status)}</Badge>
    </span>
  );
}

/** Mode tabs: the selected one is filled with its mode colour (off / shadow neutral, approve warning, live green). */
export const MODE_OPTIONS = [
  { key: 'off' as const,     label: MODE_LABEL.off,     tone: 'neutral' as const },
  { key: 'shadow' as const,  label: MODE_LABEL.shadow,  tone: 'neutral' as const },
  { key: 'approve' as const, label: MODE_LABEL.approve, tone: 'warning' as const },
  { key: 'live' as const,    label: MODE_LABEL.live,    tone: 'accent' as const },
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
      <SegmentedTabs size="sm" value={mode} onChange={onChange} options={MODE_OPTIONS} ariaLabel={`Mode of ${title || channelKey}`} />
      {goLive && <AutonomyDialog channel={channelKey} title={title} onClose={() => setGoLive(false)} />}
    </>
  );
}

/** The plan views' slot shape from an /api/editor slot (spec 034 FR-012). */
export function slotView(slot: EditorSlot): SlotPlanView {
  return {
    id: slot.id, at: slot.scheduledAt, format: slot.format, topic: slot.topic, status: slot.status, kind: slot.kind, error: slot.error,
    topicMode: slot.topicMode ?? 'fixed', liveSpec: slot.liveSpec ?? null, treatment: slot.treatment ?? null, previewDraft: slot.previewDraft ?? null,
    angle: slot.angle, sourceHints: slot.sourceHints, seriesName: slot.seriesName ?? null, pinned: !!slot.scheduleRuleId,
    isExperiment: slot.isExperiment, critic: slot.critic ?? null, preview: slot.renderedPreview,
  };
}

/**
 * One slot as a row of a flush panel (`<SectionCard flush>`): time (the channel's zone when given), status mark and
 * badge, format, topic; what the slot will do (live call or fixed details, skip reason — spec 034 FR-012); the critic's
 * verdict; a dry-run Preview of a fixed planned slot; run / skip while planned. The panel animates, not its rows, so
 * `delay` is accepted for the existing callers and ignored.
 */
export function SlotRow({ slot, showChannel = false, tz, feeds, estimateUsd }: {
  slot: EditorSlot; showChannel?: boolean; delay?: number; tz?: string; feeds?: Record<string, string>; estimateUsd?: number | null;
}) {
  const confirm = useConfirm();
  const run = useRunSlot();
  const skip = useSkipSlot();
  const busy = run.isPending || skip.isPending;
  const planned = slot.status === 'planned' && slot.kind === 'content';
  const view = slotView(slot);
  const zone = tz ?? 'Europe/Kyiv';
  const draft = slot.previewDraft;
  // Skip / failure reasons are explained by SlotDescription; other notes (a retry) stay a plain line.
  const note = slot.error && slot.status !== 'skipped' && slot.status !== 'failed' && slot.status !== 'expired' ? slot.error : null;

  return (
    <div className="panel-row" style={{ alignItems: 'flex-start' }}>
      <div className="mono tabular-nums text-caption" style={{ width: 48, flexShrink: 0, fontWeight: 600, marginTop: 2 }}
        title={tz ? `${zoneLabel(zone)} time` : undefined}>
        {tz ? formatIn(slot.scheduledAt, zone) : fmtTime(slot.scheduledAt)}
      </div>
      <div style={{ minWidth: 0, flex: '1 1 240px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
          <SlotStatus slot={slot} />
          <span className="chip">{slot.format}</span>
          {slot.kind === 'reserved' && <span className="chip">reserved</span>}
          {slot.isExperiment && <span className="chip">experiment</span>}
          <CriticBadge critic={slot.critic} />
          {showChannel && <span className="mono text-micro" style={{ color: 'var(--color-ink-muted)' }}>{slot.channelKey}</span>}
        </div>
        <Link
          to="/app/editor/slot/$id"
          params={{ id: slot.id }}
          className="text-body-sm clamp"
          style={{ ['--clamp' as string]: 1, color: 'var(--color-ink)', textDecoration: 'none' }}
        >
          {slot.topic}
        </Link>
        <div style={{ marginTop: 3 }}><SlotDescription slot={view} tz={zone} feeds={feeds} compact /></div>
        {note && <div className="text-micro" style={{ color: 'var(--color-ink-dim)', marginTop: 3 }}>{note}</div>}
        {planned && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
            <PreviewButton slot={view} estimateUsd={estimateUsd} />
            {draft && draft.status !== 'running' && (
              <Link to="/app/editor/slot/$id" params={{ id: slot.id }} className="link-accent text-micro">{PREVIEW_STATUS_LABEL[draft.status]} →</Link>
            )}
          </div>
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
    <pre className="code-block" style={{ maxHeight, overflow: 'auto' }}>
      {value === undefined || value === null ? '—' : JSON.stringify(value, null, 2)}
    </pre>
  );
}
