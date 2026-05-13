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
      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            display: 'flex',
            background: 'var(--color-surface-1)',
            borderRadius: 'var(--radius-pill)',
            padding: 4,
            fontSize: 14,
            gap: 2,
          }}>
            {(['all', 'mine', 'external'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setSearch({ filter: f, page: 1 })}
                style={{
                  borderRadius: 'var(--radius-pill)',
                  padding: '4px 14px',
                  fontSize: 14,
                  cursor: 'pointer',
                  border: 'none',
                  background: filter === f ? 'var(--color-surface-2)' : 'transparent',
                  color: filter === f ? 'var(--color-ink)' : 'var(--color-ink-muted)',
                  transition: 'background 0.15s, color 0.15s',
                }}
              >
                {f}
              </button>
            ))}
          </div>
          <input
            value={q}
            onChange={(e) => setSearch({ q: e.target.value, page: 1 })}
            placeholder="Search…"
            className="input-field"
          />
        </div>
        <button onClick={() => setModalOpen(true)} className="btn-primary">
          + Add channel
        </button>
      </div>

      {isLoading && <p style={{ color: 'var(--color-ink-muted)' }}>Loading…</p>}
      {error && <p style={{ color: 'var(--color-danger)' }}>{(error as Error).message}</p>}
      {data && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {data.items.map((c) => <ChannelRow key={c.id} c={c} />)}
          </div>
          <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onPage={(p) => setSearch({ page: p })} />
        </>
      )}

      <AddChannelModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  );
}
