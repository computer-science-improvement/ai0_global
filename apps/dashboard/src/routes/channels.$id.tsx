import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { trackingApi } from '../api/tracking';
import { SubsHistoryChart } from '../components/SubsHistoryChart';
import { ViewsBarChart } from '../components/ViewsBarChart';
import { EngagementChart } from '../components/EngagementChart';
import { PostsList } from '../components/PostsList';
import { fmtNumber, fmtDate } from '../lib/format';
import { RoiPanel } from '../components/RoiPanel';
import { EditThemesModal } from '../components/EditThemesModal';
import { useChannelThemes } from '../api/discovery';

export const Route = createFileRoute('/channels/$id')({ component: ChannelDetailPage });

const sectionLabel: React.CSSProperties = {
  marginBottom: 8,
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: 'var(--color-ink-muted)',
};

function ChannelDetailPage() {
  const { id } = Route.useParams();
  const [themesOpen, setThemesOpen] = useState(false);

  const channelQ = useQuery({ queryKey: ['channel', id], queryFn: () => trackingApi.getChannel(id) });
  const subsQ    = useQuery({ queryKey: ['subs', id],    queryFn: () => trackingApi.subsHistory(id) });
  const postsQ   = useQuery({ queryKey: ['posts', id],   queryFn: () => trackingApi.listPosts(id, 30) });
  const topQ     = useQuery({ queryKey: ['top', id],     queryFn: () => trackingApi.topPosts(id, 'views', 5) });
  const themesQ  = useChannelThemes(id);

  if (channelQ.isLoading) return <p style={{ color: 'var(--color-ink-muted)' }}>Loading…</p>;
  if (channelQ.error)     return <p style={{ color: 'var(--color-danger)' }}>{(channelQ.error as Error).message}</p>;
  if (!channelQ.data)     return null;

  const c = channelQ.data;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
      <header>
        <h1 className="text-display-md" style={{ margin: 0 }}>{c.title ?? c.username ?? id}</h1>
        <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 12, fontSize: 14, color: 'var(--color-ink-muted)' }}>
          {c.username && <span>@{c.username}</span>}
          <span>·</span>
          <span className="tabular-nums">{fmtNumber(c.subsCount)} subs</span>
          <span>·</span>
          <span>tier: {c.pollTier}</span>
          <span>·</span>
          <span>added {fmtDate(c.addedAt)}</span>
          <span>·</span>
          <button
            onClick={() => setThemesOpen(true)}
            className="text-blue-600 hover:underline"
            style={{ fontSize: 14 }}
          >
            Edit themes ({themesQ.data?.length ?? 0})
          </button>
        </div>
        {c.about && <p style={{ marginTop: 8, maxWidth: 640, fontSize: 14, color: 'var(--color-ink-muted)', lineHeight: 1.6 }}>{c.about}</p>}
      </header>

      {themesOpen && (
        <EditThemesModal
          channelId={id}
          channelTitle={c.title ?? c.username ?? id}
          open={themesOpen}
          onClose={() => setThemesOpen(false)}
        />
      )}

      <section>
        <h2 style={sectionLabel}>ROI estimate</h2>
        <RoiPanel channelId={id} />
      </section>

      <section>
        <h2 style={sectionLabel}>Subscribers over time</h2>
        {subsQ.data && subsQ.data.points.length > 0
          ? <SubsHistoryChart points={subsQ.data.points} />
          : <p style={{ fontSize: 14, color: 'var(--color-ink-muted)' }}>No history yet — wait for the next poll cycle.</p>}
      </section>

      <section>
        <h2 style={sectionLabel}>Views per post (last 30)</h2>
        {postsQ.data && postsQ.data.items.length > 0
          ? <ViewsBarChart posts={postsQ.data.items} />
          : <p style={{ fontSize: 14, color: 'var(--color-ink-muted)' }}>No posts yet.</p>}
      </section>

      <section>
        <h2 style={sectionLabel}>Engagement rate</h2>
        {postsQ.data && postsQ.data.items.length > 0
          ? <EngagementChart posts={postsQ.data.items} />
          : <p style={{ fontSize: 14, color: 'var(--color-ink-muted)' }}>No data.</p>}
      </section>

      <section>
        <h2 style={sectionLabel}>Top 5 posts by views</h2>
        {topQ.data && <PostsList posts={topQ.data.items} />}
      </section>

      <section>
        <h2 style={sectionLabel}>Recent posts</h2>
        {postsQ.data && <PostsList posts={postsQ.data.items} />}
      </section>
    </div>
  );
}
