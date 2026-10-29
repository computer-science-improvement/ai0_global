// Spec 034 FR-012 / FR-013: the readable plan, shared by the agent's Plan and
// Schedule tabs, /app/editor, the channel page and the slot page —
// - what a slot will do: a live slot's scheduled tool call ("At 14:00: fetch
//   pravda.com.ua → pick the freshest item (≤ 6 h) → write photo"), the item a
//   news-watch slot picked, a fixed slot's angle / series / source hints, and why
//   a slot was skipped;
// - the post once written (or the owner's dry-run Preview) with the critic's verdict;
// - the Preview button (cost hint, spinner, one at a time per slot);
// - "Planned at 06:02 by planner run →", the approval note and the day's earlier plans.

import { Link } from '@tanstack/react-router';
import { useMemo, useState, type ReactNode } from 'react';
import { Modal } from '../Modal';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { CriticBlock } from '../critic/CriticBlock';
import { verdictBadge, type CriticVerdict } from '../../lib/critic';
import { sanitizeTelegramHtml } from '../../lib/tg-html';
import { formatIn, zoneLabel } from '../../lib/zoned-time';
import {
  canPreview, isLive, liveLine, LIVE_ORIGIN_LABEL, plannedAtLine, plannedEveningBefore, planScheduleNote, previewCostHint, previewFootnote,
  previewRunning, PREVIEW_STATUS_LABEL, runLabel, skipReason, type PlanSlotLike, type SlotPreviewView,
} from '../../lib/slot-plan';
import { usePreviewSlot } from '../../api/editor';

export interface SlotPlanView extends PlanSlotLike {
  id:           string;
  angle?:       string | null;
  sourceHints?: string[];
  seriesName?:  string | null;
  pinned?:      boolean;
  isExperiment?: boolean;
  critic?:      CriticVerdict | null;
  /** The written post (rendered HTML / caption). */
  preview?:     string | null;
}

/**
 * What the slot will do (or why it did not): the live call or the fixed details, plus the skip reason.
 * `compact`: one or two muted lines for list rows.
 */
export function SlotDescription({ slot, tz, feeds, compact = false }: { slot: SlotPlanView; tz: string; feeds?: Record<string, string>; compact?: boolean }) {
  const live = isLive(slot);
  const item = slot.liveSpec?.item;
  const skip = slot.status === 'skipped' || slot.status === 'failed' || slot.status === 'expired' ? skipReason(slot.error) : null;
  const chips: ReactNode[] = [];
  if (!live && slot.seriesName) chips.push(<span key="series" className="chip" title="A recurring series from the playbook">series: {slot.seriesName}</span>);
  if (slot.pinned) chips.push(<span key="pin" className="chip" title="Your pinned post">pinned</span>);
  if (!live && slot.sourceHints?.length) chips.push(<span key="hints" className="chip" style={{ overflowWrap: 'anywhere' }} title="Where the planner suggests to look">sources: {slot.sourceHints.join(', ')}</span>);
  return (
    <div className="text-micro ink-muted" style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }} data-testid="slot-description">
      {live && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap', minWidth: 0 }}>
          <Badge tone="accent" title="The topic is picked at slot time from the freshest item">
            <Icon name="radar" size={10} /> {LIVE_ORIGIN_LABEL[slot.liveSpec!.origin] ?? 'live'}
          </Badge>
          <span className="plan-ink" style={{ overflowWrap: 'anywhere' }}>{liveLine(slot, tz, feeds)}</span>
        </div>
      )}
      {live && item && (
        <div style={{ overflowWrap: 'anywhere' }}>
          Picked: <a href={item.url} target="_blank" rel="noreferrer noopener" className="link-accent">{item.title || item.url} <Icon name="external" size={10} /></a>
        </div>
      )}
      {live && !compact && slot.liveSpec!.brief && <div style={{ overflowWrap: 'anywhere' }}>Brief: {slot.liveSpec!.brief}</div>}
      {!live && slot.angle && (
        <div style={compact ? { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } : { overflowWrap: 'anywhere' }} title={compact ? slot.angle : undefined}>
          Angle: {slot.angle}
        </div>
      )}
      {chips.length > 0 && <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{chips}</div>}
      {skip && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap', minWidth: 0 }}>
          <Badge tone={skip.code === 'critic_failed' || slot.status === 'failed' ? 'danger' : 'warning'}>{skip.label}</Badge>
          {skip.detail && <span style={{ overflowWrap: 'anywhere' }}>{skip.detail}</span>}
        </div>
      )}
    </div>
  );
}

/** The critic's verdict as one badge (list rows). */
export function CriticBadge({ critic }: { critic?: CriticVerdict | null }) {
  if (!critic) return null;
  const b = verdictBadge(critic);
  return <Badge tone={b.tone} title={critic.notes || undefined}>{b.label}</Badge>;
}

/** Preview of a fixed planned slot: cost hint, spinner while it runs, disabled while another runs for this slot. */
export function PreviewButton({ slot, estimateUsd, block = false }: { slot: SlotPlanView; estimateUsd?: number | null; block?: boolean }) {
  const preview = usePreviewSlot();
  if (!canPreview(slot)) return null;
  const running = previewRunning(slot.previewDraft) || (preview.isPending && preview.variables === slot.id);
  const hint = previewCostHint(estimateUsd);
  const again = !!slot.previewDraft && slot.previewDraft.status !== 'running';
  return (
    <button type="button" className="btn-tiny" disabled={running} aria-busy={running} data-testid="preview-button"
      title={`Dry run: the executor writes this post now with every check and the critic; nothing is published or stored for the slot. Cost ${hint}.`}
      style={{ gap: 6, ...(block ? { width: '100%' } : {}) }} onClick={() => preview.mutate(slot.id)}>
      {running ? <span className="spin-ring" aria-hidden /> : <Icon name="sparkles" size={12} />}
      {running ? 'Writing preview…' : again ? 'Preview again' : 'Preview'}
      {!running && <span className="tabular-nums plan-hint">{hint}</span>}
    </button>
  );
}

function PostBox({ html, plain, children }: { html: string; plain: boolean; children?: ReactNode }) {
  const safe = useMemo(() => sanitizeTelegramHtml(html), [html]);
  return (
    <div className="inset" style={{ padding: 14, maxWidth: 480, minWidth: 0 }}>
      {plain && <div className="text-micro ink-dim" style={{ marginBottom: 6 }}>rendered text</div>}
      <div className="text-body-sm plan-post"
        dangerouslySetInnerHTML={{ __html: safe }} />
      {children}
    </div>
  );
}

/** The owner's dry-run preview: the post and its critic verdict, or why there is none. */
export function PreviewDraft({ draft, tz, plain = false }: { draft: SlotPreviewView; tz: string; plain?: boolean }) {
  if (draft.status === 'running') {
    return (
      <div className="text-body-sm ink-muted" style={{ display: 'flex', gap: 8, alignItems: 'center' }} role="status">
        <span className="spin-ring" aria-hidden /> {PREVIEW_STATUS_LABEL.running} It usually takes under a minute.
      </div>
    );
  }
  const tone = draft.status === 'ready' ? 'accent' : draft.status === 'skipped' ? 'neutral' : 'warning';
  return (
    <div style={{ display: 'grid', gap: 8, minWidth: 0 }} data-testid="preview-draft">
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <Badge tone={tone}>{PREVIEW_STATUS_LABEL[draft.status]}</Badge>
        {draft.runId && (
          <Link to="/app/editor/run/$id" params={{ id: draft.runId }} className="link-accent text-micro">trace →</Link>
        )}
      </div>
      {draft.preview && <PostBox html={draft.preview} plain={plain || (draft.platform != null && draft.platform !== 'telegram')} />}
      {draft.reason && <div className="text-micro ink-muted" style={{ overflowWrap: 'anywhere' }}>{draft.reason}</div>}
      {draft.warnings.length > 0 && <div className="text-micro ink-dim" style={{ overflowWrap: 'anywhere' }}>Lint warnings: {draft.warnings.join(' · ')}</div>}
      {draft.critic && <CriticBlock critic={draft.critic} where="preview" />}
      <div className="text-micro ink-dim">{previewFootnote(draft, tz)}</div>
    </div>
  );
}

/**
 * The post section of a slot: the written post with the critic's verdict; for a planned fixed slot the
 * Preview button and the last dry-run preview; for a live slot a note that it is written at its time.
 */
export function SlotPost({ slot, tz, estimateUsd, plain = false, collapsible = false }: {
  slot: SlotPlanView; tz: string; estimateUsd?: number | null; plain?: boolean; collapsible?: boolean;
}) {
  const [open, setOpen] = useState(!collapsible);
  const written = !!slot.preview;
  const draft = slot.previewDraft ?? null;
  const showDraft = !written && !!draft && slot.status === 'planned';
  if (written) {
    return (
      <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
        {collapsible && (
          <div><button type="button" className="btn-tiny" style={{ gap: 5 }} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            <Icon name="eye" size={12} /> {open ? 'Hide post' : 'Show post'}
          </button></div>
        )}
        {open && <PostBox html={slot.preview!} plain={plain} />}
        {slot.critic && <CriticBlock critic={slot.critic} where="slot" />}
      </div>
    );
  }
  if (isLive(slot) && slot.status === 'planned') {
    return <div className="text-micro ink-dim">No preview before its time: a live slot writes about the freshest item it finds at {formatIn(slot.at, tz)} {zoneLabel(tz)}.</div>;
  }
  return (
    <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
      {canPreview(slot) && <div><PreviewButton slot={slot} estimateUsd={estimateUsd} /></div>}
      {showDraft && <PreviewDraft draft={draft!} tz={tz} plain={plain} />}
      {slot.critic && <CriticBlock critic={slot.critic} where="slot" />}
    </div>
  );
}

export interface PlanStampData {
  planDate:   string;
  plannedAt?: string | null;
  runId?:     string | null;
  runRole?:   string | null;
  /** How the agent plans; omitted where the page shows it elsewhere. */
  schedule?:  { planHour: number; timezone: string; approval: boolean; batchHour?: number } | null;
  history?:   Array<{ id: string; plannedAt: string; runId: string | null; runRole: string | null; rationale: string | null; slots?: number }>;
}

/** "Planned at 06:02 Kyiv by planner run →", the approval note, how the agent plans, and the day's earlier plans (collapsed). */
export function PlanStamp({ data, tz }: { data: PlanStampData; tz: string }) {
  const [open, setOpen] = useState(false);
  const at = plannedAtLine(data.plannedAt, tz);
  const evening = data.schedule?.approval && plannedEveningBefore(data.plannedAt, data.planDate, tz);
  const history = data.history ?? [];
  return (
    <div className="text-micro ink-muted" style={{ display: 'grid', gap: 4, minWidth: 0 }} data-testid="plan-stamp">
      {at ? (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <Icon name="clock" size={12} />
          <span>{at}</span>
          <span>by</span>
          {data.runId
            ? <Link to="/app/editor/run/$id" params={{ id: data.runId }} className="link-accent">{runLabel(data.runRole)} →</Link>
            : <span>the owner or the system</span>}
          {evening && <Badge tone="neutral" title="Approval mode plans the next day at the evening batch">planned the evening before at {String(data.schedule!.batchHour ?? 20).padStart(2, '0')}:00</Badge>}
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}><Icon name="clock" size={12} /> Not planned yet.</div>
      )}
      {data.schedule && <div className="ink-dim">{planScheduleNote(data.schedule)}</div>}
      {history.length > 0 && (
        <div>
          <button type="button" className="btn-tiny" style={{ gap: 5 }} aria-haspopup="dialog" onClick={() => setOpen(true)}>
            <Icon name="history" size={12} /> Earlier plans of this day ({history.length})
          </button>
          <Modal open={open} onClose={() => setOpen(false)} size="lg" icon="history" title="Earlier plans of this day"
            subtitle={`${history.length} superseded plan${history.length === 1 ? '' : 's'} · times in ${tz}`}>
            <div className="text-body-sm" style={{ display: 'grid', gap: 10 }}>
              {history.map((h) => (
                <div key={h.id} className="plan-history-row">
                  <span className="tabular-nums plan-ink">{formatIn(h.plannedAt, tz)}</span>
                  {h.runId
                    ? <Link to="/app/editor/run/$id" params={{ id: h.runId }} className="link-accent">{runLabel(h.runRole)} →</Link>
                    : <span className="ink-muted">no run</span>}
                  {h.slots != null && <span className="ink-muted">· {h.slots} slot{h.slots === 1 ? '' : 's'}</span>}
                  <Badge tone="neutral">superseded</Badge>
                  {h.rationale && <span className="ink-muted" style={{ flexBasis: '100%', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{h.rationale}</span>}
                </div>
              ))}
            </div>
          </Modal>
        </div>
      )}
    </div>
  );
}
