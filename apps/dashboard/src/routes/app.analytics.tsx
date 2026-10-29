import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { trackingApi } from '../api/tracking';
import { useMetaAccounts, useMetaFollowerHistory, useMetaAccountInsights } from '../api/meta-accounts';
import { channelOptionLabel } from '../lib/labels';
import { fmtNumber } from '../lib/format';
import { EVERGREEN_SHARE_MAX, ownViewsSpark, splitReposts } from '../lib/reposts';
import { PageHeader } from '../components/ui/PageHeader';
import type { IconName } from '../components/ui/Icon';
import { SegmentedTabs } from '../components/SegmentedTabs';
import { StatTile, StatStrip, SectionCard, EmptyState, type Tone } from '../components/ui/primitives';
import { ErrorCallout, SectionCaption } from '../components/channels/ChannelsUi';
import { SubsHistoryChart } from '../components/SubsHistoryChart';
import { ViewsBarChart } from '../components/ViewsBarChart';
import { EngagementChart } from '../components/EngagementChart';
import { MetaReachImpressionsChart } from '../components/MetaReachImpressionsChart';
import { MetaProfileViewsChart } from '../components/MetaProfileViewsChart';
import { RoiPanel } from '../components/RoiPanel';

export const Route = createFileRoute('/app/analytics')({ component: AnalyticsPage });

type Tab = 'telegram' | 'meta';

/** Empty / loading state used inside chart panels (a refresh medallion while loading). */
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
  // Spec 037 T2: reposts are counted apart; the average views read own posts only.
  const split = splitReposts(posts);
  const avgViews = split.avgOwnViews;
  const totalReactions = posts.reduce((a, p) => a + (p.reactionsTotal ?? 0), 0);
  // Views of the last 7 own posts, oldest first: the same posts the average reads (reposts carry a sibling's audience).
  const viewsSpark = ownViewsSpark(posts);

  const metaReachTotal = insPoints.reduce((a, p) => a + (p.reach ?? 0), 0);

  return (
    <div>
      <PageHeader
        eyebrow="Insights"
        title="Analytics"
        subtitle={tab === 'telegram' ? 'Telegram · my channels' : 'Meta · my accounts'}
      />

      {/* The platform, then which channel or account to read. */}
      <div className="ch-toolbar">
        <SegmentedTabs<Tab>
          value={tab}
          onChange={setTab}
          ariaLabel="Platform"
          options={[
            { key: 'telegram', label: 'Telegram', icon: 'telegram', count: channelsQ.data ? channels.length : undefined },
            { key: 'meta',     label: 'Meta',     icon: 'facebook', count: metaQ.data ? metaAccounts.length : undefined },
          ]}
        />
        {tab === 'telegram' && channels.length > 0 && (
          <select className="input-field" aria-label="Channel" value={channelId} onChange={e => setSel(e.target.value)} style={{ minWidth: 200, maxWidth: '100%' }}>
            {channels.map(c => <option key={c.id} value={c.id}>{channelOptionLabel(c)}</option>)}
          </select>
        )}
        {tab === 'meta' && metaAccounts.length > 0 && (
          <select className="input-field" aria-label="Meta account" value={metaId} onChange={e => setMetaSel(e.target.value)} style={{ minWidth: 200, maxWidth: '100%' }}>
            {metaAccounts.map(a => <option key={a.id} value={a.id}>{a.platform} — {a.username ? `@${a.username}` : a.account_id}</option>)}
          </select>
        )}
      </div>

      {tab === 'telegram' ? (
        channelsQ.error && !channelsQ.data ? (
          <ErrorCallout title="Couldn’t load your channels" error={channelsQ.error} />
        ) : channelsQ.isPending ? (
          <div className="panel"><ChartState note="Loading channels…" loading /></div>
        ) : !channelId ? (
          <div className="panel"><EmptyState icon="analytics" title="No channels" note="Add your own channel (is_mine) to see analytics." /></div>
        ) : (
          <div className="ch-stack">
            <div className="compose-rise">
              <StatStrip label="Telegram numbers">
                <StatTile
                  label="Subscribers"
                  value={fmtNumber(subsCurrent)}
                  delta={subsDelta != null ? `${signed(subsDelta)} · tracked range` : undefined}
                  deltaTone={deltaTone(subsDelta)}
                />
                <StatTile
                  label="Avg views"
                  value={fmtNumber(avgViews)}
                  delta={split.own > 0 ? `last ${split.own} own posts` : 'no posts'}
                  spark={viewsSpark.length > 1 ? viewsSpark : undefined}
                />
                <StatTile
                  label="Own vs reposts"
                  value={`${fmtNumber(split.own)} / ${fmtNumber(split.reposts)}`}
                  delta={split.share != null ? `${Math.round(split.share * 100)}% reposts` : 'no posts'}
                  deltaTone={split.share != null && split.share > 0.3 ? 'danger' : 'neutral'}
                />
                <StatTile
                  label="Evergreen"
                  value={fmtNumber(split.evergreen)}
                  delta={split.evergreenShare != null ? `${Math.round(split.evergreenShare * 100)}% of posts · fallback` : 'no posts'}
                  deltaTone={split.evergreenShare != null && split.evergreenShare > EVERGREEN_SHARE_MAX ? 'danger' : 'neutral'}
                />
                <StatTile
                  label="Reactions"
                  value={fmtNumber(totalReactions)}
                  delta={posts.length > 0 ? `across ${posts.length} posts` : 'no posts'}
                />
              </StatStrip>
            </div>

            <SectionCard
              title="Subscribers"
              delay={80}
              action={points.length > 0 ? <SectionCaption>{points.length} points</SectionCaption> : undefined}
            >
              {subsQ.isPending
                ? <ChartState note="Loading subscriber history…" loading />
                : points.length > 0
                  ? <SubsHistoryChart points={points} />
                  : <ChartState note="No subscriber history yet." />}
            </SectionCard>

            <div className="ch-pair">
              <SectionCard title="Views" delay={120} action={<SectionCaption>per post</SectionCaption>}>
                {postsQ.isPending
                  ? <ChartState note="Loading posts…" loading />
                  : posts.length > 0
                    ? <ViewsBarChart posts={posts} />
                    : <ChartState note="No posts to chart yet." />}
              </SectionCard>
              <SectionCard title="Engagement" delay={160} action={<SectionCaption>per post</SectionCaption>}>
                {postsQ.isPending
                  ? <ChartState note="Loading posts…" loading />
                  : posts.length > 0
                    ? <EngagementChart posts={posts} />
                    : <ChartState note="No posts to chart yet." />}
              </SectionCard>
            </div>

            <SectionCard title="ROI estimate" delay={200}>
              <RoiPanel channelId={channelId} />
            </SectionCard>
          </div>
        )
      ) : (
        metaQ.error && !metaQ.data ? (
          <ErrorCallout title="Couldn’t load your Meta accounts" error={metaQ.error} />
        ) : metaQ.isPending ? (
          <div className="panel"><ChartState note="Loading Meta accounts…" loading /></div>
        ) : !metaId ? (
          <div className="panel"><EmptyState icon="analytics" title="No Meta accounts" note="Connect a Meta account on the Meta page to see analytics." /></div>
        ) : (
          <div className="ch-stack">
            <div className="compose-rise">
              <StatStrip label="Meta numbers">
                <StatTile
                  label="Followers"
                  value={fmtNumber(histQ.data?.current ?? metaAcc?.followers ?? null)}
                  delta={metaAcc?.followers_delta_24h != null ? `${signed(metaAcc.followers_delta_24h)} · 24h` : '24h'}
                  deltaTone={deltaTone(metaAcc?.followers_delta_24h)}
                />
                <StatTile
                  label="Followers Δ 7d"
                  value={histQ.data?.delta7d != null ? signed(histQ.data.delta7d) : '—'}
                  delta="vs 7 days ago"
                  deltaTone={deltaTone(histQ.data?.delta7d)}
                />
                <StatTile
                  label="Reach"
                  value={fmtNumber(hasReach ? metaReachTotal : null)}
                  delta={insPoints.length > 0 ? `${insPoints.length}-day total` : 'no data'}
                />
              </StatStrip>
            </div>

            <SectionCard
              title="Followers over time"
              delay={80}
              action={followerPoints.length > 0 ? <SectionCaption>{followerPoints.length} points</SectionCaption> : undefined}
            >
              {histQ.isPending
                ? <ChartState note="Loading follower history…" loading />
                : followerPoints.length > 0
                  ? <SubsHistoryChart points={followerPoints.map(p => ({ at: p.at, subs: p.followers }))} />
                  : <ChartState note="No follower data yet." />}
            </SectionCard>

            <SectionCard title="Reach & impressions" delay={120}>
              {insQ.isPending
                ? <ChartState note="Loading insights…" loading />
                : hasReach
                  ? <MetaReachImpressionsChart points={insPoints} />
                  : <ChartState note={metaAcc?.platform === 'threads' ? 'Not available on Threads.' : 'No insight data yet.'} />}
            </SectionCard>

            <SectionCard title="Profile views" delay={160}>
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
