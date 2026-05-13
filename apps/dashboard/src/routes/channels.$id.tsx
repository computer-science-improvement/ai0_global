import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { trackingApi } from '../api/tracking';
import { SubsHistoryChart } from '../components/SubsHistoryChart';
import { ViewsBarChart } from '../components/ViewsBarChart';
import { EngagementChart } from '../components/EngagementChart';
import { PostsList } from '../components/PostsList';
import { fmtNumber, fmtDate } from '../lib/format';
import { RoiPanel } from '../components/RoiPanel';

export const Route = createFileRoute('/channels/$id')({ component: ChannelDetailPage });

function ChannelDetailPage() {
  const { id } = Route.useParams();

  const channelQ = useQuery({ queryKey: ['channel', id], queryFn: () => trackingApi.getChannel(id) });
  const subsQ    = useQuery({ queryKey: ['subs', id],    queryFn: () => trackingApi.subsHistory(id) });
  const postsQ   = useQuery({ queryKey: ['posts', id],   queryFn: () => trackingApi.listPosts(id, 30) });
  const topQ     = useQuery({ queryKey: ['top', id],     queryFn: () => trackingApi.topPosts(id, 'views', 5) });

  if (channelQ.isLoading) return <p className="text-neutral-400">Loading…</p>;
  if (channelQ.error)     return <p className="text-red-400">{(channelQ.error as Error).message}</p>;
  if (!channelQ.data)     return null;

  const c = channelQ.data;
  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-bold">{c.title ?? c.username ?? id}</h1>
        <div className="mt-1 flex items-center gap-3 text-sm text-neutral-400">
          {c.username && <span>@{c.username}</span>}
          <span>·</span>
          <span>{fmtNumber(c.subsCount)} subs</span>
          <span>·</span>
          <span>tier: {c.pollTier}</span>
          <span>·</span>
          <span>added {fmtDate(c.addedAt)}</span>
        </div>
        {c.about && <p className="mt-2 max-w-2xl text-sm text-neutral-300">{c.about}</p>}
      </header>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-400">ROI estimate</h2>
        <RoiPanel channelId={id} />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-400">Subscribers over time</h2>
        {subsQ.data && subsQ.data.points.length > 0
          ? <SubsHistoryChart points={subsQ.data.points} />
          : <p className="text-sm text-neutral-500">No history yet — wait for the next poll cycle.</p>}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-400">Views per post (last 30)</h2>
        {postsQ.data && postsQ.data.items.length > 0
          ? <ViewsBarChart posts={postsQ.data.items} />
          : <p className="text-sm text-neutral-500">No posts yet.</p>}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-400">Engagement rate</h2>
        {postsQ.data && postsQ.data.items.length > 0
          ? <EngagementChart posts={postsQ.data.items} />
          : <p className="text-sm text-neutral-500">No data.</p>}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-400">Top 5 posts by views</h2>
        {topQ.data && <PostsList posts={topQ.data.items} />}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-400">Recent posts</h2>
        {postsQ.data && <PostsList posts={postsQ.data.items} />}
      </section>
    </div>
  );
}
