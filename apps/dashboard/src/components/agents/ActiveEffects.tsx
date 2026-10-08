// "Active effects" on an orchestrator's Overview (spec 025 FR-019): what MANAGER
// directives have changed for it right now — resources paused (with the end
// date and a Lift button), series paused until a date, experiment quotas with
// their deadline and progress, and playbook versions a directive wrote.
// Card-rows (apps/dashboard/CLAUDE.md): identity left, dates and the action right.

import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import { SectionCard } from '../ui/primitives';
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

const row = {
  display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' as const, padding: '10px 12px', minWidth: 0,
};

function DirectiveLink({ id }: { id: string }) {
  return (
    <Link to="/app/agents/$handle" params={{ handle: 'manager' }} search={{ tab: 'directives', directive: id }} className="link-accent text-micro" style={{ whiteSpace: 'nowrap' }}>
      directive →
    </Link>
  );
}

function PauseRow({ p, delay }: { p: ResourcePause; delay: number }) {
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
  return (
    <div className="card row-lift compose-rise" style={{ ...row, animationDelay: `${delay}ms` }}>
      <span style={{ color: 'var(--color-warning)', display: 'inline-flex' }} aria-hidden><Icon name="pause" size={14} /></span>
      <div style={{ flex: '1 1 220px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
          <ResourceChip refId={p.resourceRef} />
          <Badge tone="warning">paused</Badge>
          {p.directiveId && <DirectiveLink id={p.directiveId} />}
        </div>
        <div className="text-micro" style={{ color: 'var(--color-ink-muted)', overflowWrap: 'anywhere' }}>{p.reason}</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' }}>
        <div className="text-micro tabular-nums" style={{ textAlign: 'right', color: 'var(--color-ink-muted)' }} title={fmtDate(p.until)}>
          until {shortDate(p.until)}<div style={{ color: 'var(--color-ink-dim)' }}>{timeLeft(p.until)}</div>
        </div>
        <TableAction icon="play" label="Lift" title="Lift the pause now" disabled={lift.isPending} onClick={onLift} />
      </div>
    </div>
  );
}

function EffectRow({ e, handle, delay }: { e: ActiveEffect; handle: string; delay: number }) {
  const d = e.directive;
  const v = verificationChip(d);
  const detail = (d.verification?.detail ?? null) as { done?: number; planned?: number; slots?: number } | null;
  return (
    <div className="card row-lift compose-rise" style={{ ...row, animationDelay: `${delay}ms` }}>
      <span style={{ color: 'var(--color-ink-dim)', display: 'inline-flex' }} aria-hidden><Icon name={EFFECT_ICON[e.kind]} size={14} /></span>
      <div style={{ flex: '1 1 220px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
          <span className="chip" style={{ fontSize: 11 }}>{DIRECTIVE_KIND_LABEL[d.kind] ?? d.kind}</span>
          {d.binding === 'advice' ? <Badge tone="neutral">advice</Badge> : <Badge tone="warning">DIRECTIVE</Badge>}
          {v && <Badge tone={v.tone} title={v.title}>{v.label}</Badge>}
          <DirectiveLink id={d.id} />
        </div>
        <div className="text-body-sm" style={{ color: 'var(--color-ink)', overflowWrap: 'anywhere' }}>{e.text}</div>
        {e.kind === 'experiment' && detail?.slots != null && (
          <div className="text-micro tabular-nums" style={{ color: 'var(--color-ink-muted)' }}>
            {detail.done ?? 0} of {detail.slots} published · {detail.planned ?? 0} planned
          </div>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' }}>
        {e.until && (
          <div className="text-micro tabular-nums" style={{ textAlign: 'right', color: 'var(--color-ink-muted)' }} title={fmtDate(e.until)}>
            {e.kind === 'experiment' ? 'by' : 'until'} {shortDate(e.until)}<div style={{ color: 'var(--color-ink-dim)' }}>{timeLeft(e.until)}</div>
          </div>
        )}
        {e.version != null && (
          <Link to="/app/agents/$handle" params={{ handle }} search={{ tab: 'playbook' }} className="link-accent text-micro" style={{ whiteSpace: 'nowrap' }}>
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
    <SectionCard title="Active effects" icon="radar" delay={delay} style={{ marginBottom: 16 }}
      action={n > 0 ? <span className="text-micro tabular-nums" style={{ color: 'var(--color-ink-dim)' }}>{n} active</span> : undefined}>
      {err && <div className="callout-danger" style={{ marginBottom: 8 }}>{errorText(err)}</div>}
      {loading && <div style={{ height: 56, borderRadius: 'var(--radius-md)', background: 'var(--color-surface-1)', opacity: 0.6 }} />}
      {!loading && n === 0 && !err && (
        <p className="text-micro" style={{ margin: 0, color: 'var(--color-ink-dim)' }}>
          Nothing in force. Directives and followed advice from @manager that pause a resource or a series, change the playbook or open an experiment quota show up here until they end.
        </p>
      )}
      {n > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {pauses.map((p, i) => <PauseRow key={`p-${p.id}`} p={p} delay={i * 30} />)}
          {effects.map((e, i) => <EffectRow key={e.directive.id} e={e} handle={agent.handle} delay={(pauses.length + i) * 30} />)}
        </div>
      )}
    </SectionCard>
  );
}
