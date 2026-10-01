import { createFileRoute, Link } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { PageHeader } from '../components/ui/PageHeader';
import { SectionCard, StatTile, EmptyState } from '../components/ui/primitives';
import { Badge } from '../components/ui/Badge';
import { Icon } from '../components/ui/Icon';
import { TableAction, RowActions } from '../components/ui/table';
import { useConfirm } from '../components/ui/ConfirmDialog';
import { describeError } from '../components/ui/Toast';
import { CardEditorModal } from '../components/editor/CardEditorModal';
import { ModeSwitch, MODE_TONE, RUN_TONE, SlotCounts, SlotRow, fmtDuration, fmtUsd } from '../components/editor/EditorUi';
import {
  useAddEditorMemory, useEditorChannel, useEditorMemory, useEditorPlans, useEditorRuns, useReplan, useRetireEditorMemory,
} from '../api/editor';
import { fmtDate } from '../lib/format';
import type { EditorChannel, EditorMemoryEntry } from '../api/types';

export const Route = createFileRoute('/app/editor_/$channel')({ component: EditorChannelPage });

function EditorChannelPage() {
  const { channel: key } = Route.useParams();
  const ch = useEditorChannel(key);
  const plans = useEditorPlans(ch.data?.today.date, key);
  const replan = useReplan();
  const [editing, setEditing] = useState(false);

  if (ch.error) return <div className="callout-danger">{describeError(ch.error)}</div>;
  if (!ch.data) return <div className="panel compose-rise" style={{ height: 120, opacity: 0.55 }} />;
  const c = ch.data;
  const active = plans.data?.plans.find((p) => p.status === 'active');

  return (
    <div>
      <div className="text-micro" style={{ marginBottom: 10 }}>
        <Link to="/app/editor" className="link-accent">← Editor</Link>
      </div>
      <PageHeader
        title={c.title || c.channelKey}
        subtitle={`${c.channelKey} · ${c.timezone} · plan at ${String(c.planHour).padStart(2, '0')}:00`}
        actions={<>
          <button className="btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            disabled={replan.isPending || c.mode === 'off'} title={c.mode === 'off' ? 'Switch to shadow first' : 'Run the planner now'}
            onClick={() => replan.mutate(c.channelKey)}>
            <Icon name="calendar-sync" size={14} /> Replan today
          </button>
          <button className="btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => setEditing(true)}>
            <Icon name="pencil" size={14} /> Edit card
          </button>
        </>}
      />

      <div className="stat-grid compose-rise" style={{ marginBottom: 18 }}>
        <div className="stat-tile">
          <div className="text-micro" style={{ color: 'var(--color-ink-dim)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 10 }}>Mode</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <Badge tone={MODE_TONE[c.mode]}>{c.mode}</Badge>
            <ModeSwitch channelKey={c.channelKey} mode={c.mode} />
          </div>
        </div>
        <StatTile label="Spend today" value={fmtUsd(c.today.spendUsd)} icon="analytics" delta={`${c.today.runs} runs · cap ${c.dailyBudgetUsd == null ? 'env default' : fmtUsd(c.dailyBudgetUsd)}`} />
        <StatTile label="Posts per day" value={`${c.postsPerDayMin}–${c.postsPerDayMax}`} icon="calendar" delta={`quiet ${c.quietStartHour}:00–${c.quietEndHour}:00 · gap ${c.minGapMinutes}m`} />
      </div>

      <CardSummary c={c} />

      <SectionCard title={`Plan · ${c.today.date}`} icon="calendar" delay={60} style={{ marginBottom: 16 }}
        action={<SlotCounts slots={c.today.slots} />}>
        {active?.rationale && <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)', margin: '0 0 12px' }}>{active.rationale}</p>}
        {!active || active.slots.length === 0
          ? <EmptyState icon="calendar" title="No plan for today yet" note={c.mode === 'off' ? 'The channel is off.' : `The planner runs at ${c.planHour}:00, or use “Replan today”.`} />
          : <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {active.slots.map((s, i) => <SlotRow key={s.id} slot={s} delay={i * 25} />)}
            </div>}
      </SectionCard>

      <MemorySection channelKey={c.channelKey} />
      <RunsSection channelKey={c.channelKey} />

      {editing && <CardEditorModal open onClose={() => setEditing(false)} card={c} />}
    </div>
  );
}

function CardSummary({ c }: { c: EditorChannel }) {
  const row = (label: string, value: ReactNode) => (
    <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 12, padding: '6px 0', borderTop: '1px solid var(--color-hairline-soft)' }}>
      <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{label}</span>
      <span className="text-body-sm" style={{ color: 'var(--color-ink)', minWidth: 0, wordBreak: 'break-word' }}>{value}</span>
    </div>
  );
  const chips = (xs: string[]) => xs.length
    ? <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>{xs.map((x) => <span key={x} className="chip">{x}</span>)}</span>
    : <span style={{ color: 'var(--color-ink-dim)' }}>—</span>;

  return (
    <SectionCard title="Card" icon="sparkles" delay={30} style={{ marginBottom: 16 }}>
      <p className="text-body-sm" style={{ margin: '0 0 12px', color: c.brief ? 'var(--color-ink)' : 'var(--color-ink-dim)', whiteSpace: 'pre-wrap' }}>{c.brief || 'No brief yet.'}</p>
      {row('Formats', chips(Object.entries(c.formats).map(([f, w]) => `${f} ${w}`)))}
      {row('Hashtags', <>{chips(c.hashtags.map((h) => `#${h}`))} <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{c.hashtagMin}–{c.hashtagMax} per post</span></>)}
      {row('Style', `links ${c.linkStyle} · emoji ${c.emojiPolicy}${c.footer ? ` · footer “${c.footer}”` : ''}`)}
      {row('Sources', c.sources.length
        ? <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>{c.sources.map((s) => <span key={s.id}><span className="chip">{s.kind}</span> {s.ref}</span>)}</span>
        : '—')}
      {row('Skills', chips(c.skills))}
      {row('Banned terms', chips(c.bannedTerms))}
      {row('Tools', c.toolsAllow ? chips(c.toolsAllow) : 'role defaults')}
      {row('Models', Object.keys(c.models).length ? chips(Object.entries(c.models).map(([r, m]) => `${r}: ${m}`)) : 'defaults')}
      {row('Explore ratio', String(c.exploreRatio))}
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
    <SectionCard title="Memory" icon="bots" delay={90} style={{ marginBottom: 16 }}
      action={history.length > 0 ? <button className="btn-tiny" onClick={() => setShowHistory((v) => !v)}>{showHistory ? 'Hide' : 'Show'} history ({history.length})</button> : undefined}>
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
        : <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {activeEntries.map((m) => (
              <div key={m.id} className="card" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 6, marginBottom: 3 }}>
                    <Badge tone={KIND_TONE[m.kind]}>{m.kind}</Badge>
                    <Badge tone="neutral">{m.createdBy}</Badge>
                  </div>
                  <div className="text-body-sm" style={{ color: 'var(--color-ink)' }}>{m.text}</div>
                </div>
                <RowActions danger={
                  <TableAction action="delete" title="Retire" disabled={retire.isPending}
                    onClick={async () => { if (await confirm(`retire the memory entry “${m.text.slice(0, 60)}”`, { confirmLabel: 'Retire' })) retire.mutate(m.id); }} />
                } />
              </div>
            ))}
          </div>}
      {showHistory && history.length > 0 && (
        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {history.map((m) => (
            <div key={m.id} className="text-micro" style={{ color: 'var(--color-ink-dim)', display: 'flex', gap: 8 }}>
              <span className="tabular-nums">{fmtDate(m.createdAt)}</span>
              <span>{m.kind} · {m.createdBy}</span>
              <span style={{ color: 'var(--color-ink-muted)' }}>{m.text}</span>
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
    <SectionCard title="Recent runs" icon="logs" delay={120}>
      {data.length === 0
        ? <EmptyState icon="logs" title="No runs yet" />
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
                    <td className="tabular-nums">{fmtDate(r.startedAt)}</td>
                    <td>{r.role}</td>
                    <td><Badge tone={RUN_TONE[r.status]} title={r.error ?? undefined}>{r.status}</Badge></td>
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
