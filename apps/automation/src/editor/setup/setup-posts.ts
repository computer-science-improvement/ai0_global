import type { Pool } from 'pg';
import { MIN_POSTS, POSTS_TO_READ, type SetupPost } from './setup-posts.types';

/**
 * Spec 042 FR-001: the last posts of an own channel. `tracked_posts` first (full texts, filled by the tracking userbot's
 * poll); fewer than POSTS_TO_READ stored → one live `getHistory` of the latest 50, upserted like the poll worker does, then
 * read again. A channel the session cannot read is `no_access` (the model is never called); fewer than MIN_POSTS usable
 * posts is `too_few_posts`. FLOOD_WAIT propagates (the worker re-queues the proposal).
 */

export interface TrackedChannelRow {
  id:             string;
  channelKey:     string;
  username:       string | null;
  tgChatId:       string | null;
  title:          string | null;
  about:          string | null;
  subsCount:      number | null;
  isMine:         boolean;
  trackingStatus: string;
}

export interface HistoryMessage {
  id:             number;
  date:           Date;
  text:           string;
  hasMedia:       boolean;
  mediaType:      string | null;
  views:          number | null;
  forwards:       number | null;
  replies:        number | null;
  reactionsTotal: number;
  reactions:      Record<string, number> | null;
}

export interface SetupPostsDeps {
  pool: Pick<Pool, 'query'>;
  /** TrackingMtprotoClient.readHistory: the latest `limit` messages and whether the session can read the channel. */
  readHistory?: (target: string, limit: number) => Promise<{ access: 'ok' | 'not_subscribed' | 'unavailable'; messages: HistoryMessage[] }>;
}

export type CollectResult =
  | { status: 'ok'; channel: TrackedChannelRow; posts: SetupPost[]; toppedUp: number }
  | { status: 'not_tracked' | 'no_access' | 'too_few_posts'; channel: TrackedChannelRow | null; posts: SetupPost[]; reason: string };

/** A post worth learning from: text, or media with a caption-less format the mix still counts. */
const usable = (r: { text: string | null; has_media: boolean }) => !!(r.text ?? '').trim() || r.has_media;

export async function trackedChannel(pool: Pick<Pool, 'query'>, channelKey: string): Promise<TrackedChannelRow | null> {
  const { rows } = await pool.query(
    `SELECT id, channel_key, username, tg_chat_id::text AS tg_chat_id, title, about, subs_count, is_mine, tracking_status
       FROM tracked_channels WHERE channel_key = $1`, [channelKey]);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id, channelKey: r.channel_key, username: r.username ?? null, tgChatId: r.tg_chat_id ?? null, title: r.title ?? null,
    about: r.about ?? null, subsCount: r.subs_count == null ? null : Number(r.subs_count), isMine: !!r.is_mine,
    trackingStatus: r.tracking_status ?? 'unknown',
  };
}

/** The newest usable stored posts, newest first, keyed p1…pN. */
export async function storedPosts(pool: Pick<Pool, 'query'>, channelId: string, limit = POSTS_TO_READ): Promise<SetupPost[]> {
  const { rows } = await pool.query(
    `SELECT id, tg_message_id, text, has_media, media_type, posted_at, views, forwards, reactions_total, comments_count
       FROM tracked_posts WHERE channel_id = $1 ORDER BY posted_at DESC, tg_message_id DESC LIMIT $2`,
    [channelId, limit * 3]);
  return rows.filter(usable).slice(0, limit).map((r: any, i: number) => ({
    key: `p${i + 1}`, id: r.id, msgId: Number(r.tg_message_id), postedAt: new Date(r.posted_at), text: r.text ?? '',
    hasMedia: !!r.has_media, mediaType: r.media_type ?? null,
    views: r.views == null ? null : Number(r.views), forwards: r.forwards == null ? null : Number(r.forwards),
    reactionsTotal: r.reactions_total == null ? null : Number(r.reactions_total), comments: r.comments_count == null ? null : Number(r.comments_count),
  }));
}

async function upsertMessages(pool: Pick<Pool, 'query'>, channelId: string, msgs: HistoryMessage[]): Promise<number> {
  let n = 0;
  for (const m of msgs) {
    // Same columns as TrackedPostsRepository.upsert (the poll worker); ad refs stay to the poll worker.
    await pool.query(
      `INSERT INTO tracked_posts (channel_id, tg_message_id, text, has_media, media_type, posted_at, views, forwards,
                                  reactions_total, reactions, comments_count, last_metrics_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, now())
       ON CONFLICT (channel_id, tg_message_id) DO UPDATE SET
         text = EXCLUDED.text, has_media = EXCLUDED.has_media, media_type = EXCLUDED.media_type, views = EXCLUDED.views,
         forwards = EXCLUDED.forwards, reactions_total = EXCLUDED.reactions_total, reactions = EXCLUDED.reactions,
         comments_count = EXCLUDED.comments_count, last_metrics_at = now()`,
      [channelId, m.id, m.text ?? null, !!m.hasMedia, m.mediaType ?? null, m.date, m.views, m.forwards, m.reactionsTotal,
        m.reactions ? JSON.stringify(m.reactions) : null, m.replies]);
    n++;
  }
  return n;
}

export async function collectPosts(d: SetupPostsDeps, channelKey: string): Promise<CollectResult> {
  const channel = await trackedChannel(d.pool, channelKey);
  if (!channel || !channel.isMine) {
    return { status: 'not_tracked', channel, posts: [], reason: `${channelKey} is not one of your tracked channels` };
  }
  let posts = await storedPosts(d.pool, channel.id);
  let toppedUp = 0;
  if (posts.length < POSTS_TO_READ) {
    const target = channel.tgChatId ?? channel.username ?? channelKey.replace(/^@/, '');
    const live = d.readHistory ? await d.readHistory(target, 50) : { access: 'unavailable' as const, messages: [] };
    if (live.access === 'not_subscribed' || (live.access !== 'ok' && channel.trackingStatus === 'not_subscribed' && !posts.length)) {
      return { status: 'no_access', channel, posts, reason: 'Add the tracking account to the channel: it cannot read the posts' };
    }
    if (live.messages.length) {
      toppedUp = await upsertMessages(d.pool, channel.id, live.messages);
      posts = await storedPosts(d.pool, channel.id);
    } else if (live.access === 'unavailable' && !posts.length) {
      return { status: 'no_access', channel, posts, reason: 'The tracking account is not connected or the channel could not be read' };
    }
  }
  if (posts.length < MIN_POSTS) {
    return { status: 'too_few_posts', channel, posts, reason: `${posts.length} posts — at least ${MIN_POSTS} are needed to learn from` };
  }
  return { status: 'ok', channel, posts, toppedUp };
}
