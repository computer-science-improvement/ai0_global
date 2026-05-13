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
    <div style={{
      position: 'fixed', inset: '0 0 0 auto', zIndex: 50,
      display: 'flex', flexDirection: 'column',
      width: '100%', maxWidth: 448,
      background: 'var(--color-surface-1)',
      borderLeft: '1px solid var(--color-hairline)',
      boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
    }}>
      <header style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        borderBottom: '1px solid var(--color-hairline)',
        padding: 20,
      }}>
        <div>
          <h3 style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--color-ink-muted)', margin: 0 }}>
            Ad posts to
          </h3>
          <p style={{ fontSize: 17, fontWeight: 700, margin: '2px 0 0', color: 'var(--color-ink)' }}>
            @{targetUsername}
          </p>
        </div>
        <button onClick={onClose} className="btn-secondary">Close</button>
      </header>
      <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {q.isLoading && <p style={{ color: 'var(--color-ink-muted)' }}>Loading…</p>}
        {q.data && q.data.items.length === 0 && <p style={{ color: 'var(--color-ink-muted)' }}>No posts found.</p>}
        {q.data?.items.map((p) => (
          <div key={p.id} style={{
            background: 'var(--color-surface-2)',
            borderRadius: 'var(--radius-md)',
            padding: 14,
            fontSize: 14,
          }}>
            <div style={{ fontSize: 12, color: 'var(--color-ink-muted)' }}>
              {fmtRelative(p.postedAt)} · 👁 {fmtNumber(p.views)}
            </div>
            <p style={{ marginTop: 6, color: 'var(--color-ink)', lineHeight: 1.5 }} className="line-clamp-3">
              {p.text ?? <em style={{ color: 'var(--color-ink-muted)' }}>(media only)</em>}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
