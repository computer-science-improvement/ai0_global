// "Active effects" of an agent (spec 025 FR-019), the In force tab: what MANAGER
// directives have changed for it right now — resources paused (with the end
// date and a Lift button), series paused until a date, experiment quotas with
// their deadline and progress, and playbook versions a directive wrote.
// Rows in a flush panel (apps/dashboard/CLAUDE.md): identity left, dates and the action right.
// Spec 078 D1.4: the look is agent-plan.css (prefix apl-).

import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import { EmptyState, SectionCard } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Icon, type IconName } from '../ui/Icon';
import { TableAction } from '../ui/table';
import { useConfirm } from '../ui/ConfirmDialog';
import { toast } from '../ui/Toast';
import { fmtDate } from '../../lib/format';
import { errorBody } from '../../api/agents';
import { useDirectives, useLiftPause, useResourcePauses, type ResourcePause } from '../../api/manager';
import { activeEffectsOf, pausesOf, shortDate, timeLeft, verificationChip, type ActiveEffect } from '../../lib/directive-view';
import { DIRECTIVE_KIND_LABEL } from './Directives';
import { ResourceChip, errorText } from './NetworkUi';

const EFFECT_ICON: Record<ActiveEffect['kind'], IconName> = {
  playbook: 'logs', card: 'settings', series: 'pause', experiment: 'sparkles', strategy: 'book', other: 'agents',
};

function DirectiveLink({ id }: { id: string }) {
  return (
    <Link to="/app/agents/$handle" params={{ handle: 'manager' }} search={{ tab: 'directives', directive: id }} className="link-accent text-micro apl-nowrap">
      directive →
    </Link>
  );
}

/** Lift a @manager resource pause early, behind a confirmation (the banner in the agent header uses it too). */
export function useLiftAction(p: ResourcePause) {
  const confirm = useConfirm();
  const lift = useLiftPause();
  const onLift = async () => {
    const ok = await confirm(`lift the pause on ${p.resourceRef}`, {
      danger: false, confirmLabel: 'Lift pause',
      details: <span className="text-micro">Planning and publishing on this resource resume with the next plan. The pause would otherwise end {fmtDate(p.until)}.</span>,
    });
    if (!ok) return;
    lift.mutate(p.resourceRef, {
      onSuccess: () => toast.success('Pause lifted — the resource is back in planning'),
      onError: (e) => toast.error(errorBody(e)?.error === 'not_paused' ? 'This pause has already ended — refreshed' : errorText(e)),
    });
  };
  return { onLift, pending: lift.isPending };
}

function PauseRow({ p }: { p: ResourcePause }) {
  const { onLift, pending } = useLiftAction(p);
  return (
    <div className="panel-row apl-effect">
      <span className="apl-effect-icon is-warning" aria-hidden><Icon name="pause" size={14} /></span>
      <div className="apl-effect-main">
        <div className="apl-effect-head">
          <ResourceChip refId={p.resourceRef} />
          <Badge tone="warning">paused</Badge>
          {p.directiveId && <DirectiveLink id={p.directiveId} />}
        </div>
        <div className="text-caption apl-effect-note">{p.reason}</div>
      </div>
      <div className="apl-effect-side">
        <div className="text-micro mono apl-until" title={fmtDate(p.until)}>
          until {shortDate(p.until)}<div className="apl-dim">{timeLeft(p.until)}</div>
        </div>
        <TableAction icon="play" label="Lift" title="Lift the pause now" disabled={pending} onClick={onLift} />
      </div>
    </div>
  );
}

function EffectRow({ e, handle }: { e: ActiveEffect; handle: string }) {
  const d = e.directive;
  const v = verificationChip(d);
  const detail = (d.verification?.detail ?? null) as { done?: number; planned?: number; slots?: number } | null;
  return (
    <div className="panel-row apl-effect">
      <span className="apl-effect-icon" aria-hidden><Icon name={EFFECT_ICON[e.kind]} size={14} /></span>
      <div className="apl-effect-main">
        <div className="apl-effect-head">
          <span className="chip">{DIRECTIVE_KIND_LABEL[d.kind] ?? d.kind}</span>
          {d.binding === 'advice' ? <Badge tone="neutral">advice</Badge> : <Badge tone="warning">directive</Badge>}
          {v && <Badge tone={v.tone} title={v.title}>{v.label}</Badge>}
          <DirectiveLink id={d.id} />
        </div>
        <div className="text-body-sm apl-effect-text">{e.text}</div>
        {e.kind === 'experiment' && detail?.slots != null && (
          <div className="text-micro tabular-nums apl-effect-note">
            {detail.done ?? 0} of {detail.slots} published · {detail.planned ?? 0} planned
          </div>
        )}
      </div>
      <div className="apl-effect-side">
        {e.until && (
          <div className="text-micro mono apl-until" title={fmtDate(e.until)}>
            {e.kind === 'experiment' ? 'by' : 'until'} {shortDate(e.until)}<div className="apl-dim">{timeLeft(e.until)}</div>
          </div>
        )}
        {e.version != null && (
          <Link to="/app/agents/$handle" params={{ handle }} search={{ tab: 'playbook' }} className="link-accent text-micro apl-nowrap">
            playbook v{e.version} →
          </Link>
        )}
      </div>
    </div>
  );
}

export function ActiveEffects({ agent, delay }: { agent: { id: string; handle: string }; delay?: number }) {
  const dq = useDirectives({ agent: agent.handle, status: ['accepted', 'applied'] });
  const pq = useResourcePauses({ active: true });
  const effects = useMemo(() => activeEffectsOf(dq.data?.directives ?? []), [dq.data]);
  const pauses = useMemo(() => pausesOf(pq.data?.pauses ?? [], agent), [pq.data, agent]);
  const loading = !dq.data && !dq.error;
  const n = effects.length + pauses.length;
  const err = dq.error ?? pq.error;
  return (
    <SectionCard title="Active effects" icon="radar" flush delay={delay}
      action={n > 0 ? <span className="text-micro mono apl-dim">{n} active</span> : undefined}>
      {err && <div className="apl-pad"><div className="callout-danger">{errorText(err)}</div></div>}
      {loading && <div className="apl-effects-skeleton" aria-hidden />}
      {!loading && n === 0 && !err && (
        <EmptyState icon="radar" title="Nothing in force"
          note="Directives and followed advice from @manager that pause a resource or a series, change the playbook or open an experiment quota show up here until they end." />
      )}
      {pauses.map((p) => <PauseRow key={`p-${p.id}`} p={p} />)}
      {effects.map((e) => <EffectRow key={e.directive.id} e={e} handle={agent.handle} />)}
    </SectionCard>
  );
}
