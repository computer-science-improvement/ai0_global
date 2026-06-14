import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { trackingApi } from '../api/tracking';
import { useMetaAccounts, useMetaFollowerHistory, useMetaAccountInsights } from '../api/meta-accounts';
import { channelOptionLabel } from '../lib/labels';
import { PageHeader } from '../components/ui/PageHeader';
import { Panel } from '../components/ui/Card';
import { Placeholder } from '../components/ui/Placeholder';
import { SubsHistoryChart } from '../components/SubsHistoryChart';
import { ViewsBarChart } from '../components/ViewsBarChart';
import { EngagementChart } from '../components/EngagementChart';
import { MetaReachImpressionsChart } from '../components/MetaReachImpressionsChart';
import { MetaProfileViewsChart } from '../components/MetaProfileViewsChart';
import { RoiPanel } from '../components/RoiPanel';

export const Route = createFileRoute('/analytics')({ component: AnalyticsPage });

type Tab = 'telegram' | 'meta';

function ChartEmpty({ note }: { note: string }) {
  return (
    <div className="card" style={{ textAlign: 'center', padding: 40 }}>
      <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)', margin: 0 }}>{note}</p>
    </div>
  );
}

function AnalyticsPage() {
  const [tab, setTab] = useState<Tab>('telegram');

  // Telegram
  const channelsQ = useQuery({
    queryKey: ['channels', 'mine', 'analytics'],
    queryFn: () => trackingApi.listChannels({ filter: 'mine', pageSize: 200 }),
  });
  const channels = channelsQ.data?.items ?? [];
  const [sel, setSel] = useState('');
  const channelId = sel || channels[0]?.id || '';
  const subsQ = useQuery({ queryKey: ['subs', channelId], queryFn: () => trackingApi.subsHistory(channelId), enabled: tab === 'telegram' && !!channelId });
  const postsQ = useQuery({ queryKey: ['posts', channelId, 'analytics'], queryFn: () => trackingApi.listPosts(channelId, 30), enabled: tab === 'telegram' && !!channelId });
  const points = subsQ.data?.points ?? [];
  const posts = postsQ.data?.items ?? [];

  // Meta
  const metaQ = useMetaAccounts();
  const metaAccounts = (metaQ.data ?? []).filter(a => a.active);
  const [metaSel, setMetaSel] = useState('');
  const metaId = metaSel || metaAccounts[0]?.id || '';
  const metaAcc = metaAccounts.find(a => a.id === metaId);
  const histQ = useMetaFollowerHistory(tab === 'meta' ? metaId : '');
  const insQ = useMetaAccountInsights(tab === 'meta' ? metaId : '');
  const followerPoints = histQ.data?.points ?? [];
  const insPoints = insQ.data?.points ?? [];
  const hasReach = insPoints.some(p => p.reach != null || p.impressions != null);
  const hasProfileViews = insPoints.some(p => p.profileViews != null);

  return (
    <div>
      <PageHeader
        title="Analytics"
        subtitle={tab === 'telegram' ? 'Telegram · my channels' : 'Meta · my accounts'}
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ display: 'inline-flex', gap: 4 }}>
              {(['telegram', 'meta'] as Tab[]).map(t => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className="btn-tiny"
                  style={{
                    border: '1px solid ' + (tab === t ? 'rgba(62, 207, 142, 0.3)' : 'transparent'),
                    background: tab === t ? 'var(--color-success-soft)' : 'transparent',
                    color: tab === t ? 'var(--color-accent)' : 'var(--color-ink-muted)',
                    textTransform: 'capitalize',
                  }}
                >
                  {t}
                </button>
              ))}
            </div>
            {tab === 'telegram' && channels.length > 0 && (
              <select className="input-field" value={channelId} onChange={e => setSel(e.target.value)} style={{ minWidth: 200 }}>
                {channels.map(c => <option key={c.id} value={c.id}>{channelOptionLabel(c)}</option>)}
              </select>
            )}
            {tab === 'meta' && metaAccounts.length > 0 && (
              <select className="input-field" value={metaId} onChange={e => setMetaSel(e.target.value)} style={{ minWidth: 200 }}>
                {metaAccounts.map(a => <option key={a.id} value={a.id}>{a.platform} — {a.username ? `@${a.username}` : a.account_id}</option>)}
              </select>
            )}
          </div>
        }
      />

      {tab === 'telegram' ? (
        !channelId ? (
          <Placeholder icon="analytics" title="No channels" note="Add your own channel (is_mine) to see analytics." />
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            <Panel title="Subscribers"><SubsHistoryChart points={points} /></Panel>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Panel title="Views"><ViewsBarChart posts={posts} /></Panel>
              <Panel title="Engagement"><EngagementChart posts={posts} /></Panel>
            </div>
            <RoiPanel channelId={channelId} />
          </div>
        )
      ) : (
        !metaId ? (
          <Placeholder icon="analytics" title="No Meta accounts" note="Connect a Meta account on the Meta page to see analytics." />
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            <Panel title="Followers over time">
              {followerPoints.length > 0
                ? <SubsHistoryChart points={followerPoints.map(p => ({ at: p.at, subs: p.followers }))} />
                : <ChartEmpty note="No follower data yet." />}
            </Panel>
            <Panel title="Reach & impressions">
              {insQ.isPending
                ? <ChartEmpty note="Loading..." />
                : hasReach
                  ? <MetaReachImpressionsChart points={insPoints} />
                  : <ChartEmpty note={metaAcc?.platform === 'threads' ? 'Not available on Threads.' : 'No insight data yet.'} />}
            </Panel>
            <Panel title="Profile views">
              {insQ.isPending
                ? <ChartEmpty note="Loading..." />
                : hasProfileViews
                  ? <MetaProfileViewsChart points={insPoints} />
                  : <ChartEmpty note={metaAcc?.platform === 'threads' ? 'Not available on Threads.' : 'No insight data yet.'} />}
            </Panel>
          </div>
        )
      )}
    </div>
  );
}
