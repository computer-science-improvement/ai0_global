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
import { AgentPlaybook } from '../components/agents/AgentPlaybook';
import { AgentIdeas } from '../components/agents/AgentIdeas';
import { AgentPlan } from '../components/agents/AgentPlan';
import { AgentInbox, ManagerDirectives } from '../components/agents/Directives';
import { ManagerReviews } from '../components/agents/ManagerReviews';
import { AgentPromo } from '../components/agents/AgentPromo';
import { ApprovalList } from '../components/approvals/ApprovalList';
import { ApprovalStatsPanel } from '../components/approvals/ApprovalStatsPanel';
import { errorBody, useAgent, useRunAgent } from '../api/agents';
import { useRunManager } from '../api/manager';

const TABS = ['overview', 'approvals', 'reviews', 'directives', 'skills', 'memory', 'history', 'playbook', 'ideas', 'plan', 'inbox', 'promo'] as const;
type Tab = typeof TABS[number];
const NETWORK_TABS: readonly Tab[] = ['approvals', 'playbook', 'ideas', 'plan', 'inbox', 'promo'];
const MANAGER_TABS: readonly Tab[] = ['reviews', 'directives'];

const TAB_OPTIONS = [
  { key: 'overview' as const, label: 'Overview', icon: 'overview' as const },
  { key: 'approvals' as const, label: 'Posts to approve', icon: 'check' as const },
  { key: 'reviews' as const,  label: 'Reviews',  icon: 'history' as const },
  { key: 'directives' as const, label: 'Directives', icon: 'agents' as const },
  { key: 'skills' as const,   label: 'Skills',   icon: 'book' as const },
  { key: 'memory' as const,   label: 'Memory',   icon: 'bots' as const },
  { key: 'history' as const,  label: 'History',  icon: 'history' as const },
  { key: 'playbook' as const, label: 'Playbook', icon: 'logs' as const },
  { key: 'ideas' as const,    label: 'Ideas',    icon: 'sparkles' as const },
  { key: 'plan' as const,     label: 'Plan',     icon: 'calendar' as const },
  { key: 'inbox' as const,    label: 'Inbox',    icon: 'inbox' as const },
  { key: 'promo' as const,    label: 'Promo',    icon: 'megaphone' as const },
];

export const Route = createFileRoute('/app/agents_/$handle')({
  validateSearch: (s: Record<string, unknown>): { tab?: Tab; idea?: string; directive?: string } => ({
    tab: (TABS as readonly string[]).includes(String(s.tab)) ? (s.tab as Tab) : undefined,
    // Ideas tab: an idea to scroll to (from a plan slot).
    idea: typeof s.idea === 'string' && s.idea ? s.idea : undefined,
    // Directives tab (@manager): a directive to scroll to (from a review).
    directive: typeof s.directive === 'string' && s.directive ? s.directive : undefined,
  }),
  component: AgentPage,
});

function AgentPage() {
  const { handle } = Route.useParams();
  const { tab: rawTab = 'overview', idea, directive } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const q = useAgent(handle);
  const run = useRunAgent();
  const runManager = useRunManager();
  const setTab = (t: Tab) => navigate({ search: { tab: t === 'overview' ? undefined : t }, replace: true });
  const openIdea = (id: string) => navigate({ search: { tab: 'ideas', idea: id }, replace: false });

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
  // Playbook / ideas / plan belong to a network orchestrator; its role agents show the same.
  const networked = a.kind === 'orchestrator' || (!!d.parent && a.parentId != null);
  const orchestrator = a.kind === 'orchestrator' ? a.handle : d.parent?.handle ?? a.handle;
  const manager = a.kind === 'manager';
  const hidden = (t: Tab) => (!networked && NETWORK_TABS.includes(t)) || (!manager && MANAGER_TABS.includes(t));
  const tab: Tab = hidden(rawTab) ? 'overview' : rawTab;
  const tabOptions = TAB_OPTIONS.filter((o) => !hidden(o.key));
  const edit = () => {
    setTab('overview');
    setTimeout(() => {
      const el = document.getElementById('agent-name') as HTMLInputElement | null;
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el?.focus({ preventScroll: true });
    }, 60);
  };

  const runNow = () => manager
    // The MANAGER has its own run endpoint (reads the KPI digest; may file directives).
    ? runManager.mutate(undefined, {
        onSuccess: () => toast.success('@manager run started — its review appears on the Reviews tab in a minute'),
        onError: (e) => toast.error(errorBody(e)?.error === 'manager_off'
          ? '@manager is off — switch it to Shadow or Live on the Overview tab first'
          : describeError(e)),
      })
    : run.mutate(a.handle, {
        onError: (e) => toast.error(errorBody(e)?.error === 'agent_paused' ? `@${a.handle} is paused — resume it first` : describeError(e)),
      });
  const running = manager ? runManager.isPending : run.isPending;

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
                disabled={running || a.paused} title={a.paused ? 'Resume the agent first' : 'Start a run now'} onClick={runNow}>
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
        <SegmentedTabs value={tab} onChange={setTab} options={tabOptions} />
      </div>

      {manager && a.mode === 'off' && MANAGER_TABS.includes(tab) && (
        <div className="callout-warning" style={{ marginBottom: 14, alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <span style={{ flex: '1 1 240px' }}>@manager is <strong>off</strong>: no scheduled reviews and no new directives. Switch it to Shadow (directives are filed but nothing structural acts) or Live on the Overview tab.</span>
          <button type="button" className="btn-tiny" onClick={() => setTab('overview')}>Open Overview</button>
        </div>
      )}

      {tab === 'overview' && <AgentOverview data={d} />}
      {tab === 'approvals' && d.channelKey && <ApprovalStatsPanel channel={d.channelKey} />}
      {tab === 'approvals' && (d.channelKey
        ? <ApprovalList filter={{ channel: d.channelKey }} emptyNote={`When @${orchestrator} is in approval mode, its posts wait here until they are published.`} />
        : <div className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>This agent has no Telegram channel.</div>)}
      {tab === 'reviews' && <ManagerReviews />}
      {tab === 'directives' && <ManagerDirectives focus={directive} />}
      {tab === 'skills' && <AgentSkills data={d} />}
      {tab === 'memory' && <AgentMemory data={d} />}
      {tab === 'history' && <AgentHistory data={d} />}
      {tab === 'playbook' && <AgentPlaybook handle={a.handle} orchestrator={orchestrator} />}
      {tab === 'ideas' && <AgentIdeas handle={a.handle} focus={idea} />}
      {tab === 'plan' && <AgentPlan handle={a.handle} onIdea={openIdea} />}
      {tab === 'inbox' && <AgentInbox handle={orchestrator} />}
      {tab === 'promo' && <AgentPromo handle={a.handle} />}
    </div>
  );
}
