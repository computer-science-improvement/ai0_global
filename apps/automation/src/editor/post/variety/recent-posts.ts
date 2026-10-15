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
}

export function recentPostsFromRows(rows: any[], q: RecentPostsQuery): AuditPost[] {
  const out: AuditPost[] = [];
  for (const r of rows) {
    const spec = PostSpecSchema.safeParse(r?.post_spec);
    if (!spec.success || !r.scheduled_at) continue;
    out.push(auditPostFromSpec(spec.data, {
      id: String(r.id), channel: q.channelKey, publishedAt: new Date(r.scheduled_at).toISOString(), timezone: q.timezone,
      card: q.card, ...(r.topic_mode !== 'live' && typeof r.topic === 'string' && r.topic.trim() ? { topic: r.topic } : {}),
    }));
  }
  return out;
}

export async function recentAuditPosts(pool: Pick<Pool, 'query'>, q: RecentPostsQuery): Promise<AuditPost[]> {
  const { rows } = await pool.query(
    `SELECT id::text AS id, scheduled_at, format, topic, topic_mode, post_spec
       FROM editor_slots
      WHERE channel_key = $1 AND kind = 'content' AND post_spec IS NOT NULL
        AND (resource_ref IS NULL OR resource_ref = 'telegram:' || channel_key)
        AND status IN ('published','shadowed','awaiting_approval','approved')
        AND ($2::uuid IS NULL OR id <> $2)
      ORDER BY scheduled_at DESC LIMIT $3`,
    [q.channelKey, q.excludeSlotId ?? null, q.limit ?? MONOTONY_WINDOW]);
  return recentPostsFromRows(rows ?? [], q);
}
