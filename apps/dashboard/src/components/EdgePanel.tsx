// apps/dashboard/src/components/EdgePanel.tsx
//
// Side-sheet that opens when an edge label / chip on the graph is clicked.
// Shows every post in `sourceId` that mentioned `targetUsername`, rendered
// to read like Telegram: full text (no line clamp), preserved whitespace,
// auto-linked @mentions and URLs, full engagement meta line, "Open in
// Telegram" deep-link to the original message.

import { useQuery } from '@tanstack/react-query';
import { trackingApi } from '../api/tracking';
import { fmtRelative, fmtNumber } from '../lib/format';
import { ChannelAvatar } from './ChannelAvatar';
import { Icon } from './Icon';
import type { TrackedPost, TrackedChannel } from '../api/types';

interface Props {
  sourceId:       string;
  targetUsername: string;
  onClose:        () => void;
}

export function EdgePanel({ sourceId, targetUsername, onClose }: Props) {
  // Source channel — gives us channel_key / kind / tgChatId for the
  // "open original post" deep link (different URL shape for public vs
  // private). Cached by useQuery so re-renders are cheap.
  const channelQ = useQuery({
    queryKey: ['channel', sourceId],
    queryFn:  () => trackingApi.getChannel(sourceId),
  });

  const postsQ = useQuery({
    queryKey: ['edge-posts', sourceId, targetUsername],
    queryFn:  () => trackingApi.edgePosts(sourceId, targetUsername),
  });

  return (
    <div
      style={{
        position: 'fixed', inset: '0 0 0 auto', zIndex: 50,
        display: 'flex', flexDirection: 'column',
        width: '100%', maxWidth: 560,
        background: 'var(--color-surface-1)',
        borderLeft: '1px solid var(--color-hairline)',
        boxShadow: '-16px 0 48px rgba(0,0,0,0.50)',
      }}
    >
      <header
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: 20,
          borderBottom: '1px solid var(--color-hairline-soft)',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div className="text-eyebrow" style={{ marginBottom: 4 }}>
            Posts referencing
          </div>
          <h3 className="text-headline" style={{ margin: 0 }}>@{targetUsername}</h3>
          {channelQ.data && (
            <div className="text-caption" style={{ marginTop: 6, color: 'var(--color-ink-muted)' }}>
              from {channelQ.data.title ?? channelQ.data.channelKey ?? channelQ.data.username ?? sourceId.slice(0, 8)}
            </div>
          )}
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          className="btn-icon"
          style={{ width: 32, height: 32 }}
        >
          <Icon name="x" size={16} />
        </button>
      </header>

      <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {postsQ.isLoading && (
          <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Loading…</p>
        )}
        {postsQ.data && postsQ.data.items.length === 0 && (
          <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>
            No posts found referencing this target.
          </p>
        )}
        {postsQ.data?.items.map((p) => (
          <PostCard key={p.id} post={p} channel={channelQ.data ?? null} />
        ))}
      </div>
    </div>
  );
}

// ─── Post card ─────────────────────────────────────────────────────────────

function PostCard({ post, channel }: { post: TrackedPost; channel: TrackedChannel | null }) {
  const tgLink = buildTelegramLink(channel, post.tgMessageId);
  return (
    <article
      style={{
        background: 'var(--color-surface-2)',
        borderRadius: 'var(--radius-md)',
        padding: 14,
      }}
    >
      {/* Channel-row header — small avatar + name + relative date, mirrors
          how Telegram itself heads each post. */}
      <header style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <ChannelAvatar
          name={channel?.title ?? channel?.username ?? channel?.channelKey ?? '?'}
          size={28}
        />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="text-body-sm" style={{ color: 'var(--color-ink)' }}>
            {channel?.title ?? channel?.channelKey ?? channel?.username ?? '—'}
          </div>
          <div className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>
            {fmtRelative(post.postedAt)}
            {tgLink && (
              <>
                {' · '}
                <a href={tgLink} target="_blank" rel="noopener noreferrer" className="link-accent">
                  Open in Telegram ↗
                </a>
              </>
            )}
          </div>
        </div>
      </header>

      {post.hasMedia && (
        <div
          className="text-micro"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '4px 10px',
            background: 'var(--color-surface-1)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--color-ink-muted)',
            marginBottom: 10,
          }}
        >
          📎 media attached
        </div>
      )}

      {post.text ? (
        <PostBody text={post.text} />
      ) : (
        <p className="text-body-sm" style={{ color: 'var(--color-ink-dim)', margin: 0, fontStyle: 'italic' }}>
          {post.hasMedia ? '(no caption)' : '(empty post)'}
        </p>
      )}

      {/* Engagement footer — only render the values we actually have. */}
      <footer
        style={{
          marginTop: 10,
          paddingTop: 10,
          borderTop: '1px solid var(--color-hairline-soft)',
          display: 'flex', flexWrap: 'wrap', gap: 14,
        }}
      >
        <Stat label="👁 views"    value={post.views} />
        <Stat label="↺ forwards" value={post.forwards} />
        <Stat label="❤ reactions" value={post.reactionsTotal} />
        <Stat label="💬 comments" value={post.commentsCount} />
      </footer>
    </article>
  );
}

function Stat({ label, value }: { label: string; value: number | null }) {
  if (value == null) return null;
  return (
    <span
      className="text-micro"
      style={{ color: 'var(--color-ink-muted)', fontVariantNumeric: 'tabular-nums' }}
    >
      {label} <span style={{ color: 'var(--color-ink)' }}>{fmtNumber(value)}</span>
    </span>
  );
}

// ─── Post body rendering ───────────────────────────────────────────────────

/**
 * Render post text preserving whitespace + auto-linking URLs and
 * @mentions. React escapes text nodes by default; we split the string
 * into segments and wrap link-shaped ones in <a>. No HTML / dangerouslySet
 * — input is post text, treat it as untrusted.
 */
function PostBody({ text }: { text: string }) {
  const segments = autolinkSegments(text);
  return (
    <p
      className="text-body"
      style={{
        margin: 0,
        color: 'var(--color-ink)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        lineHeight: 1.5,
      }}
    >
      {segments.map((seg, i) => {
        if (seg.kind === 'text') return <span key={i}>{seg.text}</span>;
        return (
          <a
            key={i}
            href={seg.href}
            target="_blank"
            rel="noopener noreferrer"
            className="link-accent"
          >
            {seg.text}
          </a>
        );
      })}
    </p>
  );
}

interface Segment {
  kind: 'text' | 'link';
  text: string;
  href?: string;
}

// Two patterns: bare URLs (http/https/t.me) and @mentions. Order matters
// because URLs containing "@" (e.g. "https://example.com/@foo") would
// otherwise get double-matched. URLs first; @mentions only when the
// preceding character isn't already part of a URL.
const URL_RE     = /(https?:\/\/[^\s)]+|t\.me\/[^\s)]+)/g;
const MENTION_RE = /(?:^|[^\w@\/])(@[a-zA-Z][\w]{3,31})/g;

function autolinkSegments(text: string): Segment[] {
  const out: Segment[] = [];
  let cursor = 0;
  // Collect all matches across both patterns, sorted by offset.
  const matches: Array<{ start: number; end: number; text: string; href: string }> = [];
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    const matched = m[0];
    const href = matched.startsWith('http') ? matched : `https://${matched}`;
    matches.push({ start, end: start + matched.length, text: matched, href });
  }
  for (const m of text.matchAll(MENTION_RE)) {
    const captured = m[1];
    // m.index is the position of the full match (which may include the
    // leading delimiter); compute the actual handle offset.
    const offset = (m.index ?? 0) + m[0].indexOf(captured);
    matches.push({
      start: offset, end: offset + captured.length, text: captured,
      href: `https://t.me/${captured.slice(1)}`,
    });
  }
  matches.sort((a, b) => a.start - b.start);

  // Drop overlapping matches (URL containing @).
  const filtered: typeof matches = [];
  for (const m of matches) {
    const last = filtered[filtered.length - 1];
    if (!last || m.start >= last.end) filtered.push(m);
  }

  for (const m of filtered) {
    if (m.start > cursor) out.push({ kind: 'text', text: text.slice(cursor, m.start) });
    out.push({ kind: 'link', text: m.text, href: m.href });
    cursor = m.end;
  }
  if (cursor < text.length) out.push({ kind: 'text', text: text.slice(cursor) });
  return out;
}

// ─── Telegram deep-link ────────────────────────────────────────────────────

/**
 * Build the URL that opens the original message in Telegram.
 *
 *   public channel  → https://t.me/<username>/<messageId>
 *   private channel → https://t.me/c/<shortChatId>/<messageId>
 *
 * For private channels Telegram strips the leading `-100` from the chat
 * id to form the "short" id used in t.me/c URLs. Returns null when we
 * can't determine either form (no channel / no message id).
 */
function buildTelegramLink(channel: TrackedChannel | null, messageId: string): string | null {
  if (!channel || !messageId) return null;
  if (channel.kind === 'private' && channel.tgChatId) {
    const short = channel.tgChatId.replace(/^-?100/, '');
    return `https://t.me/c/${short}/${messageId}`;
  }
  if (channel.username) {
    return `https://t.me/${channel.username}/${messageId}`;
  }
  if (channel.channelKey?.startsWith('@')) {
    return `https://t.me/${channel.channelKey.slice(1)}/${messageId}`;
  }
  return null;
}
