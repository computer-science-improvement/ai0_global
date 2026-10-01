import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { PageHeader } from '../components/ui/PageHeader';
import { SectionCard, StatTile, EmptyState } from '../components/ui/primitives';
import { Badge } from '../components/ui/Badge';
import { Icon } from '../components/ui/Icon';
import { describeError } from '../components/ui/Toast';
import { fmtUsd } from '../components/editor/EditorUi';
import { AgentGlyph, KIND_LABEL, LastRun, ScopeChip, StateBadges, runsLabel } from '../components/agents/AgentsUi';
import { useAgentInbox, useAgentTree, type AgentNode } from '../api/agents';

export const Route = createFileRoute('/app/agents')({ component: AgentsPage });

function InboxButton() {
  const inbox = useAgentInbox(true);
  const unread = inbox.data?.items.length ?? 0;
  return (
    <Link to="/app/agents/inbox" className="btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}>
      <Icon name="inbox" size={14} /> Inbox
      {unread > 0 && <Badge tone="accent">{unread}</Badge>}
    </Link>
  );
}

function AgentsPage() {
  const tree = useAgentTree();
  const all = tree.data?.agents ?? [];
  const system = all.filter((a) => a.kind === 'manager' || a.kind === 'builder');
  const orchestrators = all.filter((a) => a.kind !== 'manager' && a.kind !== 'builder');
  const spend = all.reduce((s, a) => s + a.activity.spentTodayUsd + a.children.reduce((c, k) => c + k.activity.spentTodayUsd, 0), 0);
  const runs = all.reduce((s, a) => s + a.activity.runsToday + a.children.reduce((c, k) => c + k.activity.runsToday, 0), 0);
  const live = orchestrators.filter((a) => a.mode === 'live').length;
  const paused = orchestrators.filter((a) => a.paused).length;

  return (
    <div>
      <PageHeader title="Agents" subtitle="Named agents per resource and network: profiles, skills, memory and run history" actions={<InboxButton />} />

      {tree.error && <div className="callout-danger" style={{ marginBottom: 16 }}>{describeError(tree.error)}</div>}
      {!tree.data && !tree.error && <div className="panel compose-rise" style={{ height: 120, opacity: 0.55 }} />}

      {tree.data && (
        <div className="stat-grid compose-rise" style={{ marginBottom: 18 }}>
          <StatTile label="Orchestrators" value={orchestrators.length} icon="agents" accent delta={`${live} live · ${orchestrators.length - live} not live`} />
          <StatTile label="Paused" value={paused} icon="pause" deltaTone={paused ? 'warning' : 'neutral'} delta={paused ? 'skipping their runs' : undefined} />
          <StatTile label="Runs today" value={runs} icon="logs" />
          <StatTile label="Spend today" value={fmtUsd(spend)} icon="analytics" />
        </div>
      )}

      {system.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))', gap: 12, marginBottom: 16 }}>
          {system.map((a, i) => <SystemCard key={a.id} a={a} delay={i * 40} />)}
        </div>
      )}

      {tree.data && (
        <SectionCard title="Orchestrators" icon="agents" delay={80}>
          {orchestrators.length === 0
            ? <EmptyState icon="agents" title="No orchestrators yet" note="Agents are created from editor cards or in the chat with @ai0." />
            : <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {orchestrators.map((a, i) => <OrchestratorRow key={a.id} a={a} delay={120 + i * 40} />)}
              </div>}
        </SectionCard>
      )}
    </div>
  );
}

function SystemCard({ a, delay }: { a: AgentNode; delay: number }) {
  return (
    <Link to="/app/agents/$handle" params={{ handle: a.handle }} className="card row-lift compose-rise"
      style={{ display: 'flex', gap: 14, alignItems: 'flex-start', padding: '14px 18px', textDecoration: 'none', color: 'inherit', animationDelay: `${delay}ms`, minWidth: 0 }}>
      <AgentGlyph agent={a} size={42} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 3 }}>
          <span style={{ color: 'var(--color-ink)', fontWeight: 600 }}>{a.name}</span>
          <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>@{a.handle}</span>
          <StateBadges agent={a} />
        </div>
        <div className="text-micro" style={{ color: 'var(--color-ink-dim)', marginBottom: 6 }}>{KIND_LABEL[a.kind]} · system</div>
        {a.description && <div className="text-body-sm" style={{ color: 'var(--color-ink-muted)', marginBottom: 8, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{a.description}</div>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span className="text-micro tabular-nums" style={{ color: 'var(--color-ink-muted)' }}>{fmtUsd(a.activity.spentTodayUsd)} · {runsLabel(a.activity.runsToday)} today</span>
          <LastRun activity={a.activity} />
        </div>
      </div>
    </Link>
  );
}

function OrchestratorRow({ a, delay }: { a: AgentNode; delay: number }) {
  const [open, setOpen] = useState(false);
  const childSpend = a.children.reduce((s, c) => s + c.activity.spentTodayUsd, 0);
  const childRuns = a.children.reduce((s, c) => s + c.activity.runsToday, 0);
  return (
    <div className="card compose-rise" style={{ padding: 0, animationDelay: `${delay}ms`, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 16px', flexWrap: 'wrap' }}>
        <AgentGlyph agent={a} />
        <div style={{ minWidth: 180, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
            <Link to="/app/agents/$handle" params={{ handle: a.handle }} style={{ color: 'var(--color-ink)', fontWeight: 600, textDecoration: 'none' }}>{a.name}</Link>
            <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>@{a.handle}</span>
            <StateBadges agent={a} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
            <ScopeChip agent={a} />
            <LastRun activity={a.activity} />
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginLeft: 'auto' }}>
        <div className="tabular-nums" style={{ textAlign: 'right', minWidth: 90 }}>
          <div style={{ fontWeight: 600 }}>{fmtUsd(a.activity.spentTodayUsd + childSpend)}</div>
          <div className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{runsLabel(a.activity.runsToday + childRuns)} today</div>
        </div>
        <div style={{ display: 'inline-flex', gap: 6 }}>
          {a.children.length > 0 && (
            <button type="button" className="btn-act" aria-expanded={open} title={open ? 'Hide roles' : `Show roles (${a.children.length})`} aria-label={open ? 'Hide roles' : 'Show roles'} onClick={() => setOpen((v) => !v)}>
              <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} />
            </button>
          )}
          <Link to="/app/agents/$handle" params={{ handle: a.handle }} className="btn-act" title="Open agent" aria-label="Open agent">
            <Icon name="chevron-right" size={14} />
          </Link>
        </div>
        </div>
      </div>
      {open && (
        <div style={{ borderTop: '1px solid var(--color-hairline-soft)', background: 'var(--color-surface-1)', padding: '6px 10px' }}>
          {a.children.map((c, i) => <ChildRow key={c.id} c={c} delay={i * 30} />)}
        </div>
      )}
    </div>
  );
}

function ChildRow({ c, delay }: { c: AgentNode; delay: number }) {
  return (
    <Link to="/app/agents/$handle" params={{ handle: c.handle }} className="row-lift compose-rise"
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 8px', borderRadius: 'var(--radius-sm)', textDecoration: 'none', color: 'inherit', flexWrap: 'wrap', animationDelay: `${delay}ms` }}>
      <AgentGlyph agent={c} size={26} />
      <div style={{ minWidth: 140, flex: 1, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span className="text-body-sm" style={{ color: 'var(--color-ink)', fontWeight: 500 }}>{KIND_LABEL[c.kind]}</span>
        <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>@{c.handle}</span>
        {c.paused && <Badge tone="danger">paused</Badge>}
      </div>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, marginLeft: 'auto' }}>
        <LastRun activity={c.activity} />
        <span className="text-micro tabular-nums" style={{ color: 'var(--color-ink-muted)', minWidth: 96, textAlign: 'right' }}>
          {fmtUsd(c.activity.spentTodayUsd)} · {runsLabel(c.activity.runsToday)}
        </span>
      </span>
    </Link>
  );
}
