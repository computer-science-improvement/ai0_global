import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { trackingApi } from '../api/tracking';
import { fmtNumber, fmtRelative } from '../lib/format';
import { Badge } from './ui/Badge';
import { EmptyState } from './ui/primitives';
import { LoadingNote } from './channels/ChannelsUi';

/** How sure the estimate is: a category (low → red, medium → amber, high → green), not a status of the app. */
const CONFIDENCE_TONE = { low: 'danger', medium: 'warning', high: 'success' } as const;

/**
 * The ROI estimate of a channel: subscribers per ad placement, how sure the estimate is, the narrative and the risks.
 * It has no frame of its own: put it in a `SectionCard` (or an `.inset` in a dialog).
 */
export function RoiPanel({ channelId }: { channelId: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['roi', channelId], queryFn: () => trackingApi.roi(channelId) });
  const m = useMutation({
    mutationFn: () => trackingApi.roi(channelId, true),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['roi', channelId] }),
  });

  if (q.isLoading) return <LoadingNote note="Computing ROI…" />;
  if (q.error || !q.data) {
    return (
      <EmptyState
        icon="warning"
        title="No ROI estimate"
        note={q.error ? (q.error as Error).message : 'Nothing has been computed for this channel yet.'}
      />
    );
  }
  const r = q.data;

  return (
    <div className="roi">
      <div className="roi-top">
        <div>
          <div className="stat-value">{fmtNumber(r.estimated_subs_per_ad)}</div>
          <div className="stat-label" style={{ marginTop: 4 }}>estimated subscribers per ad placement</div>
        </div>
        <div className="roi-actions">
          <Badge tone={CONFIDENCE_TONE[r.confidence] ?? 'neutral'} title="How sure the estimate is">{r.confidence} confidence</Badge>
          <button type="button" onClick={() => m.mutate()} disabled={m.isPending} className="btn-secondary btn-sm">
            {m.isPending ? 'Recomputing…' : 'Recompute'}
          </button>
        </div>
      </div>
      {r.narrative && <p className="roi-narrative">{r.narrative}</p>}
      {(r.risks ?? []).length > 0 && (
        <ul className="roi-risks">
          {r.risks.map((x, i) => <li key={i}>{x}</li>)}
        </ul>
      )}
      <div className="roi-foot mono">Computed via {r.source} · {fmtRelative(r.computed_at)}</div>
    </div>
  );
}
