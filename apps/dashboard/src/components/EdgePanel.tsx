import { useQuery } from '@tanstack/react-query';
import { trackingApi } from '../api/tracking';
import { fmtRelative, fmtNumber } from '../lib/format';

export function EdgePanel({ sourceId, targetUsername, onClose }:
  { sourceId: string; targetUsername: string; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['edge-posts', sourceId, targetUsername],
    queryFn:  () => trackingApi.edgePosts(sourceId, targetUsername),
  });

  return (
    <div className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col bg-neutral-950 ring-1 ring-neutral-800 shadow-xl">
      <header className="flex items-center justify-between border-b border-neutral-800 p-4">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-neutral-400">Ad posts to</h3>
          <p className="text-lg font-bold">@{targetUsername}</p>
        </div>
        <button onClick={onClose} className="rounded bg-neutral-800 px-3 py-1 text-sm hover:bg-neutral-700">Close</button>
      </header>
      <div className="flex-1 space-y-2 overflow-y-auto p-4">
        {q.isLoading && <p className="text-neutral-500">Loading…</p>}
        {q.data && q.data.items.length === 0 && <p className="text-neutral-500">No posts found.</p>}
        {q.data?.items.map((p) => (
          <div key={p.id} className="rounded-lg bg-neutral-900 p-3 text-sm">
            <div className="text-xs text-neutral-400">{fmtRelative(p.postedAt)} · 👁 {fmtNumber(p.views)}</div>
            <p className="mt-1 line-clamp-3">{p.text ?? <em className="text-neutral-500">(media only)</em>}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
