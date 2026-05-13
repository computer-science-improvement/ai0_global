import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { trackingApi } from '../api/tracking';
import { fmtNumber, fmtRelative } from '../lib/format';

const CONF_COLOR = { low: 'bg-rose-700', medium: 'bg-amber-700', high: 'bg-emerald-700' } as const;

export function RoiPanel({ channelId }: { channelId: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['roi', channelId], queryFn: () => trackingApi.roi(channelId) });
  const m = useMutation({
    mutationFn: () => trackingApi.roi(channelId, true),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['roi', channelId] }),
  });

  if (q.isLoading) return <p className="text-neutral-500">Computing ROI…</p>;
  if (!q.data) return null;
  const r = q.data;

  return (
    <div className="rounded-lg bg-neutral-900 p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-3xl font-bold tabular-nums">{fmtNumber(r.estimated_subs_per_ad)}</div>
          <div className="text-xs text-neutral-400">estimated subscribers per ad placement</div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`${CONF_COLOR[r.confidence]} rounded px-2 py-0.5 text-xs`}>{r.confidence}</span>
          <button onClick={() => m.mutate()} disabled={m.isPending}
            className="rounded bg-neutral-800 px-3 py-1 text-xs hover:bg-neutral-700 disabled:opacity-50">
            {m.isPending ? 'Recomputing…' : 'Recompute'}
          </button>
        </div>
      </div>
      {r.narrative && <p className="mt-3 text-sm text-neutral-200">{r.narrative}</p>}
      {r.risks.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-sm text-neutral-400">
          {r.risks.map((x, i) => <li key={i}>{x}</li>)}
        </ul>
      )}
      <div className="mt-3 text-xs text-neutral-500">
        Computed via {r.source} · {fmtRelative(r.computed_at)}
      </div>
    </div>
  );
}
