import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { trackingApi } from '../api/tracking';
import { fmtRelative } from '../lib/format';

export const Route = createFileRoute('/discovery')({ component: DiscoveryPage });

function DiscoveryPage() {
  const { data, isLoading } = useQuery({ queryKey: ['discovery'], queryFn: () => trackingApi.discovery() });

  return (
    <div>
      <h1 className="text-display-md" style={{ marginBottom: 4 }}>Discovery</h1>
      <p style={{ marginBottom: 16, fontSize: 14, color: 'var(--color-ink-muted)' }}>
        Channels seen in ads on tracked channels but not yet polled (closed or unresolved).
      </p>
      {isLoading && <p style={{ color: 'var(--color-ink-muted)' }}>Loading…</p>}
      {data && data.items.length === 0 && <p style={{ color: 'var(--color-ink-muted)' }}>Nothing in queue right now.</p>}
      {data && data.items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {data.items.map((it) => (
            <div key={it.id} style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              background: 'var(--color-surface-1)',
              borderRadius: 'var(--radius-lg)',
              padding: '14px 18px',
              fontSize: 14,
            }}>
              <div>
                <span style={{ fontWeight: 500, color: 'var(--color-ink)' }}>@{it.username ?? '(no username)'}</span>
                {it.isClosed && (
                  <span style={{
                    marginLeft: 8,
                    background: 'rgba(239,68,68,0.18)',
                    color: 'var(--color-danger)',
                    borderRadius: 'var(--radius-pill)',
                    padding: '2px 8px',
                    fontSize: 12,
                    fontWeight: 500,
                  }}>
                    closed
                  </span>
                )}
              </div>
              <span style={{ color: 'var(--color-ink-muted)' }}>seen {fmtRelative(it.addedAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
