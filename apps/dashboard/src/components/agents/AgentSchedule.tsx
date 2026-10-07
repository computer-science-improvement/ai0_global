// Schedule tab of /app/agents/$handle (spec 023 FR-007): a 7-day grid with one
// lane per resource (each resource's own time zone) showing the projected
// series instances (agent vs owner-locked), pins, blackouts, frequency
// overrides and planned / reserved slots; below it the series (inline edit,
// which locks a series, and Unlock) and the owner's rules (add, edit, disable).
// On narrow screens the grid becomes a list grouped by day.

import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { EmptyState, Field, SectionCard } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Icon, type IconName } from '../ui/Icon';
import { toast } from '../ui/Toast';
import { useConfirm } from '../ui/ConfirmDialog';
import { Modal } from '../Modal';
import { SLOT_TONE } from '../editor/EditorUi';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { errorBody } from '../../api/agents';
import {
  useAddRule, usePatchRule, usePutSeries, useSchedule, useUnlockSeries,
  type RuleInput, type RuleKind, type ScheduleResource, type ScheduleResponse, type ScheduleRule, type ScheduleSeries, type SeriesSource,
} from '../../api/schedule';
import {
  buildCadence, cadenceLabel, cellEntries, DAY_SHORT, fmtDate, fmtDayHead, parseCadence, ruleLabel, sourceLabel, tzShort,
  validityLabel, warningsText, WEEK, type Entry,
} from '../../lib/schedule-grid';
import { NetworkError, ResourceLabel, errorText, shiftDay } from './NetworkUi';

const input: CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '6px 10px', fontSize: 13 };
const LANE_W = 168;

export function AgentSchedule({ handle }: { handle: string }) {
  const [from, setFrom] = useState<string | null>(null);
  const q = useSchedule(handle, from);
  const wide = useMediaQuery('(min-width: 760px)');
  const [ruleEdit, setRuleEdit] = useState<{ rule: ScheduleRule | null } | null>(null);
  const [seriesEdit, setSeriesEdit] = useState<{ series: ScheduleSeries | null } | null>(null);
  const d = q.data;

  const toolbar = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
      <button type="button" className="btn-act" title="Previous week" aria-label="Previous week" disabled={!d} onClick={() => d && setFrom(shiftDay(d.from, -7))}>
        <Icon name="chevron-left" size={15} />
      </button>
      <span className="text-body-sm tabular-nums" style={{ color: 'var(--color-ink)', fontWeight: 500 }}>
        {d ? `${fmtDate(d.from)} – ${fmtDate(d.to)}` : 'This week'}
      </span>
      <button type="button" className="btn-act" title="Next week" aria-label="Next week" disabled={!d} onClick={() => d && setFrom(shiftDay(d.from, 7))}>
        <Icon name="chevron-right" size={15} />
      </button>
      {from && <button type="button" className="btn-tiny" onClick={() => setFrom(null)}>This week</button>}
      <span style={{ display: 'inline-flex', gap: 8, marginLeft: 'auto', flexWrap: 'wrap' }}>
        <button type="button" className="btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} disabled={!d}
          onClick={() => setSeriesEdit({ series: null })}>
          <Icon name="plus" size={14} /> Series
        </button>
        <button type="button" className="btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} disabled={!d}
          onClick={() => setRuleEdit({ rule: null })}>
          <Icon name="plus" size={14} /> Add rule
        </button>
      </span>
    </div>
  );

  if (q.error) return <div>{toolbar}<NetworkError error={q.error} /></div>;
  if (!d) return <div>{toolbar}<div className="panel compose-rise" style={{ height: 220, opacity: 0.55 }} /></div>;

  return (
    <div>
      {toolbar}
      <Legend />
      {wide ? <WeekGrid data={d} /> : <DayList data={d} />}
      <div style={{ display: 'grid', gridTemplateColumns: wide ? 'minmax(0, 1fr) minmax(0, 1fr)' : 'minmax(0, 1fr)', gap: 16, marginTop: 18 }}>
        <SeriesList data={d} handle={handle} onEdit={(s) => setSeriesEdit({ series: s })} />
        <RuleList data={d} handle={handle} onEdit={(r) => setRuleEdit({ rule: r })} />
      </div>
      {ruleEdit && <RuleModal handle={handle} data={d} rule={ruleEdit.rule} onClose={() => setRuleEdit(null)} />}
      {seriesEdit && <SeriesModal handle={handle} data={d} series={seriesEdit.series} onClose={() => setSeriesEdit(null)} />}
    </div>
  );
}

// ── grid ──

const KIND_ICON: Record<Entry['kind'], IconName> = { series: 'calendar-sync', pin: 'pin', blackout: 'ban', frequency: 'logs', slot: 'clock', reserved: 'megaphone' };

function Legend() {
  const item = (icon: IconName, label: string, tint?: string) => (
    <span className="text-micro" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: tint ?? 'var(--color-ink-muted)' }}>
      <Icon name={icon} size={12} /> {label}
    </span>
  );
  return (
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 10 }}>
      {item('calendar-sync', 'series (agent)')}
      {item('lock', 'owner-locked', 'var(--color-warning)')}
      {item('pin', 'pinned post')}
      {item('ban', 'blackout', 'var(--color-danger)')}
      {item('logs', 'posts per day')}
      {item('clock', 'planned slot')}
      {item('megaphone', 'reserved (ad / promo)')}
    </div>
  );
}

function laneHead(r: ScheduleResource, now: Date) {
  return (
    <div style={{ minWidth: 0 }}>
      <ResourceLabel refId={r.ref} strong />
      <div className="text-micro tabular-nums" style={{ color: 'var(--color-ink-dim)', marginTop: 2 }} title={`Times on this lane are in ${r.timezone}`}>
        {r.timezone} · {tzShort(r.timezone, now)}
      </div>
    </div>
  );
}

/** The anchor channel's calendar day of the server's now (the grid highlights it). */
function anchorToday(data: ScheduleResponse): string {
  const tz = data.resources.find((r) => r.ref === `telegram:${data.anchor}`)?.timezone ?? 'Europe/Kyiv';
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(data.now)); } catch { return ''; }
}

function WeekGrid({ data }: { data: ScheduleResponse }) {
  const now = new Date(data.now);
  const today = anchorToday(data);
  const cols = `${LANE_W}px repeat(${data.days.length}, minmax(118px, 1fr))`;
  return (
    <div className="panel" style={{ overflowX: 'auto', padding: 0 }}>
      <div style={{ display: 'grid', gridTemplateColumns: cols, minWidth: LANE_W + data.days.length * 118 }}>
        <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--color-hairline-soft)' }} className="text-eyebrow">Resource</div>
        {data.days.map((day) => (
          <div key={day} className="text-micro tabular-nums" style={{
            padding: '8px 8px', borderBottom: '1px solid var(--color-hairline-soft)', borderLeft: '1px solid var(--color-hairline-soft)',
            color: day === today ? 'var(--color-accent)' : 'var(--color-ink-muted)', fontWeight: 500,
          }}>{fmtDayHead(day)}{day === today ? ' · today' : ''}</div>
        ))}
        {data.resources.map((r) => (
          <Lane key={r.ref} r={r} data={data} now={now} />
        ))}
      </div>
    </div>
  );
}

function Lane({ r, data, now }: { r: ScheduleResource; data: ScheduleResponse; now: Date }) {
  return (
    <>
      <div style={{ padding: '10px', borderBottom: '1px solid var(--color-hairline-soft)' }}>{laneHead(r, now)}</div>
      {data.days.map((day) => {
        const entries = cellEntries(data, r.ref, day);
        return (
          <div key={day} style={{ padding: 6, borderBottom: '1px solid var(--color-hairline-soft)', borderLeft: '1px solid var(--color-hairline-soft)', display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            {entries.map((e) => <EntryPill key={e.key} e={e} />)}
          </div>
        );
      })}
    </>
  );
}

function EntryPill({ e }: { e: Entry }) {
  const tint = e.kind === 'blackout' ? 'var(--color-danger)' : e.locked ? 'var(--color-warning)' : e.kind === 'series' || e.kind === 'pin' ? 'var(--color-accent)' : 'var(--color-ink-dim)';
  const bg = e.kind === 'blackout' ? 'var(--color-danger-soft)' : 'var(--color-surface-2)';
  const title = [
    e.kind === 'blackout' ? `No posts ${e.time}–${e.until}` : `${e.time ? `${e.time} · ` : ''}${e.title}`,
    e.sub, e.locked && e.kind === 'series' ? 'set by the owner (locked)' : null, e.status ? `status: ${e.status.replace(/_/g, ' ')}` : null,
  ].filter(Boolean).join(' · ');
  return (
    <div title={title} style={{ background: bg, borderLeft: `2px solid ${tint}`, borderRadius: 6, padding: '3px 6px', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
        <span style={{ color: tint, display: 'inline-flex', flexShrink: 0 }}><Icon name={e.locked && e.kind === 'series' ? 'lock' : KIND_ICON[e.kind]} size={11} /></span>
        {e.time && <span className="text-micro tabular-nums" style={{ color: 'var(--color-ink)', fontWeight: 500, flexShrink: 0 }}>{e.kind === 'blackout' ? `${e.time}–${e.until}` : e.time}</span>}
        <span className="text-micro" style={{ color: 'var(--color-ink-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{e.title}</span>
      </div>
      {e.status && (
        <div style={{ marginTop: 2 }}><Badge tone={SLOT_TONE[e.status as keyof typeof SLOT_TONE] ?? 'neutral'}>{e.status.replace(/_/g, ' ')}</Badge></div>
      )}
    </div>
  );
}

function DayList({ data }: { data: ScheduleResponse }) {
  const now = new Date(data.now);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {data.days.map((day) => {
        const lanes = data.resources.map((r) => ({ r, entries: cellEntries(data, r.ref, day) })).filter((l) => l.entries.length);
        return (
          <div key={day} className="panel" style={{ padding: '10px 12px' }}>
            <div className="text-body-sm" style={{ fontWeight: 600, color: 'var(--color-ink)', marginBottom: 8 }}>{fmtDayHead(day)}</div>
            {!lanes.length && <div className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>Nothing scheduled.</div>}
            {lanes.map(({ r, entries }) => (
              <div key={r.ref} style={{ marginBottom: 10 }}>
                <div style={{ marginBottom: 4 }}>{laneHead(r, now)}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{entries.map((e) => <EntryPill key={e.key} e={e} />)}</div>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ── series ──

function zoneOf(data: ScheduleResponse, ref: string): string {
  const tz = data.resources.find((r) => r.ref === ref)?.timezone;
  return tz ? `${tz} (${tzShort(tz, new Date(data.now))})` : '';
}

function SeriesList({ data, handle, onEdit }: { data: ScheduleResponse; handle: string; onEdit: (s: ScheduleSeries) => void }) {
  const unlock = useUnlockSeries(handle);
  const confirm = useConfirm();
  const doUnlock = async (s: ScheduleSeries) => {
    const ok = await confirm(`Unlock series "${s.name}"?`, {
      danger: false, confirmLabel: 'Unlock',
      details: <span className="text-body-sm">The agent may change, move or pause this series again. Your current settings stay until it does.</span>,
    });
    if (!ok) return;
    unlock.mutate(s.name, { onSuccess: () => toast.success(`"${s.name}" is run by the agent again`), onError: (e) => toast.error(errorText(e)) });
  };
  return (
    <SectionCard title="Series" icon="calendar-sync">
      {!data.series.length && <EmptyState icon="calendar" title="No series" note="Series are recurring posts from the playbook. Add one, or ask the agent in the chat." />}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {data.series.map((s, i) => (
          <div key={s.name} className="card row-lift compose-rise" style={{ padding: '10px 12px', display: 'flex', gap: 10, alignItems: 'flex-start', animationDelay: `${i * 30}ms` }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="text-body-sm" style={{ fontWeight: 600, color: 'var(--color-ink)', overflowWrap: 'anywhere' }}>{s.name}</span>
                {s.locked
                  ? <Badge tone="warning" title="Set by the owner: the agent cannot change it"><Icon name="lock" size={10} /> owner</Badge>
                  : <Badge tone="neutral" title="The agent may change this series">{s.origin === 'migration' ? 'migrated' : 'agent'}</Badge>}
                {!s.active && <Badge tone="neutral">paused</Badge>}
                {s.source_mode === 'required' && s.source && <Badge tone="accent">required source</Badge>}
              </div>
              <div className="text-micro tabular-nums" style={{ color: 'var(--color-ink-muted)', marginTop: 3 }}>
                {cadenceLabel(s.cadence)} · {s.format} · {sourceLabel(s.source)}
              </div>
              <div className="text-micro" style={{ color: 'var(--color-ink-dim)', marginTop: 2, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <ResourceLabel refId={s.resource_ref} /> <span>· {zoneOf(data, s.resource_ref)}</span>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              <button type="button" className="btn-act" title="Edit (locks the series)" aria-label={`Edit ${s.name}`} onClick={() => onEdit(s)}><Icon name="pencil" size={14} /></button>
              {s.locked && (
                <button type="button" className="btn-act" title="Unlock: hand back to the agent" aria-label={`Unlock ${s.name}`} disabled={unlock.isPending} onClick={() => doUnlock(s)}>
                  <Icon name="unlock" size={14} />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

// ── rules ──

const KIND_LABEL: Record<RuleKind, string> = { pin: 'Pin', blackout: 'Blackout', frequency: 'Frequency' };

function RuleList({ data, handle, onEdit }: { data: ScheduleResponse; handle: string; onEdit: (r: ScheduleRule) => void }) {
  const patch = usePatchRule(handle);
  const confirm = useConfirm();
  const setActive = async (r: ScheduleRule, active: boolean) => {
    if (!active && !(await confirm('Disable this rule?', { confirmLabel: 'Disable', details: <span className="text-body-sm">{ruleLabel(r)} on {r.resource_ref}</span> }))) return;
    patch.mutate({ id: r.id, patch: { active } }, {
      onSuccess: (res) => toast.success(warningsText(res.warnings) ?? (active ? 'Rule enabled' : 'Rule disabled')),
      onError: (e) => toast.error(errorText(e)),
    });
  };
  const rules = [...data.rules].sort((a, b) => Number(b.active) - Number(a.active));
  return (
    <SectionCard title="Rules" icon="pin">
      {!rules.length && <EmptyState icon="pin" title="No rules" note="Pin a post to a time, block a window or set posts per day. The planner must follow them." />}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rules.map((r, i) => (
          <div key={r.id} className="card row-lift compose-rise" style={{ padding: '10px 12px', display: 'flex', gap: 10, alignItems: 'flex-start', opacity: r.active ? 1 : 0.6, animationDelay: `${i * 30}ms` }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <Badge tone={r.kind === 'blackout' ? 'danger' : r.kind === 'pin' ? 'accent' : 'neutral'}>{KIND_LABEL[r.kind]}</Badge>
                {!r.active && <Badge tone="neutral">disabled</Badge>}
                {r.created_by === 'chat' && <Badge tone="neutral" title="Added from the chat">chat</Badge>}
              </div>
              <div className="text-body-sm tabular-nums" style={{ color: 'var(--color-ink)', marginTop: 4, overflowWrap: 'anywhere' }}>{ruleLabel(r)}</div>
              {r.brief && <div className="text-micro" style={{ color: 'var(--color-ink-muted)', marginTop: 2, overflowWrap: 'anywhere' }}>{r.brief}</div>}
              <div className="text-micro" style={{ color: 'var(--color-ink-dim)', marginTop: 2, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <ResourceLabel refId={r.resource_ref} /> <span>· {zoneOf(data, r.resource_ref)}</span>
                {validityLabel(r) && <span>· {validityLabel(r)}</span>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              <button type="button" className="btn-act" title="Edit" aria-label="Edit rule" onClick={() => onEdit(r)}><Icon name="pencil" size={14} /></button>
              {r.active
                ? <button type="button" className="btn-act btn-act-danger" title="Disable" aria-label="Disable rule" disabled={patch.isPending} onClick={() => setActive(r, false)}><Icon name="ban" size={14} /></button>
                : <button type="button" className="btn-act" title="Enable" aria-label="Enable rule" disabled={patch.isPending} onClick={() => setActive(r, true)}><Icon name="play" size={14} /></button>}
            </div>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

// ── shared form bits ──

function DayPicker({ value, onChange }: { value: number[] | null; onChange: (v: number[] | null) => void }) {
  const on = (d: number) => !value || value.includes(d);
  const toggle = (d: number) => {
    const cur = value ?? [0, 1, 2, 3, 4, 5, 6];
    const next = cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d];
    onChange(next.length === 7 ? null : next.sort((a, b) => a - b));
  };
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {WEEK.map((d) => (
        <button key={d} type="button" aria-pressed={on(d)} className={`chip${on(d) ? ' is-active' : ''}`}
          style={{ border: 0, cursor: 'pointer', fontSize: 11, padding: '3px 9px' }} onClick={() => toggle(d)}>
          {DAY_SHORT[d]}
        </button>
      ))}
      <button type="button" className="btn-tiny" onClick={() => onChange([1, 2, 3, 4, 5])}>Weekdays</button>
      <button type="button" className="btn-tiny" onClick={() => onChange(null)}>Every day</button>
    </div>
  );
}

function Problems({ error }: { error: unknown }) {
  if (!error) return null;
  const b = errorBody(error);
  const list = Array.isArray(b?.details) ? (b!.details as unknown[]).map(String) : [errorText(error)];
  return (
    <div className="callout-danger" style={{ marginTop: 6 }}>
      <ul style={{ margin: 0, paddingLeft: 18 }}>{list.map((x, i) => <li key={i}>{x}</li>)}</ul>
    </div>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>{children}</div>;
}

const num = (s: string): number | null => (s.trim() === '' ? null : Math.max(0, Math.min(24, Math.round(Number(s)))));

// ── rule form ──

function RuleModal({ handle, data, rule, onClose }: { handle: string; data: ScheduleResponse; rule: ScheduleRule | null; onClose: () => void }) {
  const add = useAddRule(handle);
  const patch = usePatchRule(handle);
  const [f, setF] = useState<RuleInput>(() => rule ? { ...rule } : { resource_ref: data.resources[0]?.ref, kind: 'pin', days: null, at_local: '19:00', until_local: '', window_min: 20 });
  const set = (p: Partial<RuleInput>) => setF((x) => ({ ...x, ...p }));
  const res = data.resources.find((r) => r.ref === f.resource_ref) ?? data.resources[0];
  const seriesHere = data.series.filter((s) => s.resource_ref === f.resource_ref);
  const pending = add.isPending || patch.isPending;
  const error = add.error ?? patch.error;

  const submit = () => {
    const body: RuleInput = {
      resource_ref: f.resource_ref, kind: f.kind, days: f.days ?? null, at_local: f.kind === 'frequency' ? null : f.at_local || null,
      until_local: f.kind === 'blackout' ? f.until_local || null : null, window_min: f.window_min ?? 20,
      format: f.kind === 'pin' ? f.format || null : null, series_name: f.kind === 'pin' ? f.series_name || null : null,
      brief: f.kind === 'pin' ? (f.brief?.trim() || null) : null,
      per_day_min: f.kind === 'frequency' ? f.per_day_min ?? null : null, per_day_max: f.kind === 'frequency' ? f.per_day_max ?? null : null,
      valid_from: f.valid_from || null, valid_until: f.valid_until || null, note: f.note?.trim() || null,
    };
    const done = { onSuccess: (r: { warnings: string[] }) => { toast.success(warningsText(r.warnings) ?? 'Rule saved'); onClose(); } };
    if (rule) patch.mutate({ id: rule.id, patch: body }, done);
    else add.mutate(body, done);
  };

  return (
    <Modal open onClose={onClose} title={rule ? 'Edit rule' : 'Add rule'} subtitle="The planner must follow it; times are in the resource's time zone" icon="pin" size="lg">
      <Field label="Resource" hint={res ? `${res.timezone} · ${tzShort(res.timezone, new Date(data.now))}` : undefined}>
        <select className="input-field" style={input} value={f.resource_ref} onChange={(e) => set({ resource_ref: e.target.value, series_name: null })} disabled={!!rule}>
          {data.resources.map((r) => <option key={r.ref} value={r.ref}>{r.ref}</option>)}
        </select>
      </Field>
      <Field label="Kind">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {(['pin', 'blackout', 'frequency'] as const).map((k) => (
            <button key={k} type="button" aria-pressed={f.kind === k} className={`chip${f.kind === k ? ' is-active' : ''}`}
              style={{ border: 0, cursor: 'pointer', padding: '4px 10px' }} onClick={() => set({ kind: k })} disabled={!!rule && rule.kind !== k}>
              {k === 'pin' ? 'Pinned post' : k === 'blackout' ? 'Blackout' : 'Posts per day'}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Days"><DayPicker value={f.days ?? null} onChange={(days) => set({ days })} /></Field>
      {f.kind !== 'frequency' && (
        <Row>
          <Field label={f.kind === 'pin' ? 'Time' : 'From'}>
            <input type="time" className="input-field tabular-nums" style={{ ...input, colorScheme: 'dark' }} value={f.at_local ?? ''} onChange={(e) => set({ at_local: e.target.value })} />
          </Field>
          {f.kind === 'blackout' && (
            <Field label="Until" hint="may be the next day">
              <input type="time" className="input-field tabular-nums" style={{ ...input, colorScheme: 'dark' }} value={f.until_local ?? ''} onChange={(e) => set({ until_local: e.target.value })} />
            </Field>
          )}
          {f.kind === 'pin' && (
            <Field label="Keep clear (min)" hint="0–120">
              <input type="number" min={0} max={120} className="input-field tabular-nums" style={input} value={f.window_min ?? 20}
                onChange={(e) => set({ window_min: Math.max(0, Math.min(120, Number(e.target.value) || 0)) })} />
            </Field>
          )}
        </Row>
      )}
      {f.kind === 'pin' && (
        <>
          <Row>
            <Field label="Series" hint="optional">
              <select className="input-field" style={input} value={f.series_name ?? ''} onChange={(e) => set({ series_name: e.target.value || null })}>
                <option value="">— none —</option>
                {seriesHere.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
              </select>
            </Field>
            <Field label="Format" hint={f.series_name ? 'default: the series format' : undefined}>
              <select className="input-field" style={input} value={f.format ?? ''} onChange={(e) => set({ format: e.target.value || null })}>
                <option value="">{f.series_name ? '— from the series —' : '— choose —'}</option>
                {(res?.formats ?? []).map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            </Field>
          </Row>
          <Field label="Brief" hint={f.series_name ? 'optional with a series' : 'what the post is about (10+ characters)'}>
            <textarea className="input-field" style={{ ...input, minHeight: 64, resize: 'vertical', fontFamily: 'inherit' }} maxLength={600}
              value={f.brief ?? ''} onChange={(e) => set({ brief: e.target.value })} />
          </Field>
        </>
      )}
      {f.kind === 'frequency' && (
        <Row>
          <Field label="Min posts a day">
            <input type="number" min={0} max={24} className="input-field tabular-nums" style={input} value={f.per_day_min ?? ''} onChange={(e) => set({ per_day_min: num(e.target.value) })} />
          </Field>
          <Field label="Max posts a day">
            <input type="number" min={0} max={24} className="input-field tabular-nums" style={input} value={f.per_day_max ?? ''} onChange={(e) => set({ per_day_max: num(e.target.value) })} />
          </Field>
        </Row>
      )}
      <Row>
        <Field label="Valid from" hint="optional">
          <input type="date" className="input-field tabular-nums" style={{ ...input, colorScheme: 'dark' }} value={f.valid_from ?? ''} onChange={(e) => set({ valid_from: e.target.value || null })} />
        </Field>
        <Field label="Valid until" hint="optional">
          <input type="date" className="input-field tabular-nums" style={{ ...input, colorScheme: 'dark' }} value={f.valid_until ?? ''} onChange={(e) => set({ valid_until: e.target.value || null })} />
        </Field>
      </Row>
      <Field label="Note" hint="optional">
        <input className="input-field" style={input} maxLength={300} value={f.note ?? ''} onChange={(e) => set({ note: e.target.value })} />
      </Field>
      <Problems error={error} />
      <div className="modal-foot">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={pending} onClick={submit}>{rule ? 'Save rule' : 'Add rule'}</button>
      </div>
    </Modal>
  );
}

// ── series form ──

type SourceKind = 'none' | SeriesSource['kind'];

function SeriesModal({ handle, data, series, onClose }: { handle: string; data: ScheduleResponse; series: ScheduleSeries | null; onClose: () => void }) {
  const put = usePutSeries(handle);
  const parsed = series ? parseCadence(series.cadence) : null;
  const [name, setName] = useState(series?.name ?? '');
  const [ref, setRef] = useState(series?.resource_ref ?? data.resources[0]?.ref ?? '');
  const [days, setDays] = useState<number[] | null>(parsed?.days ?? null);
  const [times, setTimes] = useState(parsed?.times.join(', ') ?? '19:00');
  const [format, setFormat] = useState(series?.format ?? '');
  const [brief, setBrief] = useState(series?.brief ?? '');
  const [active, setActive] = useState(series?.active ?? true);
  const [mode, setMode] = useState<'suggested' | 'required'>(series?.source_mode ?? 'suggested');
  const [kind, setKind] = useState<SourceKind>(series?.source?.kind ?? 'none');
  const [value, setValue] = useState(() => {
    const s = series?.source;
    return s?.kind === 'library' ? s.table : s?.kind === 'api' ? s.source : s?.kind === 'feed' ? s.ref : s?.kind === 'network_highlights' ? s.scope : '';
  });
  const res = data.resources.find((r) => r.ref === ref);
  const cad = useMemo(() => buildCadence(days, times), [days, times]);
  const [localError, setLocalError] = useState<string | null>(null);

  const source = (): SeriesSource | null => {
    switch (kind) {
      case 'library': return { kind, table: value };
      case 'api': return { kind, source: value };
      case 'feed': return { kind, ref: value };
      case 'network_highlights': return { kind, scope: value === 'channel' ? 'channel' : 'network' };
      case 'free': return { kind };
      default: return null;
    }
  };
  const options = kind === 'library' ? data.sourceOptions.tables : kind === 'api' ? data.sourceOptions.apis : kind === 'feed' ? data.sourceOptions.feeds : kind === 'network_highlights' ? ['network', 'channel'] : [];

  const submit = () => {
    if ('error' in cad) return setLocalError(cad.error);
    if (!name.trim() || name.trim().length < 3) return setLocalError('The name needs at least 3 characters');
    if (!format) return setLocalError('Choose a format');
    if (brief.trim().length < 10) return setLocalError('The brief needs at least 10 characters');
    if (['library', 'api', 'feed'].includes(kind) && !value) return setLocalError('Choose the source');
    setLocalError(null);
    put.mutate({ name: name.trim(), body: { cadence: cad.cadence, resource_ref: ref, format, brief: brief.trim(), active, source: source(), source_mode: mode } }, {
      onSuccess: (r) => { toast.success(`Saved as playbook v${r.version} — the series is now yours (locked)`); onClose(); },
    });
  };

  return (
    <Modal open onClose={onClose} title={series ? `Edit series "${series.name}"` : 'Add series'} subtitle="Saving locks the series: the agent cannot change it until you unlock it" icon="calendar-sync" size="lg">
      <Row>
        <Field label="Name">
          <input className="input-field" style={input} maxLength={80} value={name} disabled={!!series} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Resource" hint={res ? `${res.timezone} · ${tzShort(res.timezone, new Date(data.now))}` : undefined}>
          <select className="input-field" style={input} value={ref} onChange={(e) => { setRef(e.target.value); setFormat(''); }}>
            {data.resources.map((r) => <option key={r.ref} value={r.ref}>{r.ref}</option>)}
          </select>
        </Field>
      </Row>
      <Field label="Days"><DayPicker value={days} onChange={setDays} /></Field>
      <Row>
        <Field label="Times" hint={'error' in cad ? cad.error : cadenceLabel(cad.cadence)}>
          <input className="input-field tabular-nums" style={input} placeholder="19:00, 21:30" value={times} onChange={(e) => setTimes(e.target.value)} />
        </Field>
        <Field label="Format">
          <select className="input-field" style={input} value={format} onChange={(e) => setFormat(e.target.value)}>
            <option value="">— choose —</option>
            {(res?.formats ?? []).map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </Field>
      </Row>
      <Field label="Brief">
        <textarea className="input-field" style={{ ...input, minHeight: 72, resize: 'vertical', fontFamily: 'inherit' }} maxLength={600} value={brief} onChange={(e) => setBrief(e.target.value)} />
      </Field>
      <Row>
        <Field label="Source">
          <select className="input-field" style={input} value={kind} onChange={(e) => { setKind(e.target.value as SourceKind); setValue(''); }}>
            <option value="none">none</option>
            <option value="library">library dataset</option>
            <option value="api">API</option>
            <option value="feed">card feed</option>
            <option value="network_highlights">network highlights</option>
            <option value="free">free choice</option>
          </select>
        </Field>
        {options.length > 0 && (
          <Field label={kind === 'network_highlights' ? 'Scope' : 'Which'}>
            <select className="input-field" style={input} value={value} onChange={(e) => setValue(e.target.value)}>
              <option value="">— choose —</option>
              {options.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </Field>
        )}
        {kind !== 'none' && kind !== 'free' && (
          <Field label="Source use">
            <select className="input-field" style={input} value={mode} onChange={(e) => setMode(e.target.value as 'suggested' | 'required')}>
              <option value="suggested">suggested (agent may pick another)</option>
              <option value="required">required (only this source)</option>
            </select>
          </Field>
        )}
      </Row>
      <label className="text-body-sm" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active (uncheck to pause)
      </label>
      {localError && <div className="callout-danger" style={{ marginTop: 10 }}>{localError}</div>}
      <Problems error={put.error} />
      <div className="modal-foot">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={put.isPending} onClick={submit}>{series ? 'Save and lock' : 'Add series'}</button>
      </div>
    </Modal>
  );
}
