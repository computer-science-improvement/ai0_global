import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { trackingApi } from '../api/tracking';
import { useMetaAccounts, useMetaFollowerHistory, useMetaAccountInsights } from '../api/meta-accounts';
import { channelOptionLabel } from '../lib/labels';
import { fmtNumber } from '../lib/format';
import { PageHeader } from '../components/ui/PageHeader';
import type { IconName } from '../components/ui/Icon';
import { SegmentedTabs } from '../components/SegmentedTabs';
import { StatTile, SectionCard, EmptyState, type Tone } from '../components/ui/primitives';
import { SubsHistoryChart } from '../components/SubsHistoryChart';
import { ViewsBarChart } from '../components/ViewsBarChart';
import { EngagementChart } from '../components/EngagementChart';
import { MetaReachImpressionsChart } from '../components/MetaReachImpressionsChart';
import { MetaProfileViewsChart } from '../components/MetaProfileViewsChart';
import { RoiPanel } from '../components/RoiPanel';

export const Route = createFileRoute('/app/analytics')({ component: AnalyticsPage });

type Tab = 'telegram' | 'meta';

const TAB_OPTIONS: { key: Tab; label: string; icon: IconName }[] = [
  { key: 'telegram', label: 'Telegram', icon: 'telegram' },
  { key: 'meta', label: 'Meta', icon: 'facebook' },
];

/** Platform toggle — the shared SegmentedTabs every page uses. */
function PlatformToggle({ value, onChange }: { value: Tab; onChange: (t: Tab) => void }) {
  return <SegmentedTabs value={value} onChange={onChange} options={TAB_OPTIONS} />;
}

/** Dashed icon empty/loading state used inside chart cards. */
function ChartState({ icon = 'analytics', note, loading = false }: { icon?: IconName; note: string; loading?: boolean }) {
  return <EmptyState icon={loading ? 'refresh' : icon} title={note} />;
}

function signed(n: number): string {
  return `${n > 0 ? '+' : ''}${fmtNumber(n)}`;
}

function deltaTone(n: number | null | undefined): Tone {
  if (n == null || n === 0) return 'neutral';
  return n > 0 ? 'success' : 'danger';
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

  // ── Derived KPI summaries (read-only over existing data) ───────────────────
  const selChannel = channels.find(c => c.id === channelId);
  const subsCurrent = points.length > 0 ? points[points.length - 1].subs : selChannel?.subsCount ?? null;
  const subsDelta = points.length > 1 ? points[points.length - 1].subs - points[0].subs : null;
  const postViews = posts.map(p => p.views ?? 0);
  const avgViews = postViews.length > 0 ? Math.round(postViews.reduce((a, b) => a + b, 0) / postViews.length) : null;
  const totalReactions = posts.reduce((a, p) => a + (p.reactionsTotal ?? 0), 0);

  const metaReachTotal = insPoints.reduce((a, p) => a + (p.reach ?? 0), 0);

  return (
    <div>
      <PageHeader
        title="Analytics"
        subtitle={tab === 'telegram' ? 'Telegram · my channels' : 'Meta · my accounts'}
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <PlatformToggle value={tab} onChange={setTab} />
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
          <EmptyState icon="analytics" title="No channels" note="Add your own channel (is_mine) to see analytics." />
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            <div className="stat-grid">
              <StatTile
                label="Subscribers"
                value={fmtNumber(subsCurrent)}
                icon="channels"
                delta={subsDelta != null ? `${signed(subsDelta)} · tracked range` : undefined}
                deltaTone={deltaTone(subsDelta)}
              />
              <StatTile
                label="Avg views"
                value={fmtNumber(avgViews)}
                icon="analytics"
                delta={posts.length > 0 ? `last ${posts.length} posts` : 'no posts'}
              />
              <StatTile
                label="Reactions"
                value={fmtNumber(totalReactions)}
                icon="strategies"
                delta={posts.length > 0 ? `across ${posts.length} posts` : 'no posts'}
              />
            </div>

            <SectionCard
              title="Subscribers"
              icon="channels"
              delay={150}
              action={points.length > 0 ? <span className="text-caption" style={{ color: 'var(--color-ink-dim)', fontSize: 11 }}>{points.length} points</span> : undefined}
            >
              {subsQ.isPending
                ? <ChartState note="Loading subscriber history…" loading />
                : points.length > 0
                  ? <SubsHistoryChart points={points} />
                  : <ChartState note="No subscriber history yet." />}
            </SectionCard>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
              <SectionCard
                title="Views"
                icon="analytics"
                delay={200}
                action={<span className="text-caption" style={{ color: 'var(--color-ink-dim)', fontSize: 11 }}>per post</span>}
              >
                {postsQ.isPending
                  ? <ChartState note="Loading posts…" loading />
                  : posts.length > 0
                    ? <ViewsBarChart posts={posts} />
                    : <ChartState note="No posts to chart yet." />}
              </SectionCard>
              <SectionCard
                title="Engagement"
                icon="strategies"
                delay={250}
                action={<span className="text-caption" style={{ color: 'var(--color-ink-dim)', fontSize: 11 }}>per post</span>}
              >
                {postsQ.isPending
                  ? <ChartState note="Loading posts…" loading />
                  : posts.length > 0
                    ? <EngagementChart posts={posts} />
                    : <ChartState note="No posts to chart yet." />}
              </SectionCard>
            </div>

            <div className="compose-rise" style={{ animationDelay: '300ms' }}>
              <RoiPanel channelId={channelId} />
            </div>
          </div>
        )
      ) : (
        !metaId ? (
          <EmptyState icon="analytics" title="No Meta accounts" note="Connect a Meta account on the Meta page to see analytics." />
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            <div className="stat-grid">
              <StatTile
                label="Followers"
                value={fmtNumber(histQ.data?.current ?? metaAcc?.followers ?? null)}
                icon="channels"
                delta={metaAcc?.followers_delta_24h != null ? `${signed(metaAcc.followers_delta_24h)} · 24h` : '24h'}
                deltaTone={deltaTone(metaAcc?.followers_delta_24h)}
              />
              <StatTile
                label="Followers Δ 7d"
                value={histQ.data?.delta7d != null ? signed(histQ.data.delta7d) : '—'}
                icon="analytics"
                delta="vs 7 days ago"
                deltaTone={deltaTone(histQ.data?.delta7d)}
              />
              <StatTile
                label="Reach"
                value={fmtNumber(hasReach ? metaReachTotal : null)}
                icon="strategies"
                delta={insPoints.length > 0 ? `${insPoints.length}-day total` : 'no data'}
              />
            </div>

            <SectionCard
              title="Followers over time"
              icon="channels"
              delay={150}
              action={followerPoints.length > 0 ? <span className="text-caption" style={{ color: 'var(--color-ink-dim)', fontSize: 11 }}>{followerPoints.length} points</span> : undefined}
            >
              {histQ.isPending
                ? <ChartState note="Loading follower history…" loading />
                : followerPoints.length > 0
                  ? <SubsHistoryChart points={followerPoints.map(p => ({ at: p.at, subs: p.followers }))} />
                  : <ChartState note="No follower data yet." />}
            </SectionCard>

            <SectionCard title="Reach & impressions" icon="analytics" delay={200}>
              {insQ.isPending
                ? <ChartState note="Loading insights…" loading />
                : hasReach
                  ? <MetaReachImpressionsChart points={insPoints} />
                  : <ChartState note={metaAcc?.platform === 'threads' ? 'Not available on Threads.' : 'No insight data yet.'} />}
            </SectionCard>

            <SectionCard title="Profile views" icon="analytics" delay={250}>
              {insQ.isPending
                ? <ChartState note="Loading insights…" loading />
                : hasProfileViews
                  ? <MetaProfileViewsChart points={insPoints} />
                  : <ChartState note={metaAcc?.platform === 'threads' ? 'Not available on Threads.' : 'No insight data yet.'} />}
            </SectionCard>
          </div>
        )
      )}
    </div>
  );
}
