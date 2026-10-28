import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '../components/ui/PageHeader';
import { SeverityPill } from '../components/ui/Pills';
import { NeedsYouList } from '../components/today/NeedsYouList';
import { useNeedsYou } from '../components/today/useNeedsYou';
import { useTodayDay } from '../components/today/useTodayDay';
import { TodayGlance } from '../components/today/TodayGlance';
import { DayTimeline } from '../components/today/DayTimeline';
import { AgentsPanel } from '../components/today/AgentsPanel';
import { ActivityList } from '../components/today/ActivityList';
import { TodayKpi } from '../components/today/TodayKpi';
import { useNow } from '../lib/useNow';
import { kyivEyebrow, kyivGreeting, needsHeadline } from '../lib/today';

export const Route = createFileRoute('/app/')({ component: OverviewPage });

/**
 * Today (spec 078 D6): what needs the owner, how the day is going, what the agents are doing, the key numbers.
 * Top to bottom: header, Needs you + glance, the day's schedule, Agents + live activity, KPI strip.
 */
function OverviewPage() {
  const now = useNow(60_000);
  const needs = useNeedsYou();
  const day = useTodayDay();

  return (
    <div>
      <PageHeader
        eyebrow={kyivEyebrow(now)}
        title={needs.loaded ? `${kyivGreeting(now)}. ${needsHeadline(needs.summary.total)}` : `${kyivGreeting(now)}.`}
        actions={needs.loaded && needs.summary.total > 0 ? (
          <>
            {needs.summary.critical > 0 && <SeverityPill severity="critical" label={`${needs.summary.critical} critical`} />}
            {needs.summary.toAct > 0 && <SeverityPill severity="action" label={`${needs.summary.toAct} to act on`} />}
          </>
        ) : undefined}
      />

      <div className="today-row">
        <NeedsYouList needs={needs} now={now} delay={0} />
        <TodayGlance day={day} delay={60} />
      </div>

      <div style={{ marginTop: 16 }}>
        <DayTimeline day={day} now={now} delay={120} />
      </div>

      <div className="today-row today-row-agents">
        <AgentsPanel day={day} delay={180} />
        <ActivityList now={now} delay={240} />
      </div>

      <div style={{ marginTop: 16 }}>
        <TodayKpi delay={300} />
      </div>
    </div>
  );
}
