import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { PageHeader } from '../components/ui/PageHeader';
import { Crumbs } from '../components/ui/Crumbs';
import { useCrumbs } from '../nav/hooks';
import { EmptyState } from '../components/ui/primitives';
import { Badge } from '../components/ui/Badge';
import { Icon } from '../components/ui/Icon';
import { describeError, toast } from '../components/ui/Toast';
import { AgentTabs } from '../components/agents/AgentTabs';
import { AgentGlyph, KIND_LABEL, PauseButton, ScopeChip, StateBadges } from '../components/agents/AgentsUi';
import { AgentEditDialog, AgentOverview } from '../components/agents/AgentOverview';
import { AgentSettings } from '../components/agents/AgentSettings';
import { ActiveEffects } from '../components/agents/ActiveEffects';
import '../components/agents/agent-detail.css';
import { AgentSkills } from '../components/agents/AgentSkills';
import { AgentLoadout } from '../components/agents/AgentLoadout';
import { AgentHistory, AgentMemory } from '../components/agents/AgentMemoryHistory';
import { AgentPlaybook } from '../components/agents/AgentPlaybook';
import { AgentIdeas } from '../components/agents/AgentIdeas';
import { AgentPlan } from '../components/agents/AgentPlan';
import { AgentSchedule } from '../components/agents/AgentSchedule';
import { AgentInbox, ManagerDirectives } from '../components/agents/Directives';
import { ManagerReviews } from '../components/agents/ManagerReviews';
import { AgentPromo } from '../components/agents/AgentPromo';
import { ApprovalList } from '../components/approvals/ApprovalList';
import { ApprovalStatsPanel } from '../components/approvals/ApprovalStatsPanel';
import { AgentSetupButton } from '../components/setup/AgentSetupButton';
import { ConnectionBanner } from '../components/agents/ConnectionBanner';
import { ArtifactList } from '../components/artifacts/ArtifactList';
import { errorBody, useAgent, useRunAgent } from '../api/agents';
import { useRunManager, type DirectiveBinding } from '../api/manager';
import { directiveFilterSearch, parseDirectiveFilters, type DirectiveFilters } from '../lib/directive-view';
import { MANAGER_TABS, isAgentTab, resolveTab, tabContext, tabSearch, type AgentTab } from '../lib/agent-tabs';

type Tab = AgentTab;

export const Route = createFileRoute('/app/agents_/$handle')({
  validateSearch: (s: Record<string, unknown>): { tab?: Tab; idea?: string; directive?: string; binding?: DirectiveBinding; kind?: string } => ({
    tab: isAgentTab(s.tab) ? s.tab : undefined,
    // Ideas tab: an idea to scroll to (from a plan slot).
    idea: typeof s.idea === 'string' && s.idea ? s.idea : undefined,
    // Directives tab (@manager): a directive to scroll to (from a review or an Inbox entry; `d` is the short alias).
    directive: typeof s.directive === 'string' && s.directive ? s.directive : typeof s.d === 'string' && s.d ? s.d : undefined,
    // Directives / Inbox tabs (spec 025 FR-019): binding and kind filters, kept in the URL.
    ...directiveFilterSearch(parseDirectiveFilters(s)),
  }),
  component: AgentPage,
});

function AgentPage() {
  const { handle } = Route.useParams();
  const search = Route.useSearch();
  const { tab: rawTab = 'overview', idea, directive } = search;
  const navigate = useNavigate({ from: Route.fullPath });
  const q = useAgent(handle);
  const run = useRunAgent();
  const [editing, setEditing] = useState(false);
  const runManager = useRunManager();
  const setTab = (t: Tab) => navigate({ search: tabSearch(t), replace: true });
  const openIdea = (id: string) => navigate({ search: { tab: 'ideas', idea: id }, replace: false });
  const filters = parseDirectiveFilters(search);
  const setFilters = (f: DirectiveFilters) => navigate({ search: (s) => ({ ...s, ...directiveFilterSearch(f) }), replace: true });

  // A handle alias resolved to the agent's current handle: move the URL along.
  const current = q.data?.agent.handle;
  useEffect(() => {
    if (current && current !== handle) navigate({ to: '/app/agents/$handle', params: { handle: current }, search: (s) => s, replace: true });
  }, [current, handle, navigate]);

  // Spec 027 FR-013: breadcrumbs instead of the ad-hoc back link.
  const crumbs = useCrumbs('agent-detail');
  const back = <Crumbs crumbs={crumbs} />;

  if (q.error) {
    const notFound = errorBody(q.error)?.error === 'agent_not_found';
    return <div>{back}{notFound
      ? <EmptyState icon="agents" title={`No agent @${handle}`} note="It may have been renamed more than 30 days ago, or removed." />
      : <div className="callout-danger">{describeError(q.error)}</div>}</div>;
  }
  if (!q.data) return <div>{back}<div className="panel compose-rise" style={{ height: 120, opacity: 0.55 }} /></div>;

  const d = q.data;
  const a = d.agent;
  // Playbook / ideas / plan belong to a network orchestrator; its role agents show the same (lib/agent-tabs.ts decides).
  const ctx = tabContext(a, d.parent);
  const orchestrator = a.kind === 'orchestrator' ? a.handle : d.parent?.handle ?? a.handle;
  const manager = a.kind === 'manager';
  const tab: Tab = resolveTab(rawTab, ctx);

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
              {a.kind === 'orchestrator' && d.channelKey && a.scopeId?.startsWith('telegram:') && <AgentSetupButton channelKey={d.channelKey} />}
              <button className="btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                disabled={running || a.paused} title={a.paused ? 'Resume the agent first' : 'Start a run now'} onClick={runNow}>
                <Icon name="rocket" size={14} /> Run now
              </button>
              <PauseButton agent={a} />
              <button className="btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => setEditing(true)}>
                <Icon name="pencil" size={14} /> Edit
              </button>
            </>}
          />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', margin: '-12px 0 16px' }}>
        <ScopeChip agent={a} />
        <StateBadges agent={a} follows={d.parent} />
        {a.status === 'active' && !a.paused && <Badge tone="success">active</Badge>}
      </div>
      {a.description && (
        <p className="text-body-sm" style={{ margin: '0 0 16px', color: 'var(--color-ink-muted)', maxWidth: 760, whiteSpace: 'pre-wrap' }}>{a.description}</p>
      )}

      {/* Spec 049 FR-002: the resource's connection is broken (or expiring): since when, and where to fix it. */}
      {!manager && a.kind !== 'builder' && a.kind !== 'auditor' && <ConnectionBanner handle={a.handle} />}

      <AgentTabs tab={tab} ctx={ctx} onChange={setTab} />

      {manager && a.mode === 'off' && MANAGER_TABS.includes(tab) && (
        <div className="callout-warning" style={{ marginBottom: 14, alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <span style={{ flex: '1 1 240px' }}>@manager is <strong>off</strong>: no scheduled reviews and no new directives. Switch it to Shadow (directives are filed but nothing structural acts) or Live on the Overview tab.</span>
          <button type="button" className="btn-tiny" onClick={() => setTab('overview')}>Open Overview</button>
        </div>
      )}

      <AgentEditDialog data={d} open={editing} onClose={() => setEditing(false)} />
      {tab === 'overview' && <AgentOverview data={d} />}
      {tab === 'settings' && <AgentSettings data={d} />}
      {tab === 'effects' && <ActiveEffects agent={a} delay={0} />}
      {tab === 'approvals' && d.channelKey && <ApprovalStatsPanel channel={d.channelKey} />}
      {tab === 'approvals' && (d.channelKey
        ? <ApprovalList filter={{ channel: d.channelKey }} emptyNote={`When @${orchestrator} is in approval mode, its posts wait here until they are published.`} />
        : <div className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>This agent has no Telegram channel.</div>)}
      {tab === 'reviews' && <ManagerReviews />}
      {tab === 'directives' && <ManagerDirectives focus={directive} filters={filters} onFilters={setFilters} />}
      {tab === 'artifacts' && (
        <ArtifactList filter={{ agent: a.handle }}
          empty={{ title: `Nothing shapes @${a.handle} yet`, note: `Type /setup @${a.handle} or /steer @${a.handle} @theirs in the chat, or tell the agent a rule.` }} />
      )}
      {tab === 'skills' && <AgentSkills data={d} />}
      {tab === 'loadout' && <AgentLoadout data={d} />}
      {tab === 'memory' && <AgentMemory data={d} />}
      {tab === 'history' && <AgentHistory data={d} />}
      {tab === 'playbook' && <AgentPlaybook handle={a.handle} orchestrator={orchestrator} />}
      {tab === 'schedule' && <AgentSchedule handle={a.handle} />}
      {tab === 'ideas' && <AgentIdeas handle={a.handle} focus={idea} />}
      {tab === 'plan' && <AgentPlan handle={a.handle} onIdea={openIdea} />}
      {tab === 'inbox' && <AgentInbox handle={orchestrator} filters={filters} onFilters={setFilters} />}
      {tab === 'promo' && <AgentPromo handle={a.handle} />}
    </div>
  );
}
