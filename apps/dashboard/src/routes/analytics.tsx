import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { trackingApi } from '../api/tracking';
import { channelOptionLabel } from '../lib/labels';
import { PageHeader } from '../components/ui/PageHeader';
import { Panel } from '../components/ui/Card';
import { Placeholder } from '../components/ui/Placeholder';
import { SubsHistoryChart } from '../components/SubsHistoryChart';
import { ViewsBarChart } from '../components/ViewsBarChart';
import { EngagementChart } from '../components/EngagementChart';
import { RoiPanel } from '../components/RoiPanel';

export const Route = createFileRoute('/analytics')({ component: AnalyticsPage });

function AnalyticsPage() {
  const channelsQ = useQuery({
    queryKey: ['channels', 'mine', 'analytics'],
    queryFn: () => trackingApi.listChannels({ filter: 'mine', pageSize: 200 }),
  });
  const channels = channelsQ.data?.items ?? [];
  const [sel, setSel] = useState('');
  const channelId = sel || channels[0]?.id || '';

  const subsQ = useQuery({ queryKey: ['subs', channelId], queryFn: () => trackingApi.subsHistory(channelId), enabled: !!channelId });
  const postsQ = useQuery({ queryKey: ['posts', channelId, 'analytics'], queryFn: () => trackingApi.listPosts(channelId, 30), enabled: !!channelId });

  const points = subsQ.data?.points ?? [];
  const posts = postsQ.data?.items ?? [];

  return (
    <div>
      <PageHeader
        title="Analytics"
        subtitle="Telegram · my channels"
        actions={
          channels.length > 0 ? (
            <select className="input-field" value={channelId} onChange={e => setSel(e.target.value)} style={{ minWidth: 220 }}>
              {channels.map(c => <option key={c.id} value={c.id}>{channelOptionLabel(c)}</option>)}
            </select>
          ) : undefined
        }
      />

      {!channelId ? (
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
      )}
    </div>
  );
}
