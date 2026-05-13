import { useQuery } from '@tanstack/react-query';
import { trackingApi } from '../api/tracking';
import { SubsHistoryChart } from './SubsHistoryChart';
import { RoiPanel } from './RoiPanel';
import { fmtNumber } from '../lib/format';

export function ChannelDialog({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const channelQ = useQuery({ queryKey: ['channel', channelId], queryFn: () => trackingApi.getChannel(channelId) });
  const subsQ    = useQuery({ queryKey: ['subs', channelId],    queryFn: () => trackingApi.subsHistory(channelId) });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-neutral-950 p-6 ring-1 ring-neutral-800" onClick={(e) => e.stopPropagation()}>
        {channelQ.data && (
          <>
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h2 className="text-xl font-bold">{channelQ.data.title ?? channelQ.data.username}</h2>
                {channelQ.data.username && (
                  <a href={`https://t.me/${channelQ.data.username}`} target="_blank" rel="noreferrer"
                    className="text-sm text-blue-400 hover:underline">
                    @{channelQ.data.username} ↗
                  </a>
                )}
                <div className="mt-1 text-sm text-neutral-400">
                  {fmtNumber(channelQ.data.subsCount)} subs · {channelQ.data.pollTier}
                </div>
              </div>
              <button onClick={onClose} className="rounded bg-neutral-800 px-3 py-1 text-sm hover:bg-neutral-700">Close</button>
            </div>
            <div className="space-y-4">
              <RoiPanel channelId={channelId} />
              {subsQ.data && subsQ.data.points.length > 0 && (
                <section>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">Subscribers over time</h3>
                  <SubsHistoryChart points={subsQ.data.points} />
                </section>
              )}
              <a href={`/channels/${channelId}`} className="block rounded bg-emerald-600 px-4 py-2 text-center text-sm hover:bg-emerald-500">
                Open full channel page →
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
