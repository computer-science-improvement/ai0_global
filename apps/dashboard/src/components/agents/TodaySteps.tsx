// Spec 078 D6 / B3.3: "Today, step by step" on the agent's Overview — the day in one list, in time order: the slots of today's
// active plan (StatusMark, skip reason), the runs of today that are not a slot's own, and the series paused today. The plan
// comes from `useNetworkPlan(orchestrator, '')`: an empty date makes the server pick the card-local today and return only the
// active plan, so there is no superseded plan to filter. For an agent with no Telegram card the page does not draw this
// panel (there is no plan source). A plan or run list that fails leaves the other half of the day on screen.

import { Fragment, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { EmptyState, SectionCard } from '../ui/primitives';
import { StatusMark } from '../ui/StatusMark';
import { useAgentRuns, useSeriesPauses, type AgentDetail } from '../../api/agents';
import { useNetworkPlan } from '../../api/network';
import { buildSteps, daySummary, nowIndex, stepWindow, type DayStep } from '../../lib/agent-overview';
import { plannedAtLine, planScheduleNote } from '../../lib/slot-plan';
import { KYIV_TZ, dayIn, formatIn, isValidZone } from '../../lib/zoned-time';

function StepRow({ s }: { s: DayStep }) {
  const body = (
    <>
      <span className="day-time mono">{s.time}</span>
      <StatusMark status={s.mark} label={s.markLabel} />
      <span className="day-body">
        <span className="day-title clamp">{s.title}</span>
        {s.note && <span className="day-note clamp" title={s.note}>{s.note}</span>}
      </span>
      {s.meta && <span className="day-meta mono">{s.meta}</span>}
    </>
  );
  if (s.link?.kind === 'slot') return <Link to="/app/editor/slot/$id" params={{ id: s.link.id }} className="panel-row day-step">{body}</Link>;
  if (s.link?.kind === 'run') return <Link to="/app/editor/run/$id" params={{ id: s.link.id }} className="panel-row day-step">{body}</Link>;
  return <div className="panel-row day-step">{body}</div>;
}

export function TodaySteps({ data, delay }: { data: AgentDetail; delay?: number }) {
  const a = data.agent;
  const orchestrator = a.kind === 'orchestrator' ? a.handle : data.parent?.handle ?? a.handle;
  const telegram = a.kind === 'orchestrator' && !!a.scopeId?.startsWith('telegram:');
  const plan = useNetworkPlan(orchestrator, '');
  const runs = useAgentRuns(a.handle);
  const pauses = useSeriesPauses(a.handle, telegram);
  const [all, setAll] = useState(false);

  const p = plan.data;
  const zone = p?.schedule?.timezone;
  const tz = isValidZone(zone) ? zone : KYIV_TZ;
  const now = new Date();
  const day = p?.date ?? dayIn(now, tz);
  const allRuns = useMemo(() => runs.data?.pages.flatMap((pg) => pg.runs) ?? [], [runs.data]);
  const steps = useMemo(
    () => buildSteps({ slots: p?.slots ?? [], runs: allRuns, pauses: pauses.data?.open ?? [], planRunId: p?.runId, day, tz }),
    [p, allRuns, pauses.data, day, tz],
  );

  const loading = plan.isLoading && runs.isLoading;
  const idx = nowIndex(steps, now);
  const win = all ? { start: 0, end: steps.length } : stepWindow(steps.length, idx);
  const summary = daySummary(steps);
  const planned = p ? plannedAtLine(p.plannedAt, tz) : null;

  return (
    <SectionCard title="Today, step by step" icon="calendar" flush delay={delay}
      action={<Link to="/app/agents/$handle" params={{ handle: a.handle }} search={{ tab: 'plan' }} className="panel-link">Full plan →</Link>}>
      {loading && <div className="day-skeleton" aria-hidden />}
      {!loading && steps.length === 0 && (
        <EmptyState icon="calendar" title="Nothing yet today"
          note={p?.schedule ? planScheduleNote({ planHour: p.schedule.planHour, timezone: p.schedule.timezone, approval: p.schedule.approval, batchHour: p.schedule.batchHour }) : 'No plan, run or pause for today.'} />
      )}
      {steps.slice(win.start, win.end).map((s, i) => {
        const at = win.start + i;
        return (
          <Fragment key={s.key}>
            {at === idx && <NowDivider tz={tz} />}
            <StepRow s={s} />
          </Fragment>
        );
      })}
      {steps.length > 0 && win.end === steps.length && idx === steps.length && <NowDivider tz={tz} />}
      {steps.length > 0 && (
        <div className="panel-foot text-micro">
          {steps.length > win.end - win.start && (
            <button type="button" className="btn-ghost btn-sm" onClick={() => setAll(true)}>Show all ({steps.length})</button>
          )}
          {all && steps.length > 14 && (
            <button type="button" className="btn-ghost btn-sm" onClick={() => setAll(false)}>Show fewer</button>
          )}
          <span className="day-foot-text">{[summary, planned].filter(Boolean).join(' · ')}</span>
        </div>
      )}
    </SectionCard>
  );
}

function NowDivider({ tz }: { tz: string }) {
  return (
    <div className="day-now" role="separator" aria-label="Now">
      <span className="mono">Now {formatIn(new Date(), tz)}</span>
    </div>
  );
}
