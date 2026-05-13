import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { trackingApi } from '../api/tracking';
import { ChannelRow } from '../components/ChannelRow';
import { Pagination } from '../components/Pagination';
import { AddChannelModal } from '../components/AddChannelModal';

const PAGE_SIZE = 50;

interface Search { filter: 'mine' | 'all' | 'external'; page: number; q: string; }

export const Route = createFileRoute('/channels')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    filter: (s.filter as Search['filter']) ?? 'all',
    page:   Math.max(1, Number(s.page) || 1),
    q:      String(s.q ?? ''),
  }),
  component: ChannelsPage,
});

function ChannelsPage() {
  const { filter, page, q } = Route.useSearch();
  const navigate = Route.useNavigate();
  const [modalOpen, setModalOpen] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['channels', filter, page, q],
    queryFn:  () => trackingApi.listChannels({ filter, q: q || undefined, page, pageSize: PAGE_SIZE }),
  });

  const setSearch = (patch: Partial<Search>) =>
    navigate({ search: (old: Search) => ({ ...old, ...patch }) });

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex rounded-lg bg-neutral-900 p-1 text-sm">
            {(['all', 'mine', 'external'] as const).map((f) => (
              <button key={f} onClick={() => setSearch({ filter: f, page: 1 })}
                className={`rounded px-3 py-1 ${filter === f ? 'bg-neutral-700' : 'hover:bg-neutral-800'}`}>
                {f}
              </button>
            ))}
          </div>
          <input value={q} onChange={(e) => setSearch({ q: e.target.value, page: 1 })}
            placeholder="Search…"
            className="rounded-lg bg-neutral-900 px-3 py-1 text-sm outline-none ring-1 ring-neutral-800 focus:ring-neutral-600" />
        </div>
        <button onClick={() => setModalOpen(true)} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm hover:bg-emerald-500">
          + Add channel
        </button>
      </div>

      {isLoading && <p className="text-neutral-400">Loading…</p>}
      {error && <p className="text-red-400">{(error as Error).message}</p>}
      {data && (
        <>
          <div className="space-y-1">{data.items.map((c) => <ChannelRow key={c.id} c={c} />)}</div>
          <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onPage={(p) => setSearch({ page: p })} />
        </>
      )}

      <AddChannelModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  );
}
