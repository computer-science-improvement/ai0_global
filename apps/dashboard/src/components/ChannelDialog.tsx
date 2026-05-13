import { useQuery } from '@tanstack/react-query';
import { trackingApi } from '../api/tracking';
import { SubsHistoryChart } from './SubsHistoryChart';
import { RoiPanel } from './RoiPanel';
import { fmtNumber } from '../lib/format';

export function ChannelDialog({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const channelQ = useQuery({ queryKey: ['channel', channelId], queryFn: () => trackingApi.getChannel(channelId) });
  const subsQ    = useQuery({ queryKey: ['subs', channelId],    queryFn: () => trackingApi.subsHistory(channelId) });

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.72)' }}
      onClick={onClose}
    >
      <div
        style={{
          maxHeight: '90vh',
          width: '100%',
          maxWidth: 672,
          overflowY: 'auto',
          background: 'var(--color-surface-1)',
          borderRadius: 'var(--radius-xl)',
          padding: 28,
          border: '1px solid var(--color-hairline)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {channelQ.data && (
          <>
            <div style={{ marginBottom: 16, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
              <div>
                <h2 className="text-headline" style={{ margin: 0 }}>
                  {channelQ.data.title ?? channelQ.data.username}
                </h2>
                {channelQ.data.username && (
                  <a
                    href={`https://t.me/${channelQ.data.username}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ fontSize: 14, color: 'var(--color-accent)', textDecoration: 'none' }}
                  >
                    @{channelQ.data.username} ↗
                  </a>
                )}
                <div style={{ marginTop: 4, fontSize: 14, color: 'var(--color-ink-muted)' }}>
                  {fmtNumber(channelQ.data.subsCount)} subs · {channelQ.data.pollTier}
                </div>
              </div>
              <button onClick={onClose} className="btn-secondary">Close</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <RoiPanel channelId={channelId} />
              {subsQ.data && subsQ.data.points.length > 0 && (
                <section>
                  <h3 style={{ marginBottom: 8, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--color-ink-muted)' }}>
                    Subscribers over time
                  </h3>
                  <SubsHistoryChart points={subsQ.data.points} />
                </section>
              )}
              <a
                href={`/channels/${channelId}`}
                className="btn-primary"
                style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}
              >
                Open full channel page →
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
