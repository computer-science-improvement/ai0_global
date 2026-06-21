import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { PageHeader } from '../components/ui/PageHeader';
import { SectionCard, EmptyState } from '../components/ui/primitives';
import { Badge } from '../components/ui/Badge';
import { SegmentedTabs } from '../components/SegmentedTabs';
import { TableAction, RowActions } from '../components/ui/table';
import { useAgentInbox, useAgentStatus, usePatchAgentThread } from '../api/agent';
import type { AgentCategory } from '../api/types';

export const Route = createFileRoute('/app/agent')({ component: AgentPage });

type CatFilter = 'all' | AgentCategory;

const CAT_TONE: Record<AgentCategory, 'accent' | 'success' | 'neutral' | 'warning'> = {
  ad:       'accent',
  vp:       'success',
  question: 'neutral',
  spam:     'warning',
  other:    'neutral',
};

const TABS: ReadonlyArray<{ key: CatFilter; label: string }> = [
  { key: 'all',      label: 'All' },
  { key: 'ad',       label: 'Ad' },
  { key: 'vp',       label: 'ВП' },
  { key: 'question', label: 'Questions' },
  { key: 'spam',     label: 'Spam' },
  { key: 'other',    label: 'Other' },
];

function AgentPage() {
  const [cat, setCat] = useState<CatFilter>('all');
  const status = useAgentStatus();
  const inbox  = useAgentInbox(cat === 'all' ? {} : { category: cat });
  const patch  = usePatchAgentThread();

  return (
    <div>
      <PageHeader
        title="Agent"
        subtitle="Incoming DMs triaged by the agent. Review drafts here — nothing is sent automatically."
      />

      <SectionCard title="Agent status" icon="bots" delay={20} style={{ marginBottom: 16 }}>
        {!status.data?.hasAgentSession ? (
          <EmptyState
            icon="bots"
            title="No agent session"
            note="Add an MTProto session and set its role to 'agent' in Connections → Sessions."
          />
        ) : (
          <div className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>
            Polling {status.data?.enabled ? 'on' : 'off'} · cadence {status.data?.cadence} ·{' '}
            last polled{' '}
            {status.data?.lastPolledAt
              ? new Date(status.data.lastPolledAt).toLocaleString()
              : 'never'}
          </div>
        )}
      </SectionCard>

      <div style={{ marginBottom: 16 }}>
        <SegmentedTabs<CatFilter> value={cat} onChange={setCat} options={TABS} />
      </div>

      {inbox.data && inbox.data.length === 0 && (
        <EmptyState
          icon="bots"
          title="Inbox empty"
          note="Triaged DM threads will show up here."
        />
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {inbox.data?.map((t) => (
          <div
            key={t.id}
            className="card row-lift"
            style={{ display: 'flex', alignItems: 'flex-start', gap: 16, padding: '13px 18px' }}
          >
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span
                  className="text-body"
                  style={{ color: 'var(--color-ink)', fontWeight: 500 }}
                >
                  {t.peer_name ?? (t.peer_username ? '@' + t.peer_username : t.peer_id)}
                </span>
                <Badge tone={CAT_TONE[t.category]}>{t.category}</Badge>
                <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>
                  score {t.score}
                </span>
              </div>
              {t.summary && (
                <div
                  className="text-body-sm"
                  style={{ color: 'var(--color-ink-muted)', marginTop: 4 }}
                >
                  {t.summary}
                </div>
              )}
              {t.draft_reply && (
                <details style={{ marginTop: 6 }}>
                  <summary
                    className="text-micro"
                    style={{ color: 'var(--color-accent)', cursor: 'pointer' }}
                  >
                    Draft reply
                  </summary>
                  <div
                    className="text-body-sm"
                    style={{ color: 'var(--color-ink)', marginTop: 4, whiteSpace: 'pre-wrap' }}
                  >
                    {t.draft_reply}
                  </div>
                </details>
              )}
            </div>
            <RowActions
              danger={
                <TableAction
                  icon="trash"
                  danger
                  title="Archive"
                  onClick={() => patch.mutate({ id: t.id, status: 'archived' })}
                />
              }
            >
              <TableAction
                icon="check"
                title="Mark reviewed"
                onClick={() => patch.mutate({ id: t.id, status: 'reviewed' })}
              />
            </RowActions>
          </div>
        ))}
      </div>
    </div>
  );
}
