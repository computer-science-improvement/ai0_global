import { createFileRoute, Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { PageHeader } from '../components/ui/PageHeader';
import { SectionCard, StatStrip, StatTile, EmptyState, HubGlyph } from '../components/ui/primitives';
import { Icon } from '../components/ui/Icon';
import { TableAction, RowActions } from '../components/ui/table';
import { CardEditorModal } from '../components/editor/CardEditorModal';
import { ModeSwitch, SlotCounts, SlotRow, fmtUsd } from '../components/editor/EditorUi';
import { describeError } from '../components/ui/Toast';
import { useEditorChannels, useEditorPlans, useEditorSpend, useReplan } from '../api/editor';
import type { EditorChannel, EditorPlan, EditorSpendRow } from '../api/types';
import { dayEyebrow } from '../lib/day-groups';
import { feedsOf, plannedAtLine, runLabel } from '../lib/slot-plan';

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
  const byKey = useMemo(() => new Map(list.map((c) => [c.channelKey, c])), [list]);
  const activePlan = (key: string) => (plans.data?.plans ?? []).find((p) => p.status === 'active' && p.channelKey === key) ?? null;
  const estimates = plans.data?.previewEstimates ?? {};
  const spendToday = list.reduce((s, c) => s + c.today.spendUsd, 0);
  const count = (m: EditorChannel['mode']) => list.filter((c) => c.mode === m).length;
  const failed = todaySlots.filter((s) => s.status === 'failed').length;
  const modeLine = ([['live', count('live')], ['in approval', count('approve')], ['shadow', count('shadow')], ['off', count('off')]] as const)
    .filter(([, n]) => n > 0).map(([label, n]) => `${n} ${label}`).join(' · ');

  const newBtn = (cls: 'btn-primary' | 'btn-secondary') => (
    <button className={cls} onClick={() => setCreating(true)}>
      <Icon name="plus" size={14} /> New card
    </button>
  );

  return (
    <div>
      <PageHeader eyebrow={dayEyebrow(date)} title="Editor" subtitle="Autonomous per-channel editors: cards, today's plan, runs and spend" actions={newBtn('btn-primary')} />

      {channels.data && !channels.data.enabled && (
        <div className="callout-warning compose-rise" style={{ marginBottom: 16 }}>
          <Icon name="warning" size={16} />
          <span>The editor is disabled (<code>EDITOR_ENABLED</code> is not <code>true</code>). Nothing is planned or executed, and “Run now” / “Replan” are refused.</span>
        </div>
      )}

      {channels.error && <div className="callout-danger" style={{ marginBottom: 16 }}>{describeError(channels.error)}</div>}

      {list.length > 0 && (
        <div className="compose-rise" style={{ marginBottom: 16 }}>
          <StatStrip label="Editor numbers">
            <StatTile label="Channels" value={list.length} delta={modeLine || undefined} />
            <StatTile label="Slots today" value={todaySlots.length} />
            <StatTile label="Failed today" value={failed} deltaTone={failed ? 'danger' : 'neutral'} delta={failed ? 'needs attention' : undefined} />
            <StatTile label="Spend today" value={fmtUsd(spendToday)} />
          </StatStrip>
        </div>
      )}

      {channels.data && list.length === 0 && (
        <EmptyState icon="sparkles" title="No channel cards yet"
          note="A card tells the editor what a channel is about, which formats and sources to use and how often to post. New cards start in mode off."
          action={newBtn('btn-secondary')} />
      )}

      {list.length > 0 && (
        <SectionCard title="Channels" flush delay={40} style={{ marginBottom: 16 }}>
          {list.map((c) => <ChannelRow key={c.channelKey} c={c} plan={activePlan(c.channelKey)} />)}
        </SectionCard>
      )}

      {list.length > 0 && (
        <SectionCard title={`Today${date ? ` · ${date}` : ''}`} flush delay={80} style={{ marginBottom: 16 }}>
          {todaySlots.length === 0
            ? <EmptyState icon="calendar" title="No slots planned today"
                note="Cards in shadow, approval or live mode are planned at their plan hour; a card that is off is not planned." />
            : todaySlots.map((s) => {
                const c = byKey.get(s.channelKey);
                return <SlotRow key={s.id} slot={s} showChannel tz={c?.timezone} feeds={feedsOf(c)} estimateUsd={estimates[s.channelKey] ?? null} />;
              })}
        </SectionCard>
      )}

      {list.length > 0 && <SpendSection />}

      {creating && <CardEditorModal open onClose={() => setCreating(false)} card={null} />}
    </div>
  );
}

function ChannelRow({ c, plan }: { c: EditorChannel; plan: EditorPlan | null }) {
  const replan = useReplan();
  const planned = plannedAtLine(plan?.createdAt, c.timezone);
  const name = c.title || c.channelKey;
  return (
    <div className="panel-row">
      <HubGlyph size={32}>{name.replace(/^@/, '').charAt(0).toUpperCase()}</HubGlyph>
      <div style={{ flex: '1 1 260px', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
          <Link to="/app/editor/$channel" params={{ channel: c.channelKey }} className="text-body-sm ed-name">
            {name}
          </Link>
          <span className="mono text-micro ink-muted">{c.channelKey}</span>
        </div>
        <div className="text-micro ink-muted" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="mono">{c.postsPerDayMin}–{c.postsPerDayMax}/day</span>
          <SlotCounts slots={c.today.slots} />
        </div>
        <div className="text-micro ink-dim" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 3 }}>
          {planned
            ? <>
                <span>{planned} by</span>
                {plan?.runId ? <Link to="/app/editor/run/$id" params={{ id: plan.runId }} className="link-accent">{runLabel(plan.runRole)} →</Link> : <span>the system</span>}
              </>
            : <span>Not planned yet</span>}
          <span>· plans at {String(c.planHour).padStart(2, '0')}:00{c.mode === 'approve' ? ', the next day at 20:00 the evening before' : ''}</span>
        </div>
      </div>
      <div style={{ textAlign: 'right', minWidth: 80 }}>
        <div className="mono tabular-nums ed-figure">{fmtUsd(c.today.spendUsd)}</div>
        <div className="mono text-micro ink-dim">{c.today.runs} runs today</div>
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
    <SectionCard title="Spend · last 30 days" delay={120}
      action={spend.data ? <span className="mono text-caption tabular-nums ink-muted">{fmtUsd(spend.data.totalUsd)} total</span> : undefined}>
      {days.length === 0
        ? <EmptyState icon="analytics" title="No LLM spend yet" note="Planner, executor and reviewer runs show up here once a channel is planned." />
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
                    <td className="mono tabular-nums">{day}</td>
                    <td>
                      <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
                        {rows.map((r) => <span key={r.channelKey ?? '-'} className="chip mono">{r.channelKey ?? 'global'} {fmtUsd(r.usd)}</span>)}
                      </span>
                    </td>
                    <td className="num">{rows.reduce((s, r) => s + r.runs, 0)}</td>
                    <td className="num mono">{fmtUsd(rows.reduce((s, r) => s + r.usd, 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </SectionCard>
  );
}
