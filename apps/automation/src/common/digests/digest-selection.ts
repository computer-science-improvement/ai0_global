// What a digest is made of (spec 023 FR-009): our own already-published Telegram posts in a window, and
// how the two legacy digests pick from them. Shared by the network-digest / topic-digest strategies and
// the agents' get_network_highlights tool, so the strategies' behaviour becomes a tool the agent may use.
import type { Pool } from 'pg';
import { digestTitle, isLinkable, linkUsername, viewsPerHour } from './digest-format';

export interface DigestPostRow {
  channelKey: string;
  username:   string | null;
  messageId:  number;
  title:      string;
  views:      number | null;
  postedAt:   Date;
  /** published_posts.strategy_type — drives digestTitle() cleanup. */
  strategyType?: string | null;
}

/** Strategy types a network digest never lists: digests themselves and paid posts. */
export const DIGEST_EXCLUDED_TYPES = ['network-digest', 'topic-digest', 'ad'];

export interface DigestWindow {
  /** Posts since now − windowHours (the legacy strategies). */
  windowHours?:   number;
  /** Or an explicit [from, to) window (a calendar day). */
  from?:          Date;
  to?:            Date;
  /** Only these channel keys. */
  channels?:      string[];
  /** Only these strategy types (topic digest); otherwise everything but DIGEST_EXCLUDED_TYPES. */
  strategyTypes?: string[];
  /** Only own channels (tracked_channels.is_mine) and with the freshest view count (network digest). */
  ownWithViews?:  boolean;
  order?:         'newest' | 'oldest';
}

/** Our posts in a window, joined with the channel username (t.me links). */
export async function digestPostsInWindow(pool: Pick<Pool, 'query'>, w: DigestWindow): Promise<DigestPostRow[]> {
  const args: unknown[] = [];
  const p = (v: unknown) => { args.push(v); return `$${args.length}`; };
  const where: string[] = [];
  if (w.from || w.to) {
    if (w.from) where.push(`p.posted_at >= ${p(w.from)}`);
    if (w.to) where.push(`p.posted_at < ${p(w.to)}`);
  } else {
    where.push(`p.posted_at >= now() - (${p(String(w.windowHours ?? 24))} || ' hours')::interval`);
  }
  if (w.strategyTypes?.length) where.push(`p.strategy_type = ANY(${p(w.strategyTypes)})`);
  else where.push(`COALESCE(p.strategy_type, '') <> ALL(${p(DIGEST_EXCLUDED_TYPES)})`);
  where.push(`COALESCE(p.title, '') <> ''`);
  if (w.channels?.length) where.push(`p.channel_id = ANY(${p(w.channels)})`);
  const views = w.ownWithViews
    ? `LEFT JOIN LATERAL (SELECT views FROM post_stats_snapshots ps WHERE ps.post_id = p.id ORDER BY ps.captured_at DESC LIMIT 1) s ON TRUE`
    : `LEFT JOIN LATERAL (SELECT NULL::int AS views) s ON TRUE`;
  const r = await pool.query(
    `SELECT p.channel_id AS channel_key, tc.username AS username, p.message_id AS message_id, COALESCE(p.title, '') AS title,
            s.views AS views, p.posted_at AS posted_at, p.strategy_type AS strategy_type
       FROM published_posts p
       JOIN tracked_channels tc ON tc.channel_key = p.channel_id${w.ownWithViews ? ' AND tc.is_mine = TRUE' : ''}
       ${views}
      WHERE ${where.join(' AND ')}
      ORDER BY p.posted_at ${w.order === 'oldest' ? 'ASC' : 'DESC'}`,
    args,
  );
  return r.rows.map((row: any) => ({
    channelKey: row.channel_key,
    username:   row.username,
    messageId:  Number(row.message_id),
    title:      row.title,
    views:      row.views == null ? null : Number(row.views),
    postedAt:   new Date(row.posted_at),
    strategyType: row.strategy_type ?? null,
  }));
}

/** Network digest pick: linkable posts, digest titles, ranked by views per hour, the top N. */
export function pickNetworkHighlights(rows: DigestPostRow[], now: Date, maxItems: number): DigestPostRow[] {
  return rows
    .filter(isLinkable)
    .map((r) => ({ ...r, title: digestTitle(r.title, r.strategyType) }))
    .sort((a, b) => viewsPerHour(b.views, b.postedAt, now) - viewsPerHour(a.views, a.postedAt, now))
    .slice(0, maxItems);
}

/** Topic digest pick: linkable posts in chronological order, the newest N (rows come oldest first). */
export function pickTopicHighlights(rows: DigestPostRow[], maxItems: number): DigestPostRow[] {
  return rows
    .filter(isLinkable)
    .map((r) => ({ ...r, title: digestTitle(r.title, r.strategyType) }))
    .slice(-maxItems);
}

/** The t.me deep link of a post (null for a channel without a public username). */
export function postLink(r: Pick<DigestPostRow, 'channelKey' | 'username' | 'messageId'>): string | null {
  const u = linkUsername(r.channelKey, r.username);
  return u ? `https://t.me/${u}/${r.messageId}` : null;
}
