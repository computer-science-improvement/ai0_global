import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { trackingApi } from '../api/tracking';
import { fmtRelative } from '../lib/format';

export const Route = createFileRoute('/discovery')({ component: DiscoveryPage });

function DiscoveryPage() {
  const { data, isLoading } = useQuery({ queryKey: ['discovery'], queryFn: () => trackingApi.discovery() });

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold">Discovery</h1>
      <p className="mb-4 text-sm text-neutral-400">Channels seen in ads on tracked channels but not yet polled (closed or unresolved).</p>
      {isLoading && <p className="text-neutral-400">Loading…</p>}
      {data && data.items.length === 0 && <p className="text-neutral-500">Nothing in queue right now.</p>}
      {data && data.items.length > 0 && (
        <div className="space-y-1">
          {data.items.map((it) => (
            <div key={it.id} className="flex items-center justify-between rounded-lg bg-neutral-900 px-4 py-3 text-sm">
              <div>
                <span className="font-medium">@{it.username ?? '(no username)'}</span>
                {it.isClosed && <span className="ml-2 rounded bg-rose-800 px-2 py-0.5 text-xs">closed</span>}
              </div>
              <span className="text-neutral-400">seen {fmtRelative(it.addedAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
