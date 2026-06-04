import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { trackingApi } from '../api/tracking';
import { ChannelRow } from '../components/ChannelRow';
import { Pagination } from '../components/Pagination';
import { PageHeader } from '../components/ui/PageHeader';

const PAGE_SIZE = 50;

// Tracked / competitor channels (NOT is_mine) — the intelligence side. Owned
// publish targets live under «Мої канали» (Publishing). This is the flat,
// manageable list that complements the Graph and Discovery views.
interface Search { page: number; q: string; }

export const Route = createFileRoute('/tracked')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    page: Math.max(1, Number(s.page) || 1),
    q:    String(s.q ?? ''),
  }),
  component: TrackedPage,
});

function TrackedPage() {
  const { page, q } = Route.useSearch();
  const navigate = Route.useNavigate();
  const setSearch = (patch: Partial<Search>) =>
    navigate({ search: (old: Search) => ({ ...old, ...patch }) });

  const { data, isLoading, error } = useQuery({
    queryKey: ['channels', 'external', page, q],
    queryFn:  () => trackingApi.listChannels({ filter: 'external', q: q || undefined, page, pageSize: PAGE_SIZE }),
  });

  return (
    <div>
      <PageHeader title="Відстежувані канали" subtitle="Чужі канали, що відстежуються (не мої)" />

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        <input
          value={q}
          onChange={(e) => setSearch({ q: e.target.value, page: 1 })}
          placeholder="Пошук…"
          className="input-field"
          style={{ flex: 1, minWidth: 220, maxWidth: 360 }}
        />
      </div>

      {isLoading && <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Завантаження…</p>}
      {error && <p className="text-body-sm" style={{ color: 'var(--color-danger)' }}>{(error as Error).message}</p>}
      {data && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {data.items.map((c) => <ChannelRow key={c.id} c={c} />)}
          </div>
          <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onPage={(p) => setSearch({ page: p })} />
        </>
      )}
    </div>
  );
}
