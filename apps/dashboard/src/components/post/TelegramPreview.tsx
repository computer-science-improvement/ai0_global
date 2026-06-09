import type { ComposedPostInput } from '../../api/types';

/** Renders a Telegram-message-like bubble: media in chosen position, HTML text, button grid. */
export function TelegramPreview({ post }: { post: ComposedPostInput }) {
  const media = post.mediaType !== 'none' && post.mediaUrl ? (
    post.mediaType === 'photo'
      ? <img src={post.mediaUrl} alt="" style={{ width: '100%', borderRadius: 8, display: 'block' }} />
      : <video src={post.mediaUrl} controls style={{ width: '100%', borderRadius: 8, display: 'block' }} />
  ) : null;

  return (
    <div style={{ background: 'var(--color-surface-2)', borderRadius: 12, padding: 10, maxWidth: 360 }}>
      {post.mediaPlacement === 'above' && media}
      {/* Operator-authored Telegram HTML; rendered as-is for fidelity (trusted input). */}
      <div className="text-body-sm" style={{ color: 'var(--color-ink)', whiteSpace: 'pre-wrap', margin: '8px 2px' }}
           dangerouslySetInnerHTML={{ __html: post.text || '<span style="opacity:.5">(empty)</span>' }} />
      {post.mediaPlacement === 'below' && media}
      {post.buttons.some(r => r.buttons.length > 0) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
          {post.buttons.map((row, ri) => (
            <div key={ri} style={{ display: 'flex', gap: 4 }}>
              {row.buttons.map((b, bi) => (
                <span key={bi} style={{ flex: 1, textAlign: 'center', padding: '6px 8px',
                  background: 'var(--color-surface-3)', borderRadius: 6, color: 'var(--color-accent)', fontSize: 13 }}>
                  {b.label || 'button'}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
