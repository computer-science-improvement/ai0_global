import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { PageHeader } from '../components/ui/PageHeader';
import { useCrumbs } from '../nav/hooks';
import { SectionCard, EmptyState } from '../components/ui/primitives';
import { Badge } from '../components/ui/Badge';
import { Icon } from '../components/ui/Icon';
import { TableAction, RowActions } from '../components/ui/table';
import { describeError } from '../components/ui/Toast';
import { SegmentedTabs } from '../components/SegmentedTabs';
import { indexTree } from '../components/agents/AgentsUi';
import { fmtDate, fmtRelative } from '../lib/format';
import { useAgentInbox, useAgentTree, useMarkInboxRead, type InboxItem } from '../api/agents';
import { useApprovalsCount } from '../api/approvals';
import { ApprovalList } from '../components/approvals/ApprovalList';
import { NETWORK_OFFER_KIND, NetworkOfferActions } from '../components/agents/NetworkOfferActions';
import { inboxTarget } from '../lib/directive-view';

type InboxTab = 'approvals' | 'unread' | 'all';

export const Route = createFileRoute('/app/agents_/inbox')({
  // ?tab=approvals — "Posts to approve" (spec 031); the owner's Telegram alert links here.
  validateSearch: (s: Record<string, unknown>): { tab?: InboxTab } => ({
    tab: s.tab === 'approvals' || s.tab === 'all' || s.tab === 'unread' ? s.tab : undefined,
  }),
  component: InboxPage,
});

const SEVERITY_TONE: Record<InboxItem['severity'], 'neutral' | 'warning' | 'danger'> = { info: 'neutral', action: 'warning', critical: 'danger' };

function InboxPage() {
  const { tab } = Route.useSearch();
  const navigate = Route.useNavigate();
  const waiting = useApprovalsCount().data?.waiting ?? 0;
  const crumbs = useCrumbs('agents-inbox');
  const [filterState, setFilterState] = useState<'unread' | 'all'>('unread');
  const view: InboxTab = tab ?? filterState;
  const filter: 'unread' | 'all' = view === 'all' ? 'all' : 'unread';
  const setView = (v: InboxTab) => {
    if (v !== 'approvals') setFilterState(v);
    navigate({ search: { tab: v === 'unread' ? undefined : v }, replace: true });
  };
  const inbox = useAgentInbox(filter === 'unread');
  const unread = useAgentInbox(true);
  const tree = useAgentTree();
  const mark = useMarkInboxRead();
  const byId = indexTree(tree.data?.agents);
  const items = inbox.data?.items ?? [];
  const unreadCount = unread.data?.items.length ?? 0;

  return (
    <div>
      <PageHeader crumbs={crumbs} title="Agent inbox" subtitle="What the agents want you to know: skill self-edits, rollbacks and things that need a decision"
        actions={
          <button className="btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} disabled={mark.isPending || unreadCount === 0} onClick={() => mark.mutate('all')}>
            <Icon name="check" size={14} /> Mark all read
          </button>
        } />

      <div style={{ marginBottom: 16 }}>
        <SegmentedTabs value={view} onChange={setView} options={[
          { key: 'approvals', label: `Posts to approve${waiting ? ` · ${waiting}` : ''}` },
          { key: 'unread', label: `Unread${unreadCount ? ` · ${unreadCount}` : ''}` },
          { key: 'all', label: 'All' },
        ]} />
      </div>

      {view === 'approvals' && (
        <SectionCard title="Posts to approve" icon="check" delay={0}>
          <ApprovalList />
        </SectionCard>
      )}

      {view !== 'approvals' && inbox.error && <div className="callout-danger" style={{ marginBottom: 16 }}>{describeError(inbox.error)}</div>}
      {view !== 'approvals' && !inbox.data && !inbox.error && <div className="panel compose-rise" style={{ height: 120, opacity: 0.55 }} />}

      {view !== 'approvals' && inbox.data && (
        <SectionCard title={filter === 'unread' ? 'Unread' : 'All messages'} icon="inbox" delay={0}>
          {items.length === 0
            ? <EmptyState icon="inbox" title={filter === 'unread' ? 'Nothing unread' : 'The inbox is empty'} note="Agents post here when they change a skill, a change is rolled back, or something needs your decision." />
            : <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {items.map((it, i) => {
                  const agent = it.agentId ? byId.get(it.agentId) : undefined;
                  const target = inboxTarget(it, agent?.handle ?? null);
                  return (
                    <div key={it.id} className="card row-lift compose-rise" style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '11px 14px', animationDelay: `${Math.min(i, 12) * 30}ms`, opacity: it.readAt ? 0.7 : 1 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 4 }}>
                          {!it.readAt && <span aria-label="unread" title="unread" style={{ width: 7, height: 7, borderRadius: 'var(--radius-pill)', background: 'var(--color-accent)' }} />}
                          <Badge tone={SEVERITY_TONE[it.severity]}>{it.severity}</Badge>
                          <span className="chip" style={{ fontSize: 11 }}>{it.kind}</span>
                          {agent && (
                            <Link to="/app/agents/$handle" params={{ handle: agent.handle }} className="link-accent text-micro">
                              {agent.emoji ? `${agent.emoji} ` : ''}@{agent.handle}
                            </Link>
                          )}
                          <span className="text-micro" style={{ color: 'var(--color-ink-dim)', marginLeft: 'auto' }} title={fmtDate(it.createdAt)}>{fmtRelative(it.createdAt)}</span>
                        </div>
                        <div className="text-body-sm" style={{ color: 'var(--color-ink)', fontWeight: 500, overflowWrap: 'anywhere' }}>{it.title}</div>
                        {it.body && <div className="text-body-sm" style={{ color: 'var(--color-ink-muted)', marginTop: 3, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{it.body}</div>}
                        {agent && it.refType === 'skill' && (
                          <Link to="/app/agents/$handle" params={{ handle: agent.handle }} search={{ tab: 'skills' }} className="link-accent text-micro" style={{ display: 'inline-block', marginTop: 4 }}>
                            Open skills →
                          </Link>
                        )}
                        {agent && it.kind === 'ready_for_autonomy' && (
                          <Link to="/app/agents/$handle" params={{ handle: agent.handle }} className="link-accent text-micro" style={{ display: 'inline-block', marginTop: 4 }}>
                            Review and switch →
                          </Link>
                        )}
                        {agent && it.kind === NETWORK_OFFER_KIND && it.refId && (
                          <NetworkOfferActions groupId={it.refId} handle={agent.handle} onDone={() => { if (!it.readAt) mark.mutate([it.id]); }} />
                        )}
                        {it.kind === 'landing_lead' && (
                          <Link to="/app/landing" search={{ tab: 'leads' }} className="link-accent text-micro" style={{ display: 'inline-block', marginTop: 4 }}>
                            Open leads →
                          </Link>
                        )}
                        {target?.to === 'directive' && (
                          <Link to="/app/agents/$handle" params={{ handle: 'manager' }} search={{ tab: 'directives', directive: target.id }}
                            className="link-accent text-micro" style={{ display: 'inline-block', marginTop: 4 }}>
                            {it.kind === 'directive_contested' ? 'Decide on the directive →' : 'Open directive →'}
                          </Link>
                        )}
                        {target?.to === 'pauses' && target.handle && (
                          <Link to="/app/agents/$handle" params={{ handle: target.handle }} className="link-accent text-micro" style={{ display: 'inline-block', marginTop: 4 }}>
                            Open active effects →
                          </Link>
                        )}
                        {it.refType === 'run' && it.refId && (
                          <Link to="/app/editor/run/$id" params={{ id: it.refId }} className="link-accent text-micro" style={{ display: 'inline-block', marginTop: 4 }}>
                            Open run →
                          </Link>
                        )}
                      </div>
                      {!it.readAt && (
                        <RowActions>
                          <TableAction icon="check" title="Mark read" disabled={mark.isPending} onClick={() => mark.mutate([it.id])} />
                        </RowActions>
                      )}
                    </div>
                  );
                })}
              </div>}
        </SectionCard>
      )}
    </div>
  );
}
