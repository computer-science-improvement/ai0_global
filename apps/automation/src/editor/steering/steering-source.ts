import type { HistoryMessage } from '../setup/setup-posts';
import { MIN_POSTS, POSTS_TO_READ, type SetupPost } from '../setup/setup-posts.types';
import type { SourcePost } from './steering.types';

/**
 * Spec 045 FR-002 / FR-010: reading a reference resource. One reader per platform; Telegram reads a public channel's
 * history through the tracking userbot (no subscription needed). The snapshot keeps the last POSTS_TO_READ usable posts,
 * newest first, keyed r1…rN. FLOOD_WAIT propagates (the worker re-queues the set).
 */

/** Text kept per reference post (the prompt cuts it further). */
export const SOURCE_TEXT_MAX = 4000;
const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;

export interface SourceInfo { title: string | null; about: string | null; subscribers: number | null }

export type ReadResult =
  | { status: 'ok'; info: SourceInfo; posts: SourcePost[] }
  | { status: 'no_access' | 'too_few_posts'; info: SourceInfo | null; posts: SourcePost[]; reason: string };

export interface SteeringSourceReader {
  platform: string;
  read(sourceRef: string): Promise<ReadResult>;
}

/**
 * `@name`, `name`, `t.me/name`, `https://t.me/s/name`, `t.me/name/123` → `telegram:@name`. Invite links (private channels)
 * and anything else are refused: steering reads public resources only.
 */
export function parseSourceRef(input: string): { ref: string } | { error: 'invalid_source'; details: string } {
  const raw = input.trim();
  if (/^telegram:@/i.test(raw)) return parseSourceRef(raw.slice('telegram:'.length));
  const link = raw.match(/^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/(?:s\/)?([^/?#\s]+)/i);
  const name = (link ? link[1] : raw).replace(/^@/, '');
  if (link && (name.startsWith('+') || name.toLowerCase() === 'joinchat')) {
    return { error: 'invalid_source', details: 'This is an invite link to a private channel; steering reads public channels only' };
  }
  if (!USERNAME_RE.test(name)) {
    return { error: 'invalid_source', details: 'Give a public Telegram channel as @username or a t.me link' };
  }
  return { ref: `telegram:@${name}` };
}

/** A message worth learning from: text, or media (its format still counts). */
const usable = (m: HistoryMessage) => !!(m.text ?? '').trim() || m.hasMedia;

export function toSourcePosts(messages: readonly HistoryMessage[]): SourcePost[] {
  return [...messages]
    .filter(usable)
    .sort((a, b) => b.date.getTime() - a.date.getTime() || b.id - a.id)
    .slice(0, POSTS_TO_READ)
    .map((m, i) => ({
      key: `r${i + 1}`, msgId: m.id, postedAt: m.date.toISOString(), text: (m.text ?? '').slice(0, SOURCE_TEXT_MAX),
      mediaType: m.hasMedia ? (m.mediaType ?? 'media') : null, views: m.views, reactions: m.reactionsTotal ?? null,
      forwards: m.forwards, comments: m.replies,
    }));
}

/** The snapshot as the spec 042 metrics read posts. */
export function asSetupPosts(posts: readonly SourcePost[]): SetupPost[] {
  return posts.map((p) => ({
    key: p.key, id: p.key, msgId: p.msgId, postedAt: new Date(p.postedAt), text: p.text, hasMedia: p.mediaType !== null,
    mediaType: p.mediaType, views: p.views, forwards: p.forwards, reactionsTotal: p.reactions, comments: p.comments,
  }));
}

export interface TelegramReaderDeps {
  /** TrackingMtprotoClient.readHistory(target, 0, limit). */
  readHistory?: (target: string, limit: number) => Promise<{ access: 'ok' | 'not_subscribed' | 'unavailable'; messages: HistoryMessage[] }>;
  /** TrackingMtprotoClient.getFullChannel: title, about, subscribers. */
  fullChannel?: (target: string) => Promise<{ title: string | null; about: string | null; subsCount: number | null } | 'not_subscribed' | null>;
}

export function telegramReader(d: TelegramReaderDeps): SteeringSourceReader {
  return {
    platform: 'telegram',
    async read(sourceRef) {
      const name = sourceRef.replace(/^telegram:@?/, '');
      if (!d.readHistory) return { status: 'no_access', info: null, posts: [], reason: 'The tracking account is not connected' };
      const full = d.fullChannel ? await d.fullChannel(name).catch(() => null) : null;
      const info: SourceInfo | null = full && full !== 'not_subscribed'
        ? { title: full.title, about: full.about, subscribers: full.subsCount } : null;
      const live = await d.readHistory(name, 50);
      if (live.access !== 'ok') {
        return {
          status: 'no_access', info, posts: [],
          reason: live.access === 'not_subscribed'
            ? 'The tracking account cannot read this channel: it must be public'
            : 'The channel could not be read (no such public channel, or the tracking account is offline)',
        };
      }
      const posts = toSourcePosts(live.messages);
      if (posts.length < MIN_POSTS) {
        return { status: 'too_few_posts', info, posts, reason: `${posts.length} posts — at least ${MIN_POSTS} are needed to learn from` };
      }
      return { status: 'ok', info: info ?? { title: null, about: null, subscribers: null }, posts };
    },
  };
}
