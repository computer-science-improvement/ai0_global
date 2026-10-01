// Plan tab of /app/agents/$handle (spec 020 FR-011): one day of the network
// plan — a lane per resource with its slots placed by time (a grouped list on
// narrow screens), slot status, format, topic, the idea it came from, an
// expandable rendered preview and links to the slot and its run.

import { Link } from '@tanstack/react-router';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { EmptyState } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { SLOT_TONE, SLOT_ORDER, fmtTime } from '../editor/EditorUi';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { sanitizeTelegramHtml } from '../../lib/tg-html';
import { useAgentNetwork, useNetworkPlan, type PlanSlot } from '../../api/network';
import { NetworkError, ResourceLabel, fmtDay, isoDay, platformOf, shiftDay } from './NetworkUi';

const PILL_W = 164;
const ROW_H = 30;

const minutesOf = (iso: string) => { const d = new Date(iso); return d.getHours() * 60 + d.getMinutes(); };

export function AgentPlan({ handle, onIdea }: { handle: string; onIdea: (id: string) => void }) {
  const today = isoDay(new Date());
  const [day, setDay] = useState(today);
  const plan = useNetworkPlan(handle, day);
  const net = useAgentNetwork(handle);
  const wide = useMediaQuery('(min-width: 760px)');
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => setSelected(null), [day]);

  const slots = useMemo(() => [...(plan.data?.slots ?? [])].sort((a, b) => a.at.localeCompare(b.at)), [plan.data]);
  const lanes = useMemo(() => {
    const refs = (net.data?.resources ?? []).map((r) => r.ref);
    for (const s of slots) if (!refs.includes(s.resourceRef)) refs.push(s.resourceRef);
    return refs.map((ref) => ({ ref, slots: slots.filter((s) => s.resourceRef === ref) }));
  }, [net.data, slots]);
  const counts = useMemo(() => {
    const c: Partial<Record<PlanSlot['status'], number>> = {};
    for (const s of slots) c[s.status] = (c[s.status] ?? 0) + 1;
    return c;
  }, [slots]);
  const sel = slots.find((s) => s.id === selected) ?? null;

  const relative = day === today ? 'Today' : day === shiftDay(today, 1) ? 'Tomorrow' : day === shiftDay(today, -1) ? 'Yesterday' : null;
  const toolbar = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
      <button type="button" className="btn-act" title="Previous day" aria-label="Previous day" onClick={() => setDay((d) => shiftDay(d, -1))}>
        <Icon name="chevron-left" size={15} />
      </button>
      <input type="date" className="input-field tabular-nums" aria-label="Plan date" value={day}
        onChange={(e) => { if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) setDay(e.target.value); }}
        style={{ width: 150, padding: '6px 10px', fontSize: 13, colorScheme: 'dark' }} />
      <button type="button" className="btn-act" title="Next day" aria-label="Next day" onClick={() => setDay((d) => shiftDay(d, 1))}>
        <Icon name="chevron-right" size={15} />
      </button>
      <span className="text-body-sm" style={{ color: 'var(--color-ink)', fontWeight: 500 }}>
        {relative ?? fmtDay(day)}
        {relative && <span className="text-micro" style={{ color: 'var(--color-ink-dim)', fontWeight: 400, marginLeft: 6 }}>{fmtDay(day)}</span>}
      </span>
      {day !== today && <button type="button" className="btn-tiny" onClick={() => setDay(today)}>Today</button>}
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
          {plan.data.rationale && (
            <div className="card compose-rise" style={{ padding: '10px 14px', marginBottom: 14, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <span style={{ color: 'var(--color-accent)', display: 'inline-flex', marginTop: 2 }}><Icon name="sparkles" size={14} /></span>
              <p className="text-body-sm" style={{ margin: 0, color: 'var(--color-ink)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{plan.data.rationale}</p>
            </div>
          )}
          {slots.length === 0 ? (
            <div>
              <EmptyState icon="calendar" title={`No network plan for ${fmtDay(day)}`}
                note={day >= today ? 'The orchestrator plans the day across every resource in the morning run.' : 'Nothing was planned that day.'} />
            </div>
          ) : wide ? (
            <>
              <Timeline lanes={lanes} selected={selected} onSelect={(id) => setSelected((cur) => (cur === id ? null : id))} />
              {sel
                ? <div style={{ marginTop: 12 }}><SlotDetail slot={sel} onIdea={onIdea} showResource /></div>
                : <p className="text-micro" style={{ color: 'var(--color-ink-dim)', margin: '10px 2px 0' }}>Select a slot to see its topic, preview and links.</p>}
            </>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {lanes.filter((l) => l.slots.length > 0).map((l) => (
                <section key={l.ref} className="panel compose-rise" style={{ padding: 12 }}>
                  <div className="text-body-sm" style={{ marginBottom: 8, display: 'flex' }}><ResourceLabel refId={l.ref} strong /></div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {l.slots.map((s) => (
                      <ListSlot key={s.id} slot={s} open={selected === s.id} onToggle={() => setSelected((cur) => (cur === s.id ? null : s.id))} onIdea={onIdea} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── timeline (wide screens) ──

function Timeline({ lanes, selected, onSelect }: { lanes: Array<{ ref: string; slots: PlanSlot[] }>; selected: string | null; onSelect: (id: string) => void }) {
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
  const mins = all.map((s) => minutesOf(s.at));
  let start = Math.max(0, Math.floor(Math.min(...mins) / 60) - 1);
  let end = Math.min(24, Math.ceil((Math.max(...mins) + 1) / 60) + 1);
  if (end - start < 8) { const pad = 8 - (end - start); start = Math.max(0, start - Math.floor(pad / 2)); end = Math.min(24, start + 8); }
  const span = (end - start) * 60;
  // Leave room for the last pill so it never overflows the track.
  const usable = Math.max(1, width - PILL_W);
  const x = (s: PlanSlot) => ((minutesOf(s.at) - start * 60) / span) * usable;
  const hours = Array.from({ length: end - start + 1 }, (_, i) => start + i);
  const step = (end - start) > 14 ? 2 : 1;
  const nowMin = minutesOf(new Date().toISOString());

  // Greedy row packing per lane: a pill goes on the first row where it doesn't overlap.
  const packed = lanes.map((l) => {
    const rows: number[] = [];
    const placed = l.slots.map((s) => {
      const left = x(s);
      let row = rows.findIndex((right) => left >= right + 4);
      if (row === -1) { row = rows.length; rows.push(0); }
      rows[row] = left + PILL_W;
      return { s, left, row };
    });
    return { ref: l.ref, placed, rows: Math.max(1, rows.length) };
  });

  return (
    <div className="panel compose-rise" style={{ padding: '12px 14px', overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '170px minmax(0, 1fr)', columnGap: 12 }}>
        <div />
        <div ref={track} style={{ position: 'relative', height: 18 }}>
          {width > 0 && hours.filter((h) => (h - start) % step === 0).map((h) => (
            <span key={h} className="text-micro tabular-nums"
              style={{ position: 'absolute', left: ((h - start) * 60 / span) * usable, transform: 'translateX(-2px)', color: 'var(--color-ink-dim)', fontSize: 10 }}>
              {String(h).padStart(2, '0')}
            </span>
          ))}
        </div>
        {packed.map((lane) => (
          <LaneRow key={lane.ref} lane={lane} width={width} usable={usable} start={start} span={span} hours={hours} nowMin={nowMin} selected={selected} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}

function LaneRow({ lane, width, usable, start, span, hours, nowMin, selected, onSelect }: {
  lane: { ref: string; placed: Array<{ s: PlanSlot; left: number; row: number }>; rows: number };
  width: number; usable: number; start: number; span: number; hours: number[]; nowMin: number; selected: string | null; onSelect: (id: string) => void;
}) {
  const h = lane.rows * ROW_H + 8;
  const isToday = lane.placed[0] ? isoDay(new Date(lane.placed[0].s.at)) === isoDay(new Date()) : false;
  const nowX = ((nowMin - start * 60) / span) * usable;
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', minWidth: 0, borderTop: '1px solid var(--color-hairline-soft)', minHeight: h }} className="text-body-sm">
        <ResourceLabel refId={lane.ref} strong extra={<span className="text-micro tabular-nums" style={{ color: 'var(--color-ink-dim)' }}>{lane.placed.length}</span>} />
      </div>
      <div style={{ position: 'relative', height: h, borderTop: '1px solid var(--color-hairline-soft)' }}>
        {width > 0 && hours.map((hr) => (
          <span key={hr} aria-hidden style={{ position: 'absolute', top: 0, bottom: 0, left: ((hr - start) * 60 / span) * usable, width: 1, background: 'var(--color-hairline-soft)' }} />
        ))}
        {width > 0 && isToday && nowX >= 0 && nowX <= usable && (
          <span aria-hidden title="now" style={{ position: 'absolute', top: 0, bottom: 0, left: nowX, width: 2, background: 'var(--color-accent)', opacity: 0.6 }} />
        )}
        {width > 0 && lane.placed.map(({ s, left, row }) => (
          <SlotPill key={s.id} slot={s} left={left} top={4 + row * ROW_H} active={selected === s.id} onClick={() => onSelect(s.id)} />
        ))}
      </div>
    </>
  );
}

const TONE_VAR = { neutral: 'var(--color-ink-dim)', warning: 'var(--color-warning)', accent: 'var(--color-accent)', success: 'var(--color-success)', danger: 'var(--color-danger)' } as const;

function SlotPill({ slot, left, top, active, onClick }: { slot: PlanSlot; left: number; top: number; active: boolean; onClick: () => void }) {
  const tone = TONE_VAR[SLOT_TONE[slot.status]];
  const dim = slot.status === 'skipped';
  return (
    <button type="button" onClick={onClick} aria-pressed={active} title={`${fmtTime(slot.at)} · ${slot.status} · ${slot.format}\n${slot.topic}`}
      style={{
        position: 'absolute', left, top, width: PILL_W, height: ROW_H - 4, boxSizing: 'border-box',
        display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px', cursor: 'pointer', font: 'inherit', textAlign: 'left',
        background: active ? 'var(--color-surface-3)' : 'var(--color-surface-2)', color: 'var(--color-ink)',
        borderStyle: 'solid', borderWidth: '1px 1px 1px 3px',
        borderColor: active ? `var(--color-accent) var(--color-accent) var(--color-accent) ${tone}` : `var(--color-hairline) var(--color-hairline) var(--color-hairline) ${tone}`,
        borderRadius: 'var(--radius-sm)', opacity: dim ? 0.55 : 1,
        textDecoration: dim ? 'line-through' : undefined,
      }}>
      <span className="tabular-nums" style={{ fontSize: 11, fontWeight: 600, flexShrink: 0 }}>{fmtTime(slot.at)}</span>
      <span style={{ fontSize: 11, color: 'var(--color-ink-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
        {slot.kind === 'reserved' ? 'reserved' : slot.topic}
      </span>
    </button>
  );
}

// ── list (narrow screens) + detail ──

function ListSlot({ slot, open, onToggle, onIdea }: { slot: PlanSlot; open: boolean; onToggle: () => void; onIdea: (id: string) => void }) {
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden', boxShadow: open ? 'inset 0 0 0 1px var(--color-accent)' : undefined }}>
      <button type="button" onClick={onToggle} aria-expanded={open}
        style={{ display: 'flex', gap: 10, alignItems: 'flex-start', width: '100%', padding: '10px 12px', background: 'none', border: 0, color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer' }}>
        <span className="tabular-nums" style={{ fontWeight: 600, color: 'var(--color-ink)', width: 44, flexShrink: 0 }}>{fmtTime(slot.at)}</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 3 }}>
            <Badge tone={SLOT_TONE[slot.status]}>{slot.status}</Badge>
            <span className="chip" style={{ fontSize: 11 }}>{slot.format}</span>
            {slot.kind === 'reserved' && <span className="chip" style={{ fontSize: 11 }}>reserved</span>}
          </span>
          <span className="text-body-sm" style={{ color: 'var(--color-ink)', display: 'block', overflowWrap: 'anywhere' }}>{slot.topic}</span>
        </span>
        <span style={{ color: 'var(--color-ink-dim)', display: 'inline-flex', marginTop: 2 }}><Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} /></span>
      </button>
      {open && <div style={{ padding: '0 12px 12px' }}><SlotDetail slot={slot} onIdea={onIdea} compact /></div>}
    </div>
  );
}

function SlotDetail({ slot, onIdea, showResource = false, compact = false }: { slot: PlanSlot; onIdea: (id: string) => void; showResource?: boolean; compact?: boolean }) {
  const [preview, setPreview] = useState(false);
  const html = useMemo(() => (slot.preview ? sanitizeTelegramHtml(slot.preview) : null), [slot.preview]);
  const tg = platformOf(slot.resourceRef) === 'telegram';
  return (
    <div className={compact ? undefined : 'card compose-rise'} style={compact ? undefined : { padding: '14px 16px' }}>
      {!compact && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
          <span className="tabular-nums" style={{ fontWeight: 600, color: 'var(--color-ink)' }}>{fmtTime(slot.at)}</span>
          {showResource && <span className="text-body-sm" style={{ display: 'inline-flex', minWidth: 0 }}><ResourceLabel refId={slot.resourceRef} /></span>}
          <Badge tone={SLOT_TONE[slot.status]}>{slot.status}</Badge>
          <span className="chip" style={{ fontSize: 11 }}>{slot.format}</span>
          {slot.kind === 'reserved' && <span className="chip" style={{ fontSize: 11 }}>reserved</span>}
        </div>
      )}
      {!compact && <div style={{ color: 'var(--color-ink)', fontWeight: 500, overflowWrap: 'anywhere' }}>{slot.topic}</div>}
      {slot.angle && <div className="text-body-sm" style={{ color: 'var(--color-ink-muted)', marginTop: 3, overflowWrap: 'anywhere' }}>{slot.angle}</div>}
      {slot.error && (
        <div className={slot.status === 'failed' ? 'callout-danger' : 'callout-warning'} style={{ marginTop: 8, overflowWrap: 'anywhere' }}>{slot.error}</div>
      )}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
        {slot.ideaId && (
          <button type="button" className="btn-tiny" style={{ gap: 5 }} onClick={() => onIdea(slot.ideaId!)}>
            <Icon name="sparkles" size={12} /> Idea
          </button>
        )}
        {html && (
          <button type="button" className="btn-tiny" style={{ gap: 5 }} aria-expanded={preview} onClick={() => setPreview((v) => !v)}>
            <Icon name="eye" size={12} /> {preview ? 'Hide preview' : 'Preview'}
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
      {preview && html && (
        <div style={{ background: 'var(--color-surface-1)', borderRadius: 'var(--radius-lg)', padding: 14, marginTop: 10, maxWidth: 480, border: '1px solid var(--color-hairline-soft)' }}>
          {!tg && <div className="text-micro" style={{ color: 'var(--color-ink-dim)', marginBottom: 6 }}>rendered text</div>}
          <div className="text-body-sm" style={{ color: 'var(--color-ink)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5 }}
            dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      )}
    </div>
  );
}
