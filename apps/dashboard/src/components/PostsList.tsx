import { fmtNumber, fmtRelative } from '../lib/format';
import type { TrackedPost } from '../api/types';

export function PostsList({ posts }: { posts: TrackedPost[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {posts.map((p) => (
        <div key={p.id} style={{
          background: 'var(--color-surface-1)',
          borderRadius: 'var(--radius-md)',
          padding: 14,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12, color: 'var(--color-ink-muted)' }}>
            <span>{fmtRelative(p.postedAt)}</span>
            <span className="tabular-nums">👁 {fmtNumber(p.views)} · 🔁 {fmtNumber(p.forwards)} · ❤ {fmtNumber(p.reactionsTotal)} · 💬 {fmtNumber(p.commentsCount)}</span>
          </div>
          <p style={{ marginTop: 8, fontSize: 14, color: 'var(--color-ink)', letterSpacing: '-0.14px', lineHeight: 1.5 }} className="line-clamp-3">
            {p.text ?? <em style={{ color: 'var(--color-ink-muted)' }}>(media only)</em>}
          </p>
        </div>
      ))}
    </div>
  );
}
