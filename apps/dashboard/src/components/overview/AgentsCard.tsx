// "Agents" card on the Overview (spec 029 FR-009): root agents by mode
// (off / shadow / approve / live) and paused, runs today and over 7 days with the
// success rate, posts published vs shadowed vs awaiting approval, and the
// MANAGER's directives. Every number links to the page it comes from.

import { Link } from '@tanstack/react-router';
import type { CSSProperties, ReactNode } from 'react';
import { SectionCard, EmptyState } from '../ui/primitives';
import { Icon } from '../ui/Icon';
import { describeError } from '../ui/Toast';
import { useAgentsOverview, type AgentsOverview } from '../../api/spend';
import { cardView, fmtRate } from '../../lib/spend';

const cell: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, padding: '10px 12px',
  borderRadius: 'var(--radius-md)', background: 'var(--color-surface-1)', border: '1px solid var(--color-hairline)',
  textDecoration: 'none', color: 'inherit',
};
const eyebrow: CSSProperties = { color: 'var(--color-ink-dim)', textTransform: 'uppercase', letterSpacing: '0.04em' };

function Big({ children, tone }: { children: ReactNode; tone?: string }) {
  return <span className="tabular-nums" style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.02em', color: tone ?? 'var(--color-ink)', lineHeight: 1.15 }}>{children}</span>;
}

function Sub({ children }: { children: ReactNode }) {
  return <span className="text-micro tabular-nums" style={{ color: 'var(--color-ink-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{children}</span>;
}

const MODES: Array<{ key: keyof AgentsOverview['agents']['byMode']; label: string; color: string }> = [
  { key: 'live',    label: 'Live',    color: 'var(--color-success)' },
  { key: 'approve', label: 'Approve', color: 'var(--color-tg-link)' },
  { key: 'shadow',  label: 'Shadow',  color: 'var(--color-warning)' },
  { key: 'off',     label: 'Off',     color: 'var(--color-ink-dim)' },
];

function Body({ d }: { d: AgentsOverview }) {
  const rate = d.runs.successRate7d;
  const rateTone = rate == null ? undefined : rate >= 90 ? 'var(--color-success)' : rate >= 70 ? 'var(--color-warning)' : 'var(--color-danger)';
  const waiting = d.posts.awaitingApproval;
  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
        {MODES.map((m) => (
          <Link key={m.key} to="/app/agents" className="btn-tiny" title={`Root agents in ${m.label.toLowerCase()} mode`}
            style={{ gap: 6, opacity: d.agents.byMode[m.key] ? 1 : 0.55 }}>
            <span aria-hidden style={{ width: 7, height: 7, borderRadius: 999, background: m.color }} />
            {m.label} <span className="tabular-nums" style={{ color: 'var(--color-ink)', fontWeight: 600 }}>{d.agents.byMode[m.key]}</span>
          </Link>
        ))}
        <Link to="/app/agents" className="btn-tiny" title="Paused root agents" style={{ gap: 6, opacity: d.agents.paused ? 1 : 0.55 }}>
          <Icon name="pause" size={11} /> Paused <span className="tabular-nums" style={{ color: 'var(--color-ink)', fontWeight: 600 }}>{d.agents.paused}</span>
        </Link>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 140px), 1fr))', gap: 8 }}>
        <Link to="/app/editor" style={cell} className="row-lift" title="Editor runs (Kyiv day / last 7 days)">
          <span className="text-micro" style={eyebrow}>Runs</span>
          <Big>{d.runs.today}</Big>
          <Sub>today · {d.runs.d7} in 7 days</Sub>
        </Link>
        <Link to="/app/editor" style={cell} className="row-lift" title="ok / (finished − disabled), last 7 days">
          <span className="text-micro" style={eyebrow}>Success 7d</span>
          <Big tone={rateTone}>{fmtRate(rate)}</Big>
          <Sub>{d.runs.errors7d} errors{d.runs.budgetExceeded7d ? ` · ${d.runs.budgetExceeded7d} over budget` : ''}</Sub>
        </Link>
        <Link to="/app/scheduled" style={cell} className="row-lift" title="Agent posts: published / shadowed">
          <span className="text-micro" style={eyebrow}>Posts today</span>
          <Big>{d.posts.today.published}</Big>
          <Sub>published · {d.posts.today.shadowed} shadowed</Sub>
        </Link>
        <Link to="/app/scheduled" style={cell} className="row-lift" title="Agent posts over the last 7 days">
          <span className="text-micro" style={eyebrow}>Posts 7d</span>
          <Big>{d.posts.d7.published}</Big>
          <Sub>published · {d.posts.d7.shadowed} shadowed</Sub>
        </Link>
        <Link to="/app/agents/inbox" search={{ tab: 'approvals' }} style={cell} className="row-lift" title="Posts waiting for your approval">
          <span className="text-micro" style={eyebrow}>Awaiting approval</span>
          <Big tone={waiting ? 'var(--color-warning)' : undefined}>{waiting}</Big>
          <Sub>{waiting ? 'review now' : 'nothing waiting'}</Sub>
        </Link>
        <Link to="/app/agents/$handle" params={{ handle: 'manager' }} search={{ tab: 'directives' }} style={cell} className="row-lift" title="MANAGER directives: open now; applied and worked over 30 days">
          <span className="text-micro" style={eyebrow}>Directives</span>
          <Big tone={d.directives.awaitingOwner ? 'var(--color-warning)' : undefined}>{d.directives.open}</Big>
          <Sub>{d.directives.awaitingOwner ? `${d.directives.awaitingOwner} await you · ` : ''}{d.directives.applied30d} applied · {d.directives.worked30d} worked (30d)</Sub>
        </Link>
      </div>
    </>
  );
}

export function AgentsCard({ delay }: { delay?: number }) {
  const q = useAgentsOverview();
  const view = cardView(q, (d) => d.agents.total === 0);
  return (
    <SectionCard delay={delay} icon="agents" title="Agents"
      action={<Link to="/app/agents" className="link-accent text-micro" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>All agents <Icon name="chevron-right" size={11} /></Link>}>
      {view === 'error' && <div className="callout-danger">{describeError(q.error)}</div>}
      {view === 'loading' && <div aria-busy style={{ height: 168, borderRadius: 'var(--radius-md)', background: 'var(--color-surface-1)', opacity: 0.6 }} />}
      {view === 'empty' && (
        <EmptyState icon="agents" title="No agents yet"
          note="Connect a channel and give it an orchestrator on the Agents page; runs, posts and directives appear here." />
      )}
      {view === 'data' && q.data && <Body d={q.data} />}
    </SectionCard>
  );
}
