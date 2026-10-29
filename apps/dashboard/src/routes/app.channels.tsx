import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { trackingApi } from '../api/tracking';
import { useBots } from '../api/bots';
import { ChannelRow } from '../components/ChannelRow';
import { Pagination } from '../components/Pagination';
import { AddChannelModal } from '../components/AddChannelModal';
import { ErrorCallout, ListSkeleton, SearchField } from '../components/channels/ChannelsUi';
import { Icon } from '../components/Icon';
import { Icon as UiIcon } from '../components/ui/Icon';
import { PageHeader } from '../components/ui/PageHeader';
import { SectionCard, StatStrip, StatTile, EmptyState } from '../components/ui/primitives';

const PAGE_SIZE = 50;

interface Search { filter: 'mine' | 'all' | 'external'; page: number; q: string; bot?: string; }

export const Route = createFileRoute('/app/channels')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    filter: (s.filter as Search['filter']) ?? 'mine',
    page:   Math.max(1, Number(s.page) || 1),
    q:      String(s.q ?? ''),
    bot:    s.bot ? String(s.bot) : undefined,
  }),
  component: ChannelsPage,
});

// «My channels» lists owned (is_mine) channels only — the publish targets.
// Tracked / competitor channels live under Intelligence (Discovery / Graph),
// so this page has no all/external tabs.
const FILTER = 'mine' as const;

function ChannelsPage() {
  const { page, q, bot } = Route.useSearch();
  const navigate = Route.useNavigate();
  const [modalOpen, setModalOpen] = useState(false);
  const { data: bots } = useBots();

  const { data, isLoading, error } = useQuery({
    queryKey: ['channels', FILTER, page, q, bot],
    queryFn:  () => trackingApi.listChannels({ filter: FILTER, q: q || undefined, bot, page, pageSize: PAGE_SIZE }),
  });

  const setSearch = (patch: Partial<Search>) =>
    navigate({ search: (old: Search) => ({ ...old, ...patch }) });

  const botFilter = bot ? bots?.find(b => b.id === bot) : null;

  const total    = data?.total ?? 0;
  const showing  = data?.items.length ?? 0;
  const isEmpty  = data != null && showing === 0;
  const filtered = Boolean(q || bot);

  // Summary of the channels visible on this page — derived from the loaded
  // items only (server paginates), surfaced as a small KPI strip.
  const items     = data?.items ?? [];
  const needsBot  = items.filter(c => c.needsBot).length;
  const paused    = items.filter(c => c.publishPaused).length;

  return (
    <div>
      <PageHeader
        eyebrow="Network · owned"
        title="My channels"
        subtitle="Owned channels you publish into. Each row shows its bound bot, poll tier, and legacy strategy bindings."
        actions={<>
          {/* Spec 042 / 048: set an own channel's agent up from its last 20 posts — /setup in the chat. */}
          <Link to="/app/chat" search={{ q: '/setup ' }} className="btn-secondary">
            <Icon name="sparkle" size={14} /> Setup from history
          </Link>
          <button type="button" onClick={() => setModalOpen(true)} className="btn-primary">
            <Icon name="plus" size={14} /> Add channel
          </button>
        </>}
      />

      {/* Search, the active bot filter (removable) and the result count. */}
      <div className="ch-toolbar">
        <SearchField
          value={q}
          onChange={(v) => setSearch({ q: v, page: 1 })}
          placeholder="Search channels…"
          label="Search channels"
        />
        {botFilter && (
          <button
            type="button"
            className="chip-toggle"
            aria-pressed="true"
            title="Clear bot filter"
            aria-label={`Clear bot filter: ${botFilter.username ?? botFilter.bot_id}`}
            onClick={() => setSearch({ bot: undefined, page: 1 })}
          >
            <Icon name="bots" size={12} />
            bot: {botFilter.username ?? botFilter.bot_id}
            <UiIcon name="x" size={12} />
          </button>
        )}
        {data && (
          <span className="ch-count mono">
            {total === 1 ? '1 channel' : `${total.toLocaleString()} channels`}
          </span>
        )}
      </div>

      {isLoading && (
        <SectionCard title="My channels" flush>
          <ListSkeleton />
        </SectionCard>
      )}

      {error && <ErrorCallout title="Couldn’t load channels" message={(error as Error).message} />}

      {isEmpty && (
        <SectionCard title="My channels" delay={40}>
          <EmptyState
            icon="channels"
            title={filtered ? 'No channels match your filters' : 'No channels yet'}
            note={filtered
              ? 'Try a different search term or clear the bot filter to see everything.'
              : 'Add a channel to start scheduling and publishing content into it.'}
            action={filtered ? (
              <button type="button" onClick={() => setSearch({ q: '', bot: undefined, page: 1 })} className="btn-secondary">
                <UiIcon name="x" size={14} /> Clear filters
              </button>
            ) : (
              <button type="button" onClick={() => setModalOpen(true)} className="btn-primary">
                <UiIcon name="plus" size={14} /> Add channel
              </button>
            )}
          />
        </SectionCard>
      )}

      {data && !isEmpty && (
        <>
          <div className="ch-stack">
            <div className="compose-rise">
              <StatStrip label="Channels on this page">
                <StatTile label={filtered ? 'On this page' : 'Channels'} value={showing.toLocaleString()} />
                <StatTile
                  label="Need a bot"
                  value={needsBot.toLocaleString()}
                  delta={needsBot > 0 ? 'Can’t publish' : 'All wired'}
                  deltaTone={needsBot > 0 ? 'warning' : 'success'}
                />
                <StatTile
                  label="Paused"
                  value={paused.toLocaleString()}
                  delta={paused > 0 ? 'Publishing held' : 'All live'}
                  deltaTone={paused > 0 ? 'warning' : 'success'}
                />
              </StatStrip>
            </div>

            <SectionCard title="My channels" flush delay={60}>
              {data.items.map((c) => <ChannelRow key={c.id} c={c} />)}
            </SectionCard>
          </div>
          <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onPage={(p) => setSearch({ page: p })} />
        </>
      )}

      <AddChannelModal open={modalOpen} onClose={() => setModalOpen(false)} ownership="mine" />
    </div>
  );
}
