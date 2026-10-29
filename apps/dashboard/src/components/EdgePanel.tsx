// apps/dashboard/src/components/EdgePanel.tsx
//
// Side sheet that opens when an edge label / chip on the graph is clicked.
// Shows every post in `sourceId` that mentioned `targetUsername`, rendered
// to read like Telegram: full text (no line clamp), preserved whitespace,
// auto-linked @mentions and URLs, the engagement numbers, and an "Open in
// Telegram" deep-link to the original message. A drawer on the shared Modal
// (right sheet; a bottom sheet on phones).

import { useQuery } from '@tanstack/react-query';
import { trackingApi } from '../api/tracking';
import { channelName } from '../lib/channel-view';
import { fmtRelative, fmtNumber } from '../lib/format';
import { Modal } from './Modal';
import { ErrorCallout, LoadingNote } from './channels/ChannelsUi';
import { Badge } from './ui/Badge';
import { Icon } from './ui/Icon';
import { EmptyState } from './ui/primitives';
import type { TrackedPost, TrackedChannel } from '../api/types';
import './channels/channels.css';

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

  const source = channelQ.data;
  const posts = postsQ.data?.items ?? [];

  return (
    <Modal
      open
      onClose={onClose}
      size="drawer"
      icon="graph"
      title={`Posts referencing @${targetUsername}`}
      subtitle={source ? `from ${channelName(source, sourceId.slice(0, 8))}` : undefined}
    >
      <div className="gr-posts">
        {postsQ.isLoading && <LoadingNote note="Loading posts…" />}
        {postsQ.error && <ErrorCallout title="Couldn’t load the posts" error={postsQ.error} style={{ marginBottom: 0 }} />}
        {postsQ.data && posts.length === 0 && (
          <EmptyState icon="channels" title="No posts found" note="No post in this channel references this target." />
        )}
        {posts.map((p) => (
          <PostCard key={p.id} post={p} channel={source ?? null} />
        ))}
      </div>
    </Modal>
  );
}

// ─── Post card ─────────────────────────────────────────────────────────────

function PostCard({ post, channel }: { post: TrackedPost; channel: TrackedChannel | null }) {
  const tgLink = buildTelegramLink(channel, post.tgMessageId);
  const stats: Array<[string, number | null]> = [
    ['views', post.views],
    ['forwards', post.forwards],
    ['reactions', post.reactionsTotal],
    ['comments', post.commentsCount],
  ];
  return (
    <article className="inset gr-post">
      <header className="gr-post-head">
        <span className="mono">{fmtRelative(post.postedAt)}</span>
        <span className="gr-post-links">
          {post.hasMedia && <Badge tone="neutral"><Icon name="image" size={11} /> media</Badge>}
          {tgLink && (
            <a href={tgLink} target="_blank" rel="noopener noreferrer" className="link-accent gr-post-link">
              Open in Telegram
              <Icon name="external" size={12} />
            </a>
          )}
        </span>
      </header>

      {post.text ? (
        <PostBody text={post.text} />
      ) : (
        <p className="gr-post-text is-empty">
          {post.hasMedia ? '(no caption)' : '(empty post)'}
        </p>
      )}

      {/* Engagement footer — only render the values we actually have. */}
      <footer className="gr-post-stats mono">
        {stats.map(([label, value]) => value == null ? null : (
          <span key={label}><b>{fmtNumber(value)}</b> {label}</span>
        ))}
      </footer>
    </article>
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
    <p className="gr-post-text">
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
