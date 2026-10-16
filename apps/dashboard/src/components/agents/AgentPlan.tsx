// Plan tab of /app/agents/$handle (spec 020 FR-011, spec 024 FR-011): one day
// of the network plan — a lane per resource with its slots placed by time (a
// grouped list on narrow screens), slot status, format, topic, the treatment
// (U unique / D duplicate / A adapt) with a connector from each source to its
// derived slots, the idea it came from, the per-idea decisions (skips and
// reasons), an expandable rendered preview and links to the slot and its run.
//
// Times: the axis is the network (anchor) zone's plan day; each lane shows its
// resource's zone and local "now"; a pill shows the resource's own time and the
// owner's Kyiv time when they differ. Nothing reads the browser zone.
//
// Compact: a pill (wide) or a list row (narrow) opens the slot's details in a dialog;
// each idea's decisions are a compact card whose dialog holds the per-resource rows;
// a long plan rationale is clamped with the full text in a dialog.
//
// Spec 034 FR-012 / FR-013: "Planned at … by {run →}", how the agent plans (approval:
// the evening before), the day's earlier plans, and per slot either the live call
// ("At 14:00: fetch … → pick the freshest item → write …") or the fixed details with a
// dry-run Preview, the written post and the critic's verdict.

import { Link } from '@tanstack/react-router';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { EmptyState } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { CompactCard } from '../ui/CompactCard';
import { Modal } from '../Modal';
import { SLOT_TONE, SLOT_ORDER } from '../editor/EditorUi';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { dayIn, dual, formatIn, zoneLabel } from '../../lib/zoned-time';
import { isLive, liveLine, planScheduleNote } from '../../lib/slot-plan';
import { CriticBadge, PlanStamp, SlotDescription, SlotPost } from '../editor/SlotPlan';
import {
  TREATMENT_LETTER, anchorZone, axisHours, axisLabel, connectors, laneZone, packRows, pillTimes, slotMinutes,
} from '../../lib/plan-timeline';
import { useAgentNetwork, useNetworkPlan, type ContentDecision, type Decision, type PlanSlot } from '../../api/network';
import { NetworkError, ResourceLabel, fmtDay, platformOf, shiftDay } from './NetworkUi';
import type { Tone } from '../ui/primitives';

const PILL_W = 176;
const ROW_H = 30;
const LABEL_W = 170;
const COL_GAP = 12;
const AXIS_H = 18;

export const TREATMENT_LABEL: Record<NonNullable<PlanSlot['treatment']>, string> = { unique: 'unique', duplicate: 'duplicate', adapt: 'adapt' };
export const DECISION_TONE: Record<Decision, Tone> = { unique: 'accent', duplicate: 'neutral', adapt: 'success', skip: 'warning' };
const REASON_CODE_LABEL: Record<string, string> = {
  off_topic: 'off topic', audience_mismatch: 'audience mismatch', format_unfit: 'format unfit', low_kpi: 'low KPI', cadence: 'cadence full', other: 'other',
};
const DECIDED_BY_LABEL: Record<ContentDecision['decidedBy'], string> = {
  planner: 'planner', orchestrator: 'orchestrator', executor: 'executor', owner: 'you', system: 'system',
};

interface Lane { ref: string; tz: string; slots: PlanSlot[] }

/** Plan-level data the slot views need (spec 034 FR-012): feed names for live slots, the typical Preview cost. */
interface PlanExtra { feeds: Record<string, string>; estimateUsd: number | null }

export function AgentPlan({ handle, onIdea }: { handle: string; onIdea: (id: string) => void }) {
  const net = useAgentNetwork(handle);
  const anchorTz = anchorZone(net.data?.anchor, net.data?.resources);
  const today = dayIn(new Date(), anchorTz);
  const [picked, setPicked] = useState<string | null>(null);
  const day = picked ?? today;
  const setDay = (f: (d: string) => string) => setPicked((cur) => f(cur ?? today));
  const plan = useNetworkPlan(handle, day);
  const wide = useMediaQuery('(min-width: 760px)');
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => setSelected(null), [day]);

  const slots = useMemo(() => [...(plan.data?.slots ?? [])].sort((a, b) => a.at.localeCompare(b.at)), [plan.data]);
  const lanes = useMemo<Lane[]>(() => {
    const refs = (net.data?.resources ?? []).map((r) => r.ref);
    for (const s of slots) if (!refs.includes(s.resourceRef)) refs.push(s.resourceRef);
    return refs.map((ref) => ({ ref, tz: laneZone(ref, net.data?.resources, anchorTz), slots: slots.filter((s) => s.resourceRef === ref) }));
  }, [net.data, slots, anchorTz]);
  const tzOf = useMemo(() => new Map(lanes.map((l) => [l.ref, l.tz])), [lanes]);
  const counts = useMemo(() => {
    const c: Partial<Record<PlanSlot['status'], number>> = {};
    for (const s of slots) c[s.status] = (c[s.status] ?? 0) + 1;
    return c;
  }, [slots]);
  const sel = slots.find((s) => s.id === selected) ?? null;
  const decisions = plan.data?.decisions ?? [];
  const extra: PlanExtra = { feeds: plan.data?.feeds ?? {}, estimateUsd: plan.data?.previewEstimateUsd ?? null };
  const select = (id: string) => setSelected(id);

  const relative = day === today ? 'Today' : day === shiftDay(today, 1) ? 'Tomorrow' : day === shiftDay(today, -1) ? 'Yesterday' : null;
  const toolbar = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
      <button type="button" className="btn-act" title="Previous day" aria-label="Previous day" onClick={() => setDay((d) => shiftDay(d, -1))}>
        <Icon name="chevron-left" size={15} />
      </button>
      <input type="date" className="input-field tabular-nums" aria-label="Plan date" value={day}
        onChange={(e) => { if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) setPicked(e.target.value); }}
        style={{ width: 150, padding: '6px 10px', fontSize: 13, colorScheme: 'dark' }} />
      <button type="button" className="btn-act" title="Next day" aria-label="Next day" onClick={() => setDay((d) => shiftDay(d, 1))}>
        <Icon name="chevron-right" size={15} />
      </button>
      <span className="text-body-sm" style={{ color: 'var(--color-ink)', fontWeight: 500 }}>
        {relative ?? fmtDay(day)}
        {relative && <span className="text-micro" style={{ color: 'var(--color-ink-dim)', fontWeight: 400, marginLeft: 6 }}>{fmtDay(day)}</span>}
      </span>
      {day !== today && <button type="button" className="btn-tiny" onClick={() => setPicked(null)}>Today</button>}
      <span className="text-micro" title="The plan day and the time axis follow the network's (anchor channel's) time zone"
        style={{ color: 'var(--color-ink-dim)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <Icon name="clock" size={12} /> {zoneLabel(anchorTz)} time
      </span>
      <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap', marginLeft: 'auto' }}>
        {SLOT_ORDER.filter((s) => (counts[s] ?? 0) > 0).map((s) => <Badge key={s} tone={SLOT_TONE[s]}>{counts[s]} {s}</Badge>)}
      </span>
    </div>
  );

  if (plan.error) return <div>{toolbar}<NetworkError error={plan.error} /></div>;

  return (
    <div>
      {toolbar}
      {!plan.data && <div className="panel compose-rise" style={{ height: 180, opacity: 0.55 }} />}
      {plan.data && (
        <>
          <div className="card compose-rise" style={{ padding: '10px 14px', marginBottom: 14, display: 'grid', gap: 8, minWidth: 0 }}>
            <PlanStamp tz={anchorTz} data={{
              planDate: day, plannedAt: plan.data.plannedAt, runId: plan.data.runId, runRole: plan.data.runRole,
              schedule: plan.data.schedule ?? null, history: plan.data.history,
            }} />
            {plan.data.rationale && <Rationale text={plan.data.rationale} day={day} />}
          </div>
          {slots.length === 0 ? (
            <div>
              <EmptyState icon="calendar" title={`No network plan for ${fmtDay(day)}`}
                note={day >= today
                  ? (plan.data.schedule ? planScheduleNote(plan.data.schedule) : 'The orchestrator plans the day across every resource in the morning run.')
                  : 'Nothing was planned that day.'} />
            </div>
          ) : wide ? (
            <>
              <Timeline lanes={lanes} day={day} today={today} anchorTz={anchorTz} selected={selected} onSelect={select} />
              <p className="text-micro" style={{ color: 'var(--color-ink-dim)', margin: '10px 2px 0' }}>Click a slot to open its topic, treatment, preview and links.</p>
            </>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {lanes.filter((l) => l.slots.length > 0).map((l) => (
                <section key={l.ref} className="panel compose-rise" style={{ padding: 12 }}>
                  <div className="text-body-sm" style={{ marginBottom: 8, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                    <ResourceLabel refId={l.ref} strong />
                    <LaneClock tz={l.tz} />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {l.slots.map((s) => (
                      <ListSlot key={s.id} slot={s} tz={l.tz} open={selected === s.id} onOpen={() => select(s.id)} extra={extra} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
          {decisions.length > 0 && <DecisionsPanel decisions={decisions} slots={slots} tzOf={tzOf} onIdea={onIdea} onSelect={setSelected} />}
          <SlotDialog slot={sel} slots={slots} tzOf={tzOf} decisions={decisions} extra={extra} onSelect={setSelected}
            onIdea={(id) => { setSelected(null); onIdea(id); }} onClose={() => setSelected(null)} />
        </>
      )}
    </div>
  );
}

/** The planner's rationale, clamped to two lines; a long one opens in full in a dialog. */
function Rationale({ text, day }: { text: string; day: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 220 || text.split('\n').length > 2;
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', borderTop: '1px solid var(--color-hairline-soft)', paddingTop: 8, minWidth: 0 }}>
      <span style={{ color: 'var(--color-accent)', display: 'inline-flex', marginTop: 2 }}><Icon name="sparkles" size={14} /></span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p className="text-body-sm clamp" style={{ margin: 0, color: 'var(--color-ink)', whiteSpace: 'pre-wrap' }}>{text}</p>
        {long && <button type="button" className="btn-tiny" style={{ marginTop: 6 }} onClick={() => setOpen(true)}>Read all</button>}
      </div>
      <Modal open={open} onClose={() => setOpen(false)} size="lg" icon="sparkles" title="Plan rationale" subtitle={fmtDay(day)}>
        <p className="text-body-sm" style={{ margin: 0, color: 'var(--color-ink)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{text}</p>
      </Modal>
    </div>
  );
}

/** A slot's details in a dialog — opened from a timeline pill or a list row. */
function SlotDialog({ slot, slots, tzOf, decisions, extra, onSelect, onIdea, onClose }: {
  slot: PlanSlot | null; slots: PlanSlot[]; tzOf: Map<string, string>; decisions: ContentDecision[]; extra: PlanExtra;
  onSelect: (id: string) => void; onIdea: (id: string) => void; onClose: () => void;
}) {
  const tz = slot ? tzOf.get(slot.resourceRef) ?? 'Europe/Kyiv' : 'Europe/Kyiv';
  return (
    <Modal open={!!slot} onClose={onClose} size="lg" icon="calendar"
      title={slot ? (slot.kind === 'reserved' ? 'Reserved slot' : slot.topic || 'Slot') : ''}
      subtitle={slot ? dual(slot.at, tz) : undefined}>
      {slot && <SlotDetail slot={slot} slots={slots} tzOf={tzOf} decisions={decisions} onSelect={onSelect} extra={extra} />}
      {slot && (
        <div className="modal-foot">
          {slot.ideaId && (
            <button type="button" className="btn-tiny" style={{ gap: 5 }} onClick={() => onIdea(slot.ideaId!)}>
              <Icon name="sparkles" size={12} /> Idea
            </button>
          )}
          <Link to="/app/editor/slot/$id" params={{ id: slot.id }} className="btn-tiny" style={{ gap: 5, textDecoration: 'none' }}>
            <Icon name="calendar" size={12} /> Slot
          </Link>
          {slot.runId && (
            <Link to="/app/editor/run/$id" params={{ id: slot.runId }} className="btn-tiny" style={{ gap: 5, textDecoration: 'none' }}>
              <Icon name="logs" size={12} /> Run
            </Link>
          )}
        </div>
      )}
    </Modal>
  );
}

/** "Kyiv · now 16:04" — a resource's zone and its local now. */
function LaneClock({ tz }: { tz: string }) {
  return (
    <span className="text-micro tabular-nums" title={`Time zone: ${tz}`} style={{ color: 'var(--color-ink-dim)', fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
      {zoneLabel(tz)} · now {formatIn(new Date(), tz)}
    </span>
  );
}

// ── timeline (wide screens) ──

function Timeline({ lanes, day, today, anchorTz, selected, onSelect }: {
  lanes: Lane[]; day: string; today: string; anchorTz: string; selected: string | null; onSelect: (id: string) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = track.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const all = lanes.flatMap((l) => l.slots);
  const { start, end } = axisHours(all.map((s) => slotMinutes(s.at, day, anchorTz)));
  const span = (end - start) * 60;
  // Leave room for the last pill so it never overflows the track.
  const usable = Math.max(1, width - PILL_W);
  const xOf = (s: PlanSlot) => ((slotMinutes(s.at, day, anchorTz) - start * 60) / span) * usable;
  const hours = Array.from({ length: end - start + 1 }, (_, i) => start + i);
  const step = (end - start) > 14 ? 2 : 1;
  const nowX = day === today ? ((slotMinutes(new Date().toISOString(), day, anchorTz) - start * 60) / span) * usable : null;

  const packed = lanes.map((l) => {
    const lefts = l.slots.map(xOf);
    const { rows, count } = packRows(lefts, PILL_W);
    return { lane: l, placed: l.slots.map((s, i) => ({ s, left: lefts[i], row: rows[i] })), rows: count };
  });

  // Pill positions inside the grid, for the source → derived connectors.
  const pos = new Map<string, { x: number; top: number; bottom: number }>();
  let y = AXIS_H;
  for (const p of packed) {
    const h = p.rows * ROW_H + 8;
    for (const { s, left, row } of p.placed) {
      const top = y + 4 + row * ROW_H;
      pos.set(s.id, { x: LABEL_W + COL_GAP + left, top, bottom: top + ROW_H - 4 });
    }
    y += h;
  }
  const links = connectors(all).filter((c) => pos.has(c.from.id) && pos.has(c.to.id));

  return (
    <div className="panel compose-rise" style={{ padding: '12px 14px', overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: `${LABEL_W}px minmax(0, 1fr)`, columnGap: COL_GAP, position: 'relative' }}>
        <div />
        <div ref={track} style={{ position: 'relative', height: AXIS_H }}>
          {width > 0 && hours.filter((h) => (h - start) % step === 0).map((h) => (
            <span key={h} className="text-micro tabular-nums"
              style={{ position: 'absolute', left: ((h - start) * 60 / span) * usable, transform: 'translateX(-2px)', color: h >= 24 ? 'var(--color-ink-muted)' : 'var(--color-ink-dim)', fontSize: 10 }}
              title={h >= 24 ? `${axisLabel(h)}:00 the next day (${zoneLabel(anchorTz)})` : `${axisLabel(h)}:00 ${zoneLabel(anchorTz)}`}>
              {axisLabel(h)}{h === 24 ? '+1' : ''}
            </span>
          ))}
        </div>
        {packed.map((p) => (
          <LaneRow key={p.lane.ref} lane={p.lane} placed={p.placed} rows={p.rows} width={width} usable={usable} start={start} span={span}
            hours={hours} nowX={nowX} selected={selected} onSelect={onSelect} />
        ))}
        {width > 0 && links.length > 0 && (
          <svg aria-hidden width="100%" height={y} style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none', overflow: 'visible', zIndex: 2 }}>
            <defs>
              <marker id="plan-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L8,4 L0,8 z" fill="var(--color-accent)" />
              </marker>
            </defs>
            {links.map(({ from, to }) => {
              const a = pos.get(from.id)!;
              const b = pos.get(to.id)!;
              const down = b.top >= a.top;
              const x1 = a.x + 22;
              const y1 = down ? a.bottom : a.top;
              const x2 = b.x + 22;
              const y2 = down ? b.top : b.bottom;
              const mid = (y1 + y2) / 2;
              const hot = selected === from.id || selected === to.id;
              return (
                <path key={to.id} d={`M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}`} fill="none"
                  stroke="var(--color-accent)" strokeWidth={hot ? 1.8 : 1.2} strokeDasharray={hot ? undefined : '4 3'} opacity={hot ? 0.95 : 0.55}
                  markerEnd="url(#plan-arrow)" />
              );
            })}
          </svg>
        )}
      </div>
    </div>
  );
}

function LaneRow({ lane, placed, rows, width, usable, start, span, hours, nowX, selected, onSelect }: {
  lane: Lane; placed: Array<{ s: PlanSlot; left: number; row: number }>; rows: number;
  width: number; usable: number; start: number; span: number; hours: number[]; nowX: number | null; selected: string | null; onSelect: (id: string) => void;
}) {
  const h = rows * ROW_H + 8;
  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2, minWidth: 0, borderTop: '1px solid var(--color-hairline-soft)', minHeight: h }} className="text-body-sm">
        <ResourceLabel refId={lane.ref} strong extra={<span className="text-micro tabular-nums" style={{ color: 'var(--color-ink-dim)' }}>{placed.length}</span>} />
        <LaneClock tz={lane.tz} />
      </div>
      <div style={{ position: 'relative', height: h, borderTop: '1px solid var(--color-hairline-soft)' }}>
        {width > 0 && hours.map((hr) => (
          <span key={hr} aria-hidden style={{ position: 'absolute', top: 0, bottom: 0, left: ((hr - start) * 60 / span) * usable, width: 1, background: hr === 24 ? 'var(--color-hairline)' : 'var(--color-hairline-soft)' }} />
        ))}
        {width > 0 && nowX != null && nowX >= 0 && nowX <= usable && (
          <span aria-hidden title="now" style={{ position: 'absolute', top: 0, bottom: 0, left: nowX, width: 2, background: 'var(--color-accent)', opacity: 0.6 }} />
        )}
        {width > 0 && placed.map(({ s, left, row }) => (
          <SlotPill key={s.id} slot={s} tz={lane.tz} left={left} top={4 + row * ROW_H} active={selected === s.id} onClick={() => onSelect(s.id)} />
        ))}
      </div>
    </>
  );
}

const TONE_VAR = { neutral: 'var(--color-ink-dim)', warning: 'var(--color-warning)', accent: 'var(--color-accent)', success: 'var(--color-success)', danger: 'var(--color-danger)' } as const;

/** U / D / A in a tiny square. */
function TreatmentMark({ treatment }: { treatment: PlanSlot['treatment'] }) {
  if (!treatment) return null;
  return (
    <span aria-label={TREATMENT_LABEL[treatment]} title={TREATMENT_LABEL[treatment]}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 15, height: 15, flexShrink: 0,
        borderRadius: 3, fontSize: 9.5, fontWeight: 700, lineHeight: 1,
        background: 'var(--color-surface-3)',
        color: treatment === 'unique' ? 'var(--color-ink-muted)' : 'var(--color-accent)',
        border: '1px solid var(--color-hairline)',
      }}>
      {TREATMENT_LETTER[treatment]}
    </span>
  );
}

function slotTitle(slot: PlanSlot, tz: string): string {
  const what = isLive(slot) ? liveLine(slot, tz) : slot.topic;
  return `${dual(slot.at, tz)} · ${slot.status} · ${slot.format}${slot.treatment ? ` · ${TREATMENT_LABEL[slot.treatment]}` : ''}\n${what}`;
}

function SlotPill({ slot, tz, left, top, active, onClick }: { slot: PlanSlot; tz: string; left: number; top: number; active: boolean; onClick: () => void }) {
  const tone = TONE_VAR[SLOT_TONE[slot.status]];
  const dim = slot.status === 'skipped';
  const t = pillTimes(slot.at, tz);
  return (
    <button type="button" onClick={onClick} aria-pressed={active} title={slotTitle(slot, tz)}
      style={{
        position: 'absolute', left, top, width: PILL_W, height: ROW_H - 4, boxSizing: 'border-box', zIndex: 1,
        display: 'flex', alignItems: 'center', gap: 5, padding: '0 7px', cursor: 'pointer', font: 'inherit', textAlign: 'left',
        background: active ? 'var(--color-surface-3)' : 'var(--color-surface-2)', color: 'var(--color-ink)',
        borderStyle: 'solid', borderWidth: '1px 1px 1px 3px',
        borderColor: active ? `var(--color-accent) var(--color-accent) var(--color-accent) ${tone}` : `var(--color-hairline) var(--color-hairline) var(--color-hairline) ${tone}`,
        borderRadius: 'var(--radius-sm)', opacity: dim ? 0.55 : 1,
        textDecoration: dim ? 'line-through' : undefined,
      }}>
      <TreatmentMark treatment={slot.treatment ?? null} />
      {isLive(slot) && <span aria-label="live" style={{ color: 'var(--color-accent)', display: 'inline-flex', flexShrink: 0 }}><Icon name="radar" size={11} /></span>}
      <span className="tabular-nums" style={{ fontSize: 11, fontWeight: 600, flexShrink: 0 }}>{t.local}</span>
      {t.kyiv && <span className="tabular-nums" style={{ fontSize: 10, color: 'var(--color-ink-dim)', flexShrink: 0 }}>· {t.kyiv} Kyiv</span>}
      <span style={{ fontSize: 11, color: 'var(--color-ink-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
        {slot.kind === 'reserved' ? 'reserved' : slot.topic}
      </span>
    </button>
  );
}

// ── list (narrow screens) + detail ──

function ListSlot({ slot, tz, open, onOpen, extra }: {
  slot: PlanSlot; tz: string; open: boolean; onOpen: () => void; extra: PlanExtra;
}) {
  const t = pillTimes(slot.at, tz);
  return (
    <button type="button" className="card row-lift" onClick={onOpen} aria-haspopup="dialog" title={slotTitle(slot, tz)}
      style={{ display: 'flex', gap: 10, alignItems: 'flex-start', width: '100%', padding: '10px 12px', color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer',
        boxShadow: open ? 'inset 0 0 0 1px var(--color-accent)' : undefined }}>
      <span className="tabular-nums" style={{ fontWeight: 600, color: 'var(--color-ink)', width: 44, flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
        {t.local}
        {t.kyiv && <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--color-ink-dim)' }}>{t.kyiv} Kyiv</span>}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 3 }}>
          <TreatmentMark treatment={slot.treatment ?? null} />
          <Badge tone={SLOT_TONE[slot.status]}>{slot.status}</Badge>
          <span className="chip" style={{ fontSize: 11 }}>{slot.format}</span>
          {slot.kind === 'reserved' && <span className="chip" style={{ fontSize: 11 }}>reserved</span>}
          <CriticBadge critic={slot.critic} />
        </span>
        <span className="text-body-sm clamp" style={{ color: 'var(--color-ink)', ['--clamp' as string]: 2 }}>{slot.topic}</span>
        <span style={{ display: 'block', marginTop: 3 }}><SlotDescription slot={slot} tz={tz} feeds={extra.feeds} compact /></span>
      </span>
      <span style={{ color: 'var(--color-ink-dim)', display: 'inline-flex', marginTop: 2 }}><Icon name="chevron-right" size={14} /></span>
    </button>
  );
}

/** A small button that jumps to another slot of the plan (source or derived). */
function SlotJump({ slot, tz, onSelect }: { slot: PlanSlot; tz: string; onSelect: (id: string) => void }) {
  return (
    <button type="button" className="btn-tiny" style={{ gap: 5, maxWidth: '100%' }} title={slotTitle(slot, tz)} onClick={() => onSelect(slot.id)}>
      <TreatmentMark treatment={slot.treatment ?? null} />
      <span style={{ display: 'inline-flex', minWidth: 0 }}><ResourceLabel refId={slot.resourceRef} /></span>
      <span className="tabular-nums">{formatIn(slot.at, tz)}</span>
    </button>
  );
}

/** Everything about one slot: the dialog body (the topic is the dialog title, the links its footer). */
function SlotDetail({ slot, slots, tzOf, decisions, onSelect, extra }: {
  slot: PlanSlot; slots: PlanSlot[]; tzOf: Map<string, string>; decisions: ContentDecision[];
  onSelect: (id: string) => void; extra: PlanExtra;
}) {
  const tg = platformOf(slot.resourceRef) === 'telegram';
  const tz = tzOf.get(slot.resourceRef) ?? 'Europe/Kyiv';
  const source = slot.derivedFrom ? slots.find((s) => s.id === slot.derivedFrom) ?? null : null;
  const derived = slots.filter((s) => s.derivedFrom === slot.id);
  const ideaDecisions = slot.ideaId ? decisions.filter((d) => d.ideaId === slot.ideaId) : [];
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <span className="text-body-sm" style={{ display: 'inline-flex', minWidth: 0 }}><ResourceLabel refId={slot.resourceRef} /></span>
        <Badge tone={SLOT_TONE[slot.status]}>{slot.status}</Badge>
        <span className="chip" style={{ fontSize: 11 }}>{slot.format}</span>
        {slot.kind === 'reserved' && <span className="chip" style={{ fontSize: 11 }}>reserved</span>}
        <CriticBadge critic={slot.critic} />
      </div>
      {slot.kind === 'reserved' && slot.topic && <div style={{ color: 'var(--color-ink)', fontWeight: 500, overflowWrap: 'anywhere' }}>{slot.topic}</div>}
      <div style={{ marginTop: 4 }}><SlotDescription slot={slot} tz={tz} feeds={extra.feeds} /></div>
      {slot.treatment && (
        <div className="text-body-sm" style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <Badge tone={DECISION_TONE[slot.treatment]}>{TREATMENT_LABEL[slot.treatment]}</Badge>
          {slot.treatmentReason && <span style={{ color: 'var(--color-ink-muted)', flex: 1, minWidth: 180, overflowWrap: 'anywhere' }}>{slot.treatmentReason}</span>}
        </div>
      )}
      {(source || slot.derivedFrom) && (
        <div className="text-micro" style={{ marginTop: 8, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', color: 'var(--color-ink-dim)' }}>
          <span>Source:</span>
          {source ? <SlotJump slot={source} tz={tzOf.get(source.resourceRef) ?? tz} onSelect={onSelect} /> : (
            <Link to="/app/editor/slot/$id" params={{ id: slot.derivedFrom! }} className="link-accent">another day's slot →</Link>
          )}
        </div>
      )}
      {derived.length > 0 && (
        <div className="text-micro" style={{ marginTop: 8, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', color: 'var(--color-ink-dim)' }}>
          <span>Derived:</span>
          {derived.map((d) => <SlotJump key={d.id} slot={d} tz={tzOf.get(d.resourceRef) ?? tz} onSelect={onSelect} />)}
        </div>
      )}
      {slot.error && slot.status !== 'skipped' && slot.status !== 'failed' && (
        <div className="callout-warning" style={{ marginTop: 8, overflowWrap: 'anywhere' }}>{slot.error}</div>
      )}
      {slot.kind !== 'reserved' && <div style={{ marginTop: 10 }}><SlotPost slot={slot} tz={tz} estimateUsd={extra.estimateUsd} plain={!tg} /></div>}
      {ideaDecisions.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className="text-eyebrow" style={{ marginBottom: 4 }}>Decisions for this idea</div>
          <DecisionRows decisions={ideaDecisions} />
        </div>
      )}
    </div>
  );
}

// ── decisions ──

/** One row per resource: the decision, its reason (and reason code), who decided. */
export function DecisionRows({ decisions }: { decisions: ContentDecision[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      {decisions.map((d) => (
        <div key={`${d.ideaId}:${d.resourceRef}`} className="text-body-sm"
          style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 150px) auto minmax(0, 1fr)', gap: 8, alignItems: 'baseline', opacity: d.decision === 'skip' ? 0.85 : 1 }}>
          <span style={{ display: 'inline-flex', minWidth: 0 }}><ResourceLabel refId={d.resourceRef} /></span>
          <Badge tone={DECISION_TONE[d.decision]}>{d.decision}</Badge>
          <span style={{ color: 'var(--color-ink-muted)', overflowWrap: 'anywhere', minWidth: 0 }}>
            {d.reason}
            {d.reasonCode && <span className="chip" style={{ fontSize: 10.5, marginLeft: 6 }}>{REASON_CODE_LABEL[d.reasonCode] ?? d.reasonCode}</span>}
            <span className="text-micro" style={{ color: 'var(--color-ink-dim)', marginLeft: 6 }}>by {DECIDED_BY_LABEL[d.decidedBy] ?? d.decidedBy}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function DecisionsPanel({ decisions, slots, tzOf, onIdea, onSelect }: {
  decisions: ContentDecision[]; slots: PlanSlot[]; tzOf: Map<string, string>; onIdea: (id: string) => void; onSelect: (id: string) => void;
}) {
  const ideas = useMemo(() => {
    const order: string[] = [];
    const by = new Map<string, ContentDecision[]>();
    for (const d of decisions) {
      if (!by.has(d.ideaId)) { by.set(d.ideaId, []); order.push(d.ideaId); }
      by.get(d.ideaId)!.push(d);
    }
    return order.map((id) => ({ id, decisions: by.get(id)!, slot: slots.find((s) => s.ideaId === id && !s.derivedFrom) ?? slots.find((s) => s.ideaId === id) ?? null }));
  }, [decisions, slots]);
  return (
    <section className="panel compose-rise" style={{ padding: '12px 14px', marginTop: 14 }} aria-label="Decisions">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span className="text-eyebrow">Decisions</span>
        <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>per idea and resource: duplicate, adapt, unique or skip — with the reason</span>
      </div>
      <div className="compact-grid">
        {ideas.map((i, n) => {
          const skips = i.decisions.filter((d) => d.decision === 'skip').length;
          const topic = i.slot?.topic ?? 'Idea';
          const counts = `${i.decisions.length - skips} planned${skips ? ` · ${skips} skipped` : ''}`;
          return (
            <CompactCard key={i.id} delay={Math.min(n, 12) * 25} hint="Open the decisions for this idea"
              title={topic}
              extra={(
                <span className="text-micro" style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap', color: 'var(--color-ink-dim)' }}>
                  <Badge tone="accent">{i.decisions.length - skips} planned</Badge>
                  {skips > 0 && <Badge tone="warning">{skips} skipped</Badge>}
                </span>
              )}
              dialog={{
                size: 'lg', icon: 'sparkles', title: topic, subtitle: counts,
                body: () => <DecisionRows decisions={i.decisions} />,
                actions: (close) => (
                  <>
                    {i.slot && (
                      <button type="button" className="btn-tiny" style={{ gap: 5 }} title={slotTitle(i.slot, tzOf.get(i.slot.resourceRef) ?? 'Europe/Kyiv')}
                        onClick={() => { close(); onSelect(i.slot!.id); }}>
                        <Icon name="calendar" size={12} /> Slot
                      </button>
                    )}
                    <button type="button" className="btn-tiny" style={{ gap: 5 }} onClick={() => { close(); onIdea(i.id); }}>
                      <Icon name="sparkles" size={12} /> Idea
                    </button>
                  </>
                ),
              }} />
          );
        })}
      </div>
    </section>
  );
}
