// Spec 078 D6 / B3.2: banners under the agent's header, on every tab.
//   - a paused series (spec 060: the dead-series breaker, or the owner from a Telegram card): why, since when, and Resume;
//   - a resource paused by a @manager directive (spec 025): until when, and Lift.
// One callout per pause, three at most with a "Show all" behind them. Nothing is drawn when nothing is paused, or when the
// server has no endpoint for it. There is no Undo here: resuming / lifting is itself the undo of the pause.

import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Icon } from '../ui/Icon';
import { toast } from '../ui/Toast';
import { fmtDate, fmtRelative } from '../../lib/format';
import { useResumeSeries, useSeriesPauses, type Agent, type SeriesPause } from '../../api/agents';
import { useResourcePauses, type ResourcePause } from '../../api/manager';
import { useNetworkPlan } from '../../api/network';
import { pausesOf, shortDate, timeLeft } from '../../lib/directive-view';
import { capPauses, pauseEffect, pauseSummary, pauseTitle } from '../../lib/agent-overview';
import { zoneLabel } from '../../lib/zoned-time';
import { nextPlanLine } from '../../lib/mode-hints';
import { useLiftAction } from './ActiveEffects';
import { ResourceChip } from './NetworkUi';

type BannerAgent = Pick<Agent, 'id' | 'handle' | 'kind' | 'scopeId'>;

export function PauseBanners({ agent }: { agent: BannerAgent }) {
  const orchestrator = agent.kind === 'orchestrator';
  const telegram = orchestrator && !!agent.scopeId?.startsWith('telegram:');
  return (
    <>
      {telegram && <SeriesBanners handle={agent.handle} />}
      {orchestrator && <ResourceBanners agent={agent} />}
    </>
  );
}

function ShowAll({ hidden, onClick }: { hidden: number; onClick: () => void }) {
  if (!hidden) return null;
  return <button type="button" className="btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }} onClick={onClick}>Show all ({hidden} more)</button>;
}

// ── series ───────────────────────────────────────────────────────────────────

function SeriesBanners({ handle }: { handle: string }) {
  const q = useSeriesPauses(handle);
  const [all, setAll] = useState(false);
  const open = q.data?.open ?? [];
  if (!open.length) return null;
  const { shown, hidden } = capPauses(open, all);
  return (
    <div className="agent-banners" aria-label="Paused series">
      {shown.map((p) => <SeriesBanner key={p.id} p={p} handle={handle} />)}
      <ShowAll hidden={hidden} onClick={() => setAll(true)} />
    </div>
  );
}

function SeriesBanner({ p, handle }: { p: SeriesPause; handle: string }) {
  const resume = useResumeSeries(handle);
  // The plan's schedule names the next plan time for the toast; without it the toast just confirms.
  const schedule = useNetworkPlan(handle, '').data?.schedule;
  const onResume = () => resume.mutate(p.id, {
    onSuccess: () => toast.success(
      schedule
        ? `Resumed. ${nextPlanLine({ planHour: schedule.planHour, approval: schedule.approval, batchHour: schedule.batchHour, zone: zoneLabel(schedule.timezone) })}`
        : 'Resumed',
    ),
  });
  return (
    <div className="callout-warning agent-banner" role="status">
      <Icon name="pause" size={16} />
      <div className="agent-banner-text">
        <strong className="agent-banner-title">{pauseTitle(p)}</strong>
        <span className="agent-banner-sub">{pauseSummary(p)} · paused {fmtRelative(p.pausedAt)}</span>
        {p.reason && <span className="agent-banner-sub clamp" title={p.reason}>{p.reason}</span>}
        <span className="agent-banner-sub">{pauseEffect(p.key)}</span>
      </div>
      <button type="button" className="btn-warning btn-sm" disabled={resume.isPending} onClick={onResume}>
        <Icon name="play" size={14} /> Resume
      </button>
    </div>
  );
}

// ── resources paused by @manager ─────────────────────────────────────────────

function ResourceBanners({ agent }: { agent: BannerAgent }) {
  const q = useResourcePauses({ active: true });
  const [all, setAll] = useState(false);
  const pauses = useMemo(() => pausesOf(q.data?.pauses ?? [], agent), [q.data, agent]);
  if (!pauses.length) return null;
  const { shown, hidden } = capPauses(pauses, all);
  return (
    <div className="agent-banners" aria-label="Paused resources">
      {shown.map((p) => <ResourceBanner key={String(p.id)} p={p} />)}
      <ShowAll hidden={hidden} onClick={() => setAll(true)} />
    </div>
  );
}

function ResourceBanner({ p }: { p: ResourcePause }) {
  const { onLift, pending } = useLiftAction(p);
  return (
    <div className="callout-warning agent-banner" role="status">
      <Icon name="pause" size={16} />
      <div className="agent-banner-text">
        <strong className="agent-banner-title">Planning paused by @manager</strong>
        <span className="agent-banner-sub">
          <ResourceChip refId={p.resourceRef} /> until <span title={fmtDate(p.until)}>{shortDate(p.until)}</span> ({timeLeft(p.until)})
        </span>
        {p.reason && <span className="agent-banner-sub clamp" title={p.reason}>{p.reason}</span>}
        {p.directiveId && (
          <Link to="/app/agents/$handle" params={{ handle: 'manager' }} search={{ tab: 'directives', directive: p.directiveId }} className="agent-banner-sub link-accent">
            Open the directive →
          </Link>
        )}
      </div>
      <button type="button" className="btn-warning btn-sm" disabled={pending} onClick={onLift} title="Lift the pause now">
        <Icon name="play" size={14} /> Lift the pause
      </button>
    </div>
  );
}
