import { createFileRoute, Link } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { PageHeader } from '../components/ui/PageHeader';
import { useCrumbs } from '../nav/hooks';
import { SectionCard, StatStrip, StatTile, EmptyState } from '../components/ui/primitives';
import { Badge } from '../components/ui/Badge';
import { Icon } from '../components/ui/Icon';
import { CompactCard } from '../components/ui/CompactCard';
import { useConfirm } from '../components/ui/ConfirmDialog';
import { describeError } from '../components/ui/Toast';
import { CardEditorModal } from '../components/editor/CardEditorModal';
import { ModeSwitch, RUN_TONE, SlotCounts, SlotRow, fmtDuration, fmtUsd, runStatusLabel } from '../components/editor/EditorUi';
import '../components/editor/editor.css';
import {
  useAddEditorMemory, useEditorChannel, useEditorMemory, useEditorPlans, useEditorRuns, useReplan, useRetireEditorMemory,
} from '../api/editor';
import { fmtDate } from '../lib/format';
import { feedsOf, planScheduleNote } from '../lib/slot-plan';
import { PlanStamp } from '../components/editor/SlotPlan';
import type { EditorChannel, EditorMemoryEntry } from '../api/types';

export const Route = createFileRoute('/app/editor_/$channel')({ component: EditorChannelPage });

function EditorChannelPage() {
  const crumbs = useCrumbs('editor-channel');
  const { channel: key } = Route.useParams();
  const ch = useEditorChannel(key);
  const plans = useEditorPlans(ch.data?.today.date, key);
  const replan = useReplan();
  const [editing, setEditing] = useState(false);

  if (ch.error) return <div className="callout-danger">{describeError(ch.error)}</div>;
  if (!ch.data) return <div className="panel compose-rise" style={{ height: 120, opacity: 0.55 }} />;
  const c = ch.data;
  const active = plans.data?.plans.find((p) => p.status === 'active');
  // Spec 034 FR-012 / FR-013: when and by which run, how this channel plans, the day's earlier plans.
  const schedule = { planHour: c.planHour, timezone: c.timezone, approval: c.mode === 'approve', batchHour: 20 };
  const history = (plans.data?.plans ?? []).filter((p) => p.status === 'superseded')
    .map((p) => ({ id: p.id, plannedAt: p.createdAt, runId: p.runId, runRole: p.runRole ?? null, rationale: p.rationale, slots: p.slots.length }));
  const feeds = feedsOf(c);
  const estimate = plans.data?.previewEstimates?.[c.channelKey] ?? null;

  return (
    <div>
      <PageHeader
        crumbs={crumbs}
        title={c.title || c.channelKey}
        subtitle={<><span className="mono">{c.channelKey}</span> · {c.timezone} · plan at {String(c.planHour).padStart(2, '0')}:00</>}
        actions={<>
          <button className="btn-secondary"
            disabled={replan.isPending || c.mode === 'off'}
            title={c.mode === 'off' ? 'Switch to shadow first' : 'Run the planner now: only future planned slots are replaced; written, running and pinned posts stay'}
            onClick={() => replan.mutate({ key: c.channelKey })}>
            <Icon name="calendar-sync" size={14} /> Replan the rest of today
          </button>
          {c.mode === 'approve' && (
            <button className="btn-secondary"
              disabled={replan.isPending} title="Approval mode plans the next day the evening before; posts already written for tomorrow stay"
              onClick={() => replan.mutate({ key: c.channelKey, date: 'tomorrow' })}>
              <Icon name="calendar" size={14} /> Replan tomorrow
            </button>
          )}
          <button className="btn-primary" onClick={() => setEditing(true)}>
            <Icon name="pencil" size={14} /> Edit card
          </button>
        </>}
      />

      <div className="compose-rise" style={{ marginBottom: 16 }}>
        <StatStrip label="Channel numbers">
          <div className="stat-tile" style={{ flex: '2 1 300px' }}>
            <div className="stat-label" style={{ marginBottom: 10 }}>Mode</div>
            <ModeSwitch channelKey={c.channelKey} mode={c.mode} title={c.title} />
          </div>
          <StatTile label="Spend today" value={fmtUsd(c.today.spendUsd)} delta={`${c.today.runs} runs · cap ${c.dailyBudgetUsd == null ? 'env default' : fmtUsd(c.dailyBudgetUsd)}`} />
          <StatTile label="Posts per day" value={`${c.postsPerDayMin}–${c.postsPerDayMax}`} delta={`quiet ${c.quietStartHour}:00–${c.quietEndHour}:00 · gap ${c.minGapMinutes}m`} />
        </StatStrip>
      </div>

      <CardSummary c={c} />

      <SectionCard title={`Plan · ${c.today.date}`} flush delay={60} style={{ marginBottom: 16 }}
        action={<SlotCounts slots={c.today.slots} />}>
        <div className="panel-note">
          <PlanStamp tz={c.timezone} data={{
            planDate: c.today.date, plannedAt: active?.createdAt ?? null, runId: active?.runId ?? null, runRole: active?.runRole ?? null,
            schedule: c.mode === 'off' ? null : schedule, history,
          }} />
          {active?.rationale && <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)', margin: 0 }}>{active.rationale}</p>}
        </div>
        {!active || active.slots.length === 0
          ? <EmptyState icon="calendar" title="No plan for today yet" note={c.mode === 'off' ? 'The channel is off.' : `${planScheduleNote(schedule)} Or use “Replan the rest of today”.`} />
          : active.slots.map((s) => <SlotRow key={s.id} slot={s} tz={c.timezone} feeds={feeds} estimateUsd={estimate} />)}
      </SectionCard>

      <MemorySection channelKey={c.channelKey} />
      <RunsSection channelKey={c.channelKey} />

      {editing && <CardEditorModal open onClose={() => setEditing(false)} card={c} />}
    </div>
  );
}

function CardSummary({ c }: { c: EditorChannel }) {
  const row = (label: string, value: ReactNode) => (
    <div className="kv-row">
      <span className="kv-key">{label}</span>
      <span className="kv-value">{value}</span>
    </div>
  );
  const chips = (xs: string[]) => xs.length
    ? <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>{xs.map((x) => <span key={x} className="chip">{x}</span>)}</span>
    : <span style={{ color: 'var(--color-ink-dim)' }}>—</span>;

  return (
    <SectionCard title="Card" delay={30} style={{ marginBottom: 16 }}>
      <p className="text-body-sm" style={{ margin: '0 0 12px', color: c.brief ? 'var(--color-ink)' : 'var(--color-ink-dim)', whiteSpace: 'pre-wrap' }}>{c.brief || 'No brief yet.'}</p>
      <div className="kv-list">
        {row('Formats', chips(Object.entries(c.formats).map(([f, w]) => `${f} ${w}`)))}
        {row('Hashtags', <>{chips(c.hashtags.map((h) => `#${h}`))} <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{c.hashtagMin}–{c.hashtagMax} per post</span></>)}
        {row('Style', `links ${c.linkStyle} · emoji ${c.emojiPolicy}${c.footer ? ` · footer “${c.footer}”` : ''}`)}
        {row('Sources', c.sources.length
          ? <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{c.sources.map((s) => <span key={s.id}><span className="chip mono">{s.kind}</span> {s.ref}</span>)}</span>
          : '—')}
        {row('Skills', chips(c.skills))}
        {row('Banned terms', chips(c.bannedTerms))}
        {row('Tools', c.toolsAllow ? chips(c.toolsAllow) : 'role defaults')}
        {row('Models', Object.keys(c.models).length ? chips(Object.entries(c.models).map(([r, m]) => `${r}: ${m}`)) : 'defaults')}
        {row('Explore ratio', <span className="mono">{String(c.exploreRatio)}</span>)}
        {row('Auto-duplicate (legacy)', c.crosspost === false ? 'off — Telegram only' : 'on — live posts are duplicated to the Meta targets while auto-duplication is on')}
      </div>
    </SectionCard>
  );
}

const KIND_TONE: Record<EditorMemoryEntry['kind'], 'accent' | 'warning' | 'neutral'> = { rule: 'accent', avoid: 'warning', insight: 'neutral' };

function MemorySection({ channelKey }: { channelKey: string }) {
  const memory = useEditorMemory(channelKey);
  const add = useAddEditorMemory(channelKey);
  const retire = useRetireEditorMemory(channelKey);
  const confirm = useConfirm();
  const [kind, setKind] = useState<EditorMemoryEntry['kind']>('rule');
  const [text, setText] = useState('');
  const [showHistory, setShowHistory] = useState(false);

  const all = memory.data ?? [];
  const activeEntries = all.filter((m) => m.active);
  const history = all.filter((m) => !m.active);

  const submit = () => {
    if (text.trim().length < 3) return;
    add.mutate({ kind, text: text.trim() }, { onSuccess: () => setText('') });
  };

  return (
    <SectionCard title="Memory" delay={90} style={{ marginBottom: 16 }}
      action={history.length > 0 ? <button className="btn-ghost" aria-expanded={showHistory} onClick={() => setShowHistory((v) => !v)}>{showHistory ? 'Hide' : 'Show'} history ({history.length})</button> : undefined}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        <select className="input-field" value={kind} onChange={(e) => setKind(e.target.value as EditorMemoryEntry['kind'])} style={{ width: 120 }}>
          <option value="rule">rule</option><option value="avoid">avoid</option><option value="insight">insight</option>
        </select>
        <input className="input-field" style={{ flex: 1, minWidth: 220 }} placeholder="A rule the agents must always follow…" value={text}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
        <button className="btn-primary" disabled={add.isPending || text.trim().length < 3} onClick={submit}>Add</button>
      </div>
      {activeEntries.length === 0
        ? <EmptyState icon="bots" title="No active memory" note="Owner rules are injected into every planner, executor and reviewer prompt. The reviewer adds insights weekly." />
        : <div className="compact-grid">
            {activeEntries.map((m, i) => {
              const badges = <><Badge tone={KIND_TONE[m.kind]}>{m.kind}</Badge><Badge tone="neutral">{m.createdBy}</Badge></>;
              const onRetire = async (close: () => void) => {
                if (await confirm(`retire the memory entry “${m.text.slice(0, 60)}”`, { confirmLabel: 'Retire' })) retire.mutate(m.id, { onSuccess: close });
              };
              return (
                <CompactCard key={m.id} delay={Math.min(i, 12) * 25} hint="Open the memory entry"
                  top={badges}
                  meta={<span className="tabular-nums">{fmtDate(m.createdAt)}</span>}
                  body={m.text}
                  dialog={{
                    size: 'md', icon: 'bots', title: `Memory ${m.kind}`, subtitle: `${m.createdBy} · ${fmtDate(m.createdAt)}`,
                    body: () => (
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>{badges}</div>
                        <div className="text-body-sm" style={{ color: 'var(--color-ink)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.55 }}>{m.text}</div>
                      </div>
                    ),
                    actions: (close) => (
                      <button type="button" className="btn-ghost" disabled={retire.isPending} onClick={() => onRetire(close)}
                        style={{ color: 'var(--color-danger)', marginRight: 'auto' }}>
                        <Icon name="trash" size={14} /> Retire
                      </button>
                    ),
                  }} />
              );
            })}
          </div>}
      {showHistory && history.length > 0 && (
        <div className="inset" style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="text-overline">Retired entries</div>
          {history.map((m) => (
            <div key={m.id} className="text-micro" style={{ color: 'var(--color-ink-dim)', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <span className="mono tabular-nums">{fmtDate(m.createdAt)}</span>
              <span>{m.kind} · {m.createdBy}</span>
              <span style={{ color: 'var(--color-ink-muted)', overflowWrap: 'anywhere', minWidth: 0 }}>{m.text}</span>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function RunsSection({ channelKey }: { channelKey: string }) {
  const runs = useEditorRuns({ channel: channelKey, limit: 30 });
  const data = runs.data ?? [];
  return (
    <SectionCard title="Recent runs" delay={120}>
      {data.length === 0
        ? <EmptyState icon="logs" title="No runs yet" note="Planner, executor and reviewer runs of this channel are listed here." />
        : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr>
                <th>Started</th>
                <th>Role</th>
                <th>Status</th>
                <th className="num">Steps</th>
                <th className="num">Tokens</th>
                <th className="num">Cost</th>
                <th className="num">Duration</th>
                <th style={{ textAlign: 'right' }}>Trace</th>
              </tr></thead>
              <tbody>
                {data.map((r) => (
                  <tr key={r.id}>
                    <td className="mono tabular-nums">{fmtDate(r.startedAt)}</td>
                    <td>{r.role}</td>
                    <td><Badge tone={RUN_TONE[r.status]} title={r.error ?? undefined}>{runStatusLabel(r.status)}</Badge></td>
                    <td className="num">{r.steps}</td>
                    <td className="num">{(r.promptTokens + r.completionTokens).toLocaleString()}</td>
                    <td className="num">{fmtUsd(r.costUsd)}</td>
                    <td className="num">{fmtDuration(r.startedAt, r.finishedAt)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <Link to="/app/editor/run/$id" params={{ id: r.id }} className="btn-act" title="Open trace" aria-label="Open trace">
                        <Icon name="eye" size={14} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </SectionCard>
  );
}
