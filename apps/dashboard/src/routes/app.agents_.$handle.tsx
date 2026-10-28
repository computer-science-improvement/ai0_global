import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Crumbs } from '../components/ui/Crumbs';
import { useCrumbs } from '../nav/hooks';
import { EmptyState } from '../components/ui/primitives';
import { describeError } from '../components/ui/Toast';
import { AgentTabs } from '../components/agents/AgentTabs';
import { AgentHeader } from '../components/agents/AgentHeader';
import { PauseBanners } from '../components/agents/PauseBanners';
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
import { ConnectionBanner } from '../components/agents/ConnectionBanner';
import { ArtifactList } from '../components/artifacts/ArtifactList';
import { errorBody, useAgent } from '../api/agents';
import type { DirectiveBinding } from '../api/manager';
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
  const [editing, setEditing] = useState(false);
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

  return (
    <div>
      {back}
      <AgentHeader data={d} onEdit={() => setEditing(true)} />

      {/* Spec 049 FR-002: the resource's connection is broken (or expiring): since when, and where to fix it. */}
      {!manager && a.kind !== 'builder' && a.kind !== 'auditor' && <ConnectionBanner handle={a.handle} />}
      {/* Spec 078 D6: paused series (Resume) and resources @manager paused (Lift), on every tab. */}
      <PauseBanners agent={a} />

      <AgentTabs tab={tab} ctx={ctx} onChange={setTab} />

      {manager && a.mode === 'off' && MANAGER_TABS.includes(tab) && (
        <div className="callout-warning" style={{ marginBottom: 14 }}>
          <span>@manager is <strong>off</strong>: no scheduled reviews and no new directives. Switch it to Shadow (directives are filed as previews; nothing acts on them) or Live with the mode switch above.</span>
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
