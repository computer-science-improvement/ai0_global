import { createFileRoute, Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { PageHeader } from '../components/ui/PageHeader';
import { SectionCard, StatTile, EmptyState } from '../components/ui/primitives';
import { Badge } from '../components/ui/Badge';
import { Icon } from '../components/ui/Icon';
import { TableAction, RowActions } from '../components/ui/table';
import { CardEditorModal } from '../components/editor/CardEditorModal';
import { ModeSwitch, MODE_TONE, SlotCounts, SlotRow, fmtUsd } from '../components/editor/EditorUi';
import { describeError } from '../components/ui/Toast';
import { useEditorChannels, useEditorPlans, useEditorSpend, useReplan } from '../api/editor';
import type { EditorChannel, EditorSpendRow } from '../api/types';

export const Route = createFileRoute('/app/editor')({ component: EditorPage });

function EditorPage() {
  const channels = useEditorChannels();
  const date = channels.data?.date;
  const plans = useEditorPlans(date);
  const [creating, setCreating] = useState(false);

  const list = channels.data?.channels ?? [];
  const todaySlots = useMemo(
    () => (plans.data?.plans ?? []).filter((p) => p.status === 'active').flatMap((p) => p.slots)
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)),
    [plans.data],
  );
  const spendToday = list.reduce((s, c) => s + c.today.spendUsd, 0);
  const count = (m: EditorChannel['mode']) => list.filter((c) => c.mode === m).length;
  const failed = todaySlots.filter((s) => s.status === 'failed').length;

  const newBtn = (cls: 'btn-primary' | 'btn-secondary') => (
    <button className={cls} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => setCreating(true)}>
      <Icon name="plus" size={14} /> New card
    </button>
  );

  return (
    <div>
      <PageHeader title="Editor" subtitle="Autonomous per-channel editors: cards, today's plan, runs and spend" actions={newBtn('btn-primary')} />

      {channels.data && !channels.data.enabled && (
        <div className="callout-warning compose-rise" style={{ marginBottom: 16 }}>
          <Icon name="warning" size={16} />
          <span>The editor is disabled (<code>EDITOR_ENABLED</code> is not <code>true</code>). Nothing is planned or executed, and “Run now” / “Replan” are refused.</span>
        </div>
      )}

      {channels.error && <div className="callout-danger" style={{ marginBottom: 16 }}>{describeError(channels.error)}</div>}

      {list.length > 0 && (
        <div className="stat-grid compose-rise" style={{ marginBottom: 18 }}>
          <StatTile label="Channels" value={list.length} icon="sparkles" accent delta={`${count('live')} live · ${count('approve')} in approval · ${count('shadow')} shadow · ${count('off')} off`} />
          <StatTile label="Slots today" value={todaySlots.length} icon="calendar" />
          <StatTile label="Failed today" value={failed} icon="warning" deltaTone={failed ? 'danger' : 'neutral'} delta={failed ? 'needs attention' : undefined} />
          <StatTile label="Spend today" value={fmtUsd(spendToday)} icon="analytics" />
        </div>
      )}

      {channels.data && list.length === 0 && (
        <EmptyState icon="sparkles" title="No channel cards yet"
          note="A card tells the editor what a channel is about, which formats and sources to use and how often to post. New cards start in mode off."
          action={newBtn('btn-secondary')} />
      )}

      {list.length > 0 && (
        <SectionCard title="Channels" icon="channels" delay={40} style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {list.map((c, i) => <ChannelRow key={c.channelKey} c={c} delay={i * 40} />)}
          </div>
        </SectionCard>
      )}

      {list.length > 0 && (
        <SectionCard title={`Today${date ? ` · ${date}` : ''}`} icon="calendar" delay={80} style={{ marginBottom: 16 }}>
          {todaySlots.length === 0
            ? <EmptyState icon="calendar" title="No slots planned today" note="Planners run at each card's plan hour for channels in shadow or live mode." />
            : <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {todaySlots.map((s, i) => <SlotRow key={s.id} slot={s} showChannel delay={i * 25} />)}
              </div>}
        </SectionCard>
      )}

      {list.length > 0 && <SpendSection />}

      {creating && <CardEditorModal open onClose={() => setCreating(false)} card={null} />}
    </div>
  );
}

function ChannelRow({ c, delay }: { c: EditorChannel; delay: number }) {
  const replan = useReplan();
  return (
    <div className="card row-lift compose-rise" style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '13px 18px', flexWrap: 'wrap', animationDelay: `${delay}ms` }}>
      <div style={{ minWidth: 200, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
          <Link to="/app/editor/$channel" params={{ channel: c.channelKey }} style={{ color: 'var(--color-ink)', fontWeight: 600, textDecoration: 'none' }}>
            {c.title || c.channelKey}
          </Link>
          <Badge tone={MODE_TONE[c.mode]}>{c.mode}</Badge>
        </div>
        <div className="text-micro" style={{ color: 'var(--color-ink-muted)', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <span>{c.channelKey}</span>
          <span>{c.postsPerDayMin}–{c.postsPerDayMax}/day</span>
          <SlotCounts slots={c.today.slots} />
        </div>
      </div>
      <div className="tabular-nums" style={{ textAlign: 'right', minWidth: 80 }}>
        <div style={{ fontWeight: 600 }}>{fmtUsd(c.today.spendUsd)}</div>
        <div className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{c.today.runs} runs today</div>
      </div>
      <ModeSwitch channelKey={c.channelKey} mode={c.mode} title={c.title} />
      <RowActions>
        <TableAction icon="calendar-sync" title="Replan the rest of today" disabled={replan.isPending || c.mode === 'off'} onClick={() => replan.mutate({ key: c.channelKey })} />
        {c.mode === 'approve' && (
          <TableAction icon="calendar" title="Replan tomorrow" disabled={replan.isPending} onClick={() => replan.mutate({ key: c.channelKey, date: 'tomorrow' })} />
        )}
        <Link to="/app/editor/$channel" params={{ channel: c.channelKey }} className="btn-act" title="Open channel" aria-label="Open channel">
          <Icon name="pencil" size={14} />
        </Link>
      </RowActions>
    </div>
  );
}

function SpendSection() {
  const spend = useEditorSpend(30);
  const days = useMemo(() => {
    const byDay = new Map<string, EditorSpendRow[]>();
    for (const r of spend.data?.rows ?? []) byDay.set(r.day, [...(byDay.get(r.day) ?? []), r]);
    return [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [spend.data]);

  return (
    <SectionCard title="Spend · last 30 days" icon="analytics" delay={120}
      action={spend.data ? <span className="text-caption tabular-nums" style={{ color: 'var(--color-ink-muted)' }}>{fmtUsd(spend.data.totalUsd)} total</span> : undefined}>
      {days.length === 0
        ? <EmptyState icon="analytics" title="No LLM spend yet" />
        : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr>
                <th>Day (Kyiv)</th>
                <th>By channel</th>
                <th className="num">Runs</th>
                <th className="num">USD</th>
              </tr></thead>
              <tbody>
                {days.map(([day, rows]) => (
                  <tr key={day}>
                    <td className="tabular-nums">{day}</td>
                    <td>
                      <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
                        {rows.map((r) => <span key={r.channelKey ?? '-'} className="chip">{r.channelKey ?? 'global'} {fmtUsd(r.usd)}</span>)}
                      </span>
                    </td>
                    <td className="num">{rows.reduce((s, r) => s + r.runs, 0)}</td>
                    <td className="num">{fmtUsd(rows.reduce((s, r) => s + r.usd, 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </SectionCard>
  );
}
