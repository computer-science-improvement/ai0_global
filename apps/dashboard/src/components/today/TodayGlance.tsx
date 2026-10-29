// Spec 078 B1: "Today at a glance": the slot ring with its numbers, how many agent runs there were, today's AI budget and
// the channel that has used the most of its own budget. Each part says "unavailable" on its own instead of hiding the panel.

import { useMemo, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { SectionCard } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { RingLegend, SlotRing } from './SlotRing';
import { useAgentTree } from '../../api/agents';
import { useAgentsOverview, useBudgets, useSpendSummary } from '../../api/spend';
import { pickGlobalBudget } from '../../nav/sidebar-model';
import { barPct, budgetBadge, budgetBarColor, fmtUsd } from '../../lib/spend';
import { busiestChannel, capState, orchestratorsByChannel } from '../../lib/today';
import type { TodayDay } from './useTodayDay';
import './today.css';

/** "$0.54 / $1.50" over a thin bar; `cap` null = no daily cap (no bar). */
function Meter({ label, name, spent, cap, color, badge, aria }: {
  label: string; name?: ReactNode; spent: number; cap: number | null; color: string;
  badge?: { tone: 'success' | 'warning' | 'danger' | 'accent' | 'neutral'; label: string } | null; aria: string;
}) {
  return (
    <div className="glance-item">
      <div className="glance-head">
        <span className="glance-label">{label}</span>
        {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
      </div>
      <div className="glance-main">
        <span className="glance-name">{name}</span>
        <span className="glance-value tabular-nums">
          {fmtUsd(spent)} <span className="glance-cap">/ {cap == null ? 'no daily cap' : fmtUsd(cap)}</span>
        </span>
      </div>
      {cap != null && (
        <div className="glance-bar" role="meter" aria-label={aria} aria-valuemin={0} aria-valuemax={cap} aria-valuenow={spent}>
          <div style={{ width: `${barPct(spent, cap)}%`, background: color }} />
        </div>
      )}
    </div>
  );
}

export function TodayGlance({ day, delay }: { day: TodayDay; delay?: number }) {
  const overview = useAgentsOverview();
  const budgets = useBudgets();
  const summary = useSpendSummary('7d');
  const tree = useAgentTree();
  const orchestrators = useMemo(() => orchestratorsByChannel(tree.data?.agents), [tree.data]);

  const channels = day.channels ?? [];
  // Runs today: the overview counts every agent run; without it, the channels' own count.
  const runsToday = overview.data?.runs.today ?? (day.channelsQ.data ? channels.reduce((n, c) => n + c.today.runs, 0) : null);
  const rate = overview.data?.runs.successRate7d ?? null;

  const globalBudget = pickGlobalBudget(budgets.data?.rows);
  const spendToday = summary.data?.periods.today.usd ?? null;

  const busiest = busiestChannel(channels);
  const busyAgent = busiest ? orchestrators.get(busiest.channelKey) : undefined;
  const busyName = busiest ? (busyAgent?.name || busiest.title || busiest.channelKey) : '';

  return (
    <SectionCard title="Today at a glance" delay={delay}>
      <div className="glance-ring">
        {day.failed ? (
          <div className="glance-error" role="status">
            <p className="text-caption" style={{ margin: 0 }}>Today's plan could not be loaded.</p>
            <Button type="button" variant="secondary" size="sm" onClick={() => { void day.plansQ.refetch(); }}>Try again</Button>
          </div>
        ) : day.loading ? (
          <p className="text-caption ink-muted" role="status" style={{ margin: 0 }}>Loading today's slots…</p>
        ) : (
          <>
            <SlotRing summary={day.summary} />
            <RingLegend summary={day.summary} />
          </>
        )}
      </div>

      <div className="glance-list">
        <div className="glance-item">
          <div className="glance-head"><span className="glance-label">Agent runs today</span></div>
          <div className="glance-main">
            <span className="glance-value tabular-nums">{runsToday == null ? '—' : runsToday.toLocaleString('en-US')}</span>
            {rate != null && <span className="glance-sub">{Math.round(rate)}% ok over 7 days</span>}
          </div>
        </div>

        {globalBudget ? (
          <Meter
            label="AI budget today" spent={globalBudget.spentTodayUsd} cap={globalBudget.dailyUsd}
            color={budgetBarColor(globalBudget.state)} badge={budgetBadge(globalBudget.state, globalBudget.enforce)}
            aria="AI budget today"
          />
        ) : (
          <div className="glance-item">
            <div className="glance-head"><span className="glance-label">AI spend today</span></div>
            <div className="glance-main">
              <span className="glance-value tabular-nums">{spendToday == null ? '—' : fmtUsd(spendToday)}</span>
              {budgets.data && <Link to="/app/spend" search={{ tab: 'budgets' }} className="glance-sub is-link">No budget set</Link>}
            </div>
          </div>
        )}

        {busiest && (
          <Meter
            label="Busiest channel" spent={busiest.spentUsd} cap={busiest.capUsd}
            color={budgetBarColor(capState(busiest.pct))} aria={`${busyName} budget today`}
            name={<Link to="/app/editor/$channel" params={{ channel: busiest.channelKey }} className="glance-link" title={busiest.channelKey}>{busyName}</Link>}
          />
        )}
      </div>

      {day.otherPlatforms > 0 && (
        <p className="text-micro glance-note">
          {day.otherPlatforms} {day.otherPlatforms === 1 ? 'slot' : 'slots'} for Instagram, Facebook and Threads {day.otherPlatforms === 1 ? 'is' : 'are'} not counted here.
        </p>
      )}
    </SectionCard>
  );
}
