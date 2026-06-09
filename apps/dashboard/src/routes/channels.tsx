import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useState, useMemo } from 'react';
import { trackingApi } from '../api/tracking';
import { useBots } from '../api/bots';
import { useStrategies } from '../api/strategies';
import { isLowContent } from '../lib/runway';
import { ChannelRow } from '../components/ChannelRow';
import { Pagination } from '../components/Pagination';
import { AddChannelModal } from '../components/AddChannelModal';
import { Icon } from '../components/Icon';

const PAGE_SIZE = 50;

interface Search { filter: 'mine' | 'all' | 'external'; page: number; q: string; bot?: string; }

export const Route = createFileRoute('/channels')({
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
  const { data: strategies } = useStrategies();
  const lowContentIds = useMemo(() => {
    const set = new Set<string>();
    for (const s of strategies ?? []) if (isLowContent(s)) set.add(s.id);
    return set;
  }, [strategies]);

  const { data, isLoading, error } = useQuery({
    queryKey: ['channels', FILTER, page, q, bot],
    queryFn:  () => trackingApi.listChannels({ filter: FILTER, q: q || undefined, bot, page, pageSize: PAGE_SIZE }),
  });

  const setSearch = (patch: Partial<Search>) =>
    navigate({ search: (old: Search) => ({ ...old, ...patch }) });

  const botFilter = bot ? bots?.find(b => b.id === bot) : null;

  return (
    <div>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h1 className="text-display-md" style={{ margin: 0 }}>My channels</h1>
        <button onClick={() => setModalOpen(true)} className="btn-primary" style={{ gap: 6 }}>
          <Icon name="plus" size={14} /> Add channel
        </button>
      </header>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <input
          value={q}
          onChange={(e) => setSearch({ q: e.target.value, page: 1 })}
          placeholder="Search…"
          className="input-field"
          style={{ flex: 1, minWidth: 220, maxWidth: 360 }}
        />
        {botFilter && (
          <span
            className="chip is-active"
            style={{ cursor: 'pointer', gap: 6 }}
            onClick={() => setSearch({ bot: undefined, page: 1 })}
            title="Clear bot filter"
          >
            <Icon name="bots" size={11} />
            bot: {botFilter.username ?? botFilter.bot_id}
            <Icon name="x" size={11} style={{ marginLeft: 2 }} />
          </span>
        )}
      </div>

      {isLoading && <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Loading…</p>}
      {error && <p className="text-body-sm" style={{ color: 'var(--color-danger)' }}>{(error as Error).message}</p>}
      {data && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {data.items.map((c) => <ChannelRow key={c.id} c={c} lowContentIds={lowContentIds} />)}
          </div>
          <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onPage={(p) => setSearch({ page: p })} />
        </>
      )}

      <AddChannelModal open={modalOpen} onClose={() => setModalOpen(false)} ownership="mine" />
    </div>
  );
}
