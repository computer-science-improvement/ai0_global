import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { trackingApi } from '../api/tracking';
import { ChannelRow } from '../components/ChannelRow';
import { Pagination } from '../components/Pagination';
import { AddChannelModal } from '../components/AddChannelModal';
import { ErrorCallout, ListSkeleton, SearchField } from '../components/channels/ChannelsUi';
import { PageHeader } from '../components/ui/PageHeader';
import { Icon } from '../components/ui/Icon';
import { SectionCard, StatStrip, StatTile, EmptyState } from '../components/ui/primitives';
import { useConfirm } from '../components/ui/ConfirmDialog';
import { TRACKING_META } from '../lib/channel-view';
import type { TrackedChannel } from '../api/types';

const PAGE_SIZE = 50;

// Tracked / competitor channels (NOT is_mine) — the intelligence side. Owned
// publish targets live under «My channels» (Publishing). This is the flat,
// manageable list that complements the Graph and Discovery views.
interface Search { page: number; q: string; }

export const Route = createFileRoute('/app/tracked')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    page: Math.max(1, Number(s.page) || 1),
    q:    String(s.q ?? ''),
  }),
  component: TrackedPage,
});

function TrackedPage() {
  const { page, q } = Route.useSearch();
  const navigate = Route.useNavigate();
  const [modalOpen, setModalOpen] = useState(false);
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const setSearch = (patch: Partial<Search>) =>
    navigate({ search: (old: Search) => ({ ...old, ...patch }) });

  const { data, isLoading, error } = useQuery({
    queryKey: ['channels', 'external', page, q],
    queryFn:  () => trackingApi.listChannels({ filter: 'external', q: q || undefined, page, pageSize: PAGE_SIZE }),
  });

  // Deleting a tracked channel drops its posts / subs history / ad edges via
  // DB cascades (edges where it was the *target* revert to unresolved external
  // refs). The graph query is invalidated so nodes disappear immediately.
  const del = useMutation({
    mutationFn: (id: string) => trackingApi.deleteChannel(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['channels'] });
      queryClient.invalidateQueries({ queryKey: ['graph'] });
    },
  });

  const askDelete = async (c: TrackedChannel) => {
    const name = c.title ?? (c.username ? `@${c.username}` : c.channelKey);
    const ok = await confirm(`delete “${name}” and all its collected stats (posts, subscriber history, ad edges)`, {
      danger: true,
      confirmLabel: 'Delete channel',
    });
    if (ok) del.mutate(c.id);
  };

  const items = data?.items ?? [];
  const okCount   = items.filter((c) => c.trackingStatus === 'ok').length;
  const warnCount = items.filter((c) => c.trackingStatus === 'not_subscribed').length;

  return (
    <div>
      <PageHeader
        eyebrow="Insights · competitors"
        title="Tracked channels"
        subtitle="Other people's channels being tracked (not mine)"
        actions={
          <button type="button" onClick={() => setModalOpen(true)} className="btn-primary">
            <Icon name="plus" size={14} /> Add channel
          </button>
        }
      />

      <div className="ch-toolbar">
        <SearchField
          value={q}
          onChange={(v) => setSearch({ q: v, page: 1 })}
          placeholder="Search channels…"
          label="Search tracked channels"
        />
        {data && data.total > 0 && (
          <span className="ch-count mono">
            {data.total === 1 ? '1 channel' : `${data.total.toLocaleString()} channels`}
          </span>
        )}
      </div>

      {isLoading && (
        <SectionCard title="Tracked channels" flush>
          <ListSkeleton />
        </SectionCard>
      )}

      {error && <ErrorCallout title="Couldn’t load tracked channels" error={error} />}

      {/* Delete failed — surfaced inline so the row doesn't just "not disappear". */}
      {del.isError && (
        <ErrorCallout title="Couldn’t delete the channel" error={del.error} />
      )}

      {data && data.total === 0 && (
        <SectionCard title="Tracked channels" delay={40}>
          <EmptyState
            icon="search"
            title={q ? 'No channels match your search' : 'No tracked channels yet'}
            note={
              q
                ? 'Try a different name or @username, or clear the search to see everything.'
                : 'Add a competitor or reference channel to start collecting subscriber and posting intelligence.'
            }
            action={
              q ? (
                <button type="button" onClick={() => setSearch({ q: '', page: 1 })} className="btn-secondary">
                  <Icon name="x" size={14} /> Clear search
                </button>
              ) : (
                <button type="button" onClick={() => setModalOpen(true)} className="btn-primary">
                  <Icon name="plus" size={14} /> Add channel
                </button>
              )
            }
          />
        </SectionCard>
      )}

      {data && data.total > 0 && (
        <>
          <div className="ch-stack">
            {/* Tracking health across this page. */}
            <div className="compose-rise">
              <StatStrip label="Tracking health on this page">
                <StatTile label="Total tracked" value={data.total.toLocaleString()} />
                <StatTile label="Tracking ok" value={okCount} delta={TRACKING_META.ok.label} deltaTone="success" />
                <StatTile
                  label="Needs subscribe"
                  value={warnCount}
                  delta={TRACKING_META.not_subscribed.label}
                  deltaTone={warnCount > 0 ? 'warning' : 'neutral'}
                />
              </StatStrip>
            </div>

            <SectionCard title="Tracked channels" flush delay={60}>
              {items.map((c) => (
                <ChannelRow key={c.id} c={c} onDelete={() => askDelete(c)} showTracking />
              ))}
            </SectionCard>
          </div>
          <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onPage={(p) => setSearch({ page: p })} />
        </>
      )}

      <AddChannelModal open={modalOpen} onClose={() => setModalOpen(false)} ownership="external" />
    </div>
  );
}
