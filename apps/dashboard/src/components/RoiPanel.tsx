import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { trackingApi } from '../api/tracking';
import { fmtNumber, fmtRelative } from '../lib/format';

const CONF_COLOR = {
  low:    { background: 'rgba(239,68,68,0.18)',  color: 'var(--color-danger)' },
  medium: { background: 'rgba(245,158,11,0.18)', color: 'var(--color-warning)' },
  high:   { background: 'rgba(34,197,94,0.18)',  color: 'var(--color-success)' },
} as const;

export function RoiPanel({ channelId }: { channelId: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['roi', channelId], queryFn: () => trackingApi.roi(channelId) });
  const m = useMutation({
    mutationFn: () => trackingApi.roi(channelId, true),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['roi', channelId] }),
  });

  if (q.isLoading) return <p style={{ color: 'var(--color-ink-muted)' }}>Computing ROI…</p>;
  if (!q.data) return null;
  const r = q.data;

  return (
    <div className="card">
      <div className="flex items-center justify-between">
        <div>
          <div style={{ fontSize: 40, fontWeight: 700, letterSpacing: '-1.2px', lineHeight: 1 }} className="tabular-nums">
            {fmtNumber(r.estimated_subs_per_ad)}
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-ink-muted)', marginTop: 4 }}>
            estimated subscribers per ad placement
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span style={{
            ...CONF_COLOR[r.confidence],
            borderRadius: 'var(--radius-pill)',
            padding: '2px 10px',
            fontSize: 12,
            fontWeight: 500,
          }}>
            {r.confidence}
          </span>
          <button
            onClick={() => m.mutate()}
            disabled={m.isPending}
            className="btn-secondary"
            style={{ opacity: m.isPending ? 0.5 : 1 }}
          >
            {m.isPending ? 'Recomputing…' : 'Recompute'}
          </button>
        </div>
      </div>
      {r.narrative && (
        <p style={{ marginTop: 12, fontSize: 15, color: 'var(--color-ink)', letterSpacing: '-0.15px' }}>
          {r.narrative}
        </p>
      )}
      {r.risks.length > 0 && (
        <ul style={{ marginTop: 8, paddingLeft: 20, fontSize: 14, color: 'var(--color-ink-muted)' }} className="list-disc">
          {r.risks.map((x, i) => <li key={i}>{x}</li>)}
        </ul>
      )}
      <div style={{ marginTop: 12, fontSize: 12, color: 'var(--color-ink-muted)' }}>
        Computed via {r.source} · {fmtRelative(r.computed_at)}
      </div>
    </div>
  );
}
