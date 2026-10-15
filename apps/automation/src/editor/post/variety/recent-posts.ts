import type { Pool } from 'pg';
import { PostSpecSchema } from '../post-spec';
import { auditPostFromSpec } from '../integrity/from-post-spec';
import type { AuditPost } from '../integrity/types';
import type { RenderCard } from '../render-telegram';
import { MONOTONY_WINDOW } from './monotony';

/**
 * Spec 037 FR-009 (T9): the resource's last posts as integrity posts — the history the monotony check and the
 * writer's «Уже було» block read. The Telegram channel's own written slots (published, shadowed, waiting for or
 * approved by the owner; the same statuses as `recentTexts`), newest first, at most MONOTONY_WINDOW. A live slot's
 * topic is only a label, so only a fixed slot carries its topic (same format + topic twice a day).
 */
export interface RecentPostsQuery {
  channelKey:     string;
  timezone:       string;
  excludeSlotId?: string | null;
  card?:          Partial<RenderCard>;
  limit?:         number;
  /** Spec 037 T2 (story history): only slots scheduled in [since, until]; absent = no bound. */
  since?:         Date | null;
  until?:         Date | null;
}

export function recentPostsFromRows(rows: any[], q: RecentPostsQuery): AuditPost[] {
  const out: AuditPost[] = [];
  for (const r of rows) {
    const spec = PostSpecSchema.safeParse(r?.post_spec);
    if (!spec.success || !r.scheduled_at) continue;
    const post = auditPostFromSpec(spec.data, {
      id: String(r.id), channel: q.channelKey, publishedAt: new Date(r.scheduled_at).toISOString(), timezone: q.timezone,
      card: q.card, ...(r.topic_mode !== 'live' && typeof r.topic === 'string' && r.topic.trim() ? { topic: r.topic } : {}),
    });
    // Spec 037 T2: a published slot's Telegram message (the reply target of a story follow-up).
    out.push(r.message_id != null ? { ...post, messageIds: [Number(r.message_id)] } : post);
  }
  return out;
}

export async function recentAuditPosts(pool: Pick<Pool, 'query'>, q: RecentPostsQuery): Promise<AuditPost[]> {
  const { rows } = await pool.query(
    `SELECT s.id::text AS id, s.scheduled_at, s.format, s.topic, s.topic_mode, s.post_spec, p.message_id
       FROM editor_slots s
       LEFT JOIN published_posts p ON p.id = s.published_post_id
      WHERE s.channel_key = $1 AND s.kind = 'content' AND s.post_spec IS NOT NULL
        AND (s.resource_ref IS NULL OR s.resource_ref = 'telegram:' || s.channel_key)
        AND s.status IN ('published','shadowed','awaiting_approval','approved')
        AND ($2::uuid IS NULL OR s.id <> $2)
        AND ($4::timestamptz IS NULL OR s.scheduled_at >= $4) AND ($5::timestamptz IS NULL OR s.scheduled_at <= $5)
      ORDER BY s.scheduled_at DESC LIMIT $3`,
    [q.channelKey, q.excludeSlotId ?? null, q.limit ?? MONOTONY_WINDOW, q.since ?? null, q.until ?? null]);
  return recentPostsFromRows(rows ?? [], q);
}
