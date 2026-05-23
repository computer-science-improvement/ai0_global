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
import { Icon } from '../components/Icon';

export const Route = createFileRoute('/channels/$id')({ component: ChannelDetailPage });

function ChannelDetailPage() {
  const { id } = Route.useParams();
  const [themesOpen, setThemesOpen] = useState(false);

  const channelQ = useQuery({ queryKey: ['channel', id], queryFn: () => trackingApi.getChannel(id) });
  const subsQ    = useQuery({ queryKey: ['subs', id],    queryFn: () => trackingApi.subsHistory(id) });
  const postsQ   = useQuery({ queryKey: ['posts', id],   queryFn: () => trackingApi.listPosts(id, 30) });
  const topQ     = useQuery({ queryKey: ['top', id],     queryFn: () => trackingApi.topPosts(id, 'views', 5) });
  const themesQ  = useChannelThemes(id);

  if (channelQ.isLoading) return <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Loading…</p>;
  if (channelQ.error)     return <p className="text-body-sm" style={{ color: 'var(--color-danger)' }}>{(channelQ.error as Error).message}</p>;
  if (!channelQ.data)     return null;

  const c = channelQ.data;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
      <header>
        <h1 className="text-display-md" style={{ margin: 0 }}>{c.title ?? c.username ?? id}</h1>
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {c.username && <span className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>@{c.username}</span>}
          <span className="text-body-sm" style={{ color: 'var(--color-ink-dim)' }}>·</span>
          <span className="text-body-sm" style={{ color: 'var(--color-ink)' }}>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtNumber(c.subsCount)}</span>
            <span style={{ color: 'var(--color-ink-muted)' }}> subs</span>
          </span>
          <span className="text-body-sm" style={{ color: 'var(--color-ink-dim)' }}>·</span>
          <span className={`chip ${c.pollTier === 'hot' ? 'chip-warning' : c.pollTier === 'cold' ? '' : 'chip-success'}`}>
            {c.pollTier}
          </span>
          <span className="text-body-sm" style={{ color: 'var(--color-ink-dim)' }}>·</span>
          <span className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>added {fmtDate(c.addedAt)}</span>
          <button
            onClick={() => setThemesOpen(true)}
            className="btn-tiny"
            style={{ marginLeft: 'auto', gap: 6 }}
          >
            <Icon name="pencil" size={12} />
            Themes ({themesQ.data?.length ?? 0})
          </button>
        </div>
        {c.about && (
          <p className="text-body" style={{ marginTop: 12, maxWidth: 720, color: 'var(--color-ink-muted)', lineHeight: 1.5 }}>
            {c.about}
          </p>
        )}
      </header>

      {themesOpen && (
        <EditThemesModal
          channelId={id}
          channelTitle={c.title ?? c.username ?? id}
          open={themesOpen}
          onClose={() => setThemesOpen(false)}
        />
      )}

      <Section title="ROI estimate">
        <RoiPanel channelId={id} />
      </Section>

      <Section title="Subscribers over time">
        {subsQ.data && subsQ.data.points.length > 0
          ? <SubsHistoryChart points={subsQ.data.points} />
          : <Empty>No history yet — wait for the next poll cycle.</Empty>}
      </Section>

      <Section title="Views per post (last 30)">
        {postsQ.data && postsQ.data.items.length > 0
          ? <ViewsBarChart posts={postsQ.data.items} />
          : <Empty>No posts yet.</Empty>}
      </Section>

      <Section title="Engagement rate">
        {postsQ.data && postsQ.data.items.length > 0
          ? <EngagementChart posts={postsQ.data.items} />
          : <Empty>No data.</Empty>}
      </Section>

      <Section title="Top 5 posts by views">
        {topQ.data && <PostsList posts={topQ.data.items} />}
      </Section>

      <Section title="Recent posts">
        {postsQ.data && <PostsList posts={postsQ.data.items} />}
      </Section>
    </div>
  );
}

/** Section heading uses .text-eyebrow (caption tier, ink-muted) — no uppercase
 *  + weight-bump anti-pattern. Hierarchy comes from size + tracking. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-eyebrow" style={{ margin: 0, marginBottom: 10 }}>{title}</h2>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>{children}</p>;
}
