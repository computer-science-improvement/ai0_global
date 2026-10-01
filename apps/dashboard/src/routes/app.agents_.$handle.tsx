import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { PageHeader } from '../components/ui/PageHeader';
import { EmptyState } from '../components/ui/primitives';
import { Badge } from '../components/ui/Badge';
import { Icon } from '../components/ui/Icon';
import { describeError, toast } from '../components/ui/Toast';
import { SegmentedTabs } from '../components/SegmentedTabs';
import { AgentGlyph, KIND_LABEL, PauseButton, ScopeChip, StateBadges } from '../components/agents/AgentsUi';
import { AgentOverview } from '../components/agents/AgentOverview';
import { AgentSkills } from '../components/agents/AgentSkills';
import { AgentHistory, AgentMemory } from '../components/agents/AgentMemoryHistory';
import { errorBody, useAgent, useRunAgent } from '../api/agents';

const TABS = ['overview', 'skills', 'memory', 'history', 'playbook', 'plan'] as const;
type Tab = typeof TABS[number];

const TAB_OPTIONS = [
  { key: 'overview' as const, label: 'Overview', icon: 'overview' as const },
  { key: 'skills' as const,   label: 'Skills',   icon: 'book' as const },
  { key: 'memory' as const,   label: 'Memory',   icon: 'bots' as const },
  { key: 'history' as const,  label: 'History',  icon: 'history' as const },
  { key: 'playbook' as const, label: 'Playbook', icon: 'logs' as const },
  { key: 'plan' as const,     label: 'Plan',     icon: 'calendar' as const },
];

export const Route = createFileRoute('/app/agents_/$handle')({
  validateSearch: (s: Record<string, unknown>): { tab?: Tab } => ({
    tab: (TABS as readonly string[]).includes(String(s.tab)) ? (s.tab as Tab) : undefined,
  }),
  component: AgentPage,
});

function AgentPage() {
  const { handle } = Route.useParams();
  const { tab = 'overview' } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const q = useAgent(handle);
  const run = useRunAgent();
  const setTab = (t: Tab) => navigate({ search: { tab: t === 'overview' ? undefined : t }, replace: true });

  // A handle alias resolved to the agent's current handle: move the URL along.
  const current = q.data?.agent.handle;
  useEffect(() => {
    if (current && current !== handle) navigate({ to: '/app/agents/$handle', params: { handle: current }, search: (s) => s, replace: true });
  }, [current, handle, navigate]);

  const back = (
    <div className="text-micro" style={{ marginBottom: 10 }}>
      <Link to="/app/agents" className="link-accent">← Agents</Link>
    </div>
  );

  if (q.error) {
    const notFound = errorBody(q.error)?.error === 'agent_not_found';
    return <div>{back}{notFound
      ? <EmptyState icon="agents" title={`No agent @${handle}`} note="It may have been renamed more than 30 days ago, or removed." />
      : <div className="callout-danger">{describeError(q.error)}</div>}</div>;
  }
  if (!q.data) return <div>{back}<div className="panel compose-rise" style={{ height: 120, opacity: 0.55 }} /></div>;

  const d = q.data;
  const a = d.agent;
  const edit = () => {
    setTab('overview');
    setTimeout(() => {
      const el = document.getElementById('agent-name') as HTMLInputElement | null;
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el?.focus({ preventScroll: true });
    }, 60);
  };

  const runNow = () => run.mutate(a.handle, {
    onError: (e) => toast.error(errorBody(e)?.error === 'agent_paused' ? `@${a.handle} is paused — resume it first` : describeError(e)),
  });

  return (
    <div>
      {back}
      {d.parent && (
        <div className="text-micro" style={{ marginTop: -4, marginBottom: 10, color: 'var(--color-ink-dim)' }}>
          {KIND_LABEL[a.kind]} of{' '}
          <Link to="/app/agents/$handle" params={{ handle: d.parent.handle }} className="link-accent">
            {d.parent.emoji ? `${d.parent.emoji} ` : ''}{d.parent.name} · @{d.parent.handle}
          </Link>
        </div>
      )}
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
        <AgentGlyph agent={a} size={48} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <PageHeader
            title={a.name}
            subtitle={`@${a.handle} · ${KIND_LABEL[a.kind]}`}
            actions={<>
              <button className="btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                disabled={run.isPending || a.paused} title={a.paused ? 'Resume the agent first' : 'Start a run now'} onClick={runNow}>
                <Icon name="rocket" size={14} /> Run now
              </button>
              <PauseButton agent={a} />
              <button className="btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={edit}>
                <Icon name="pencil" size={14} /> Edit
              </button>
            </>}
          />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', margin: '-12px 0 16px' }}>
        <ScopeChip agent={a} />
        <StateBadges agent={a} />
        {a.status === 'active' && !a.paused && <Badge tone="success">active</Badge>}
      </div>
      {a.description && (
        <p className="text-body-sm" style={{ margin: '0 0 16px', color: 'var(--color-ink-muted)', maxWidth: 760, whiteSpace: 'pre-wrap' }}>{a.description}</p>
      )}

      <div style={{ marginBottom: 16, overflowX: 'auto', maxWidth: '100%' }}>
        <SegmentedTabs value={tab} onChange={setTab} options={TAB_OPTIONS} />
      </div>

      {tab === 'overview' && <AgentOverview data={d} />}
      {tab === 'skills' && <AgentSkills data={d} />}
      {tab === 'memory' && <AgentMemory data={d} />}
      {tab === 'history' && <AgentHistory data={d} />}
      {tab === 'playbook' && (
        <EmptyState icon="logs" title="No playbook yet" note="Arrives with spec 020: the owner’s brief becomes a structured, versioned playbook the orchestrator follows." />
      )}
      {tab === 'plan' && (
        <EmptyState icon="calendar" title="No network plan yet" note="Arrives with spec 020: the day plan across platforms (what · how · where · when)." />
      )}
    </div>
  );
}
