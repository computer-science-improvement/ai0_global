import type { ComposedPostInput } from '../../api/types';

/** Renders a Telegram-message-like bubble: media in chosen position, HTML text, button grid. */
export function TelegramPreview({ post }: { post: ComposedPostInput }) {
  const media = post.mediaType !== 'none' && post.mediaUrl ? (
    post.mediaType === 'photo'
      ? <img src={post.mediaUrl} alt="" className="pc-bubble-media" />
      : <video src={post.mediaUrl} controls className="pc-bubble-media" />
  ) : null;

  return (
    <div className="pc-bubble">
      {post.mediaPlacement === 'above' && media}
      {/* Operator-authored Telegram HTML; rendered as-is for fidelity (trusted input). */}
      <div className="text-body-sm" style={{ whiteSpace: 'pre-wrap', margin: '8px 2px' }}
           dangerouslySetInnerHTML={{ __html: post.text || '<span style="opacity:.5">(empty)</span>' }} />
      {post.mediaPlacement === 'below' && media}
      {post.buttons.some(r => r.buttons.length > 0) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
          {post.buttons.map((row, ri) => (
            <div key={ri} style={{ display: 'flex', gap: 4 }}>
              {row.buttons.map((b, bi) => (
                <span className="pc-bubble-btn" key={bi}>
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
