import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../../database/database.tokens';
import { AdRef } from '../types';

export interface TrackedPost {
  id:              string;
  channelId:       string;
  tgMessageId:     string;
  text:            string | null;
  hasMedia:        boolean;
  mediaType:       string | null;
  postedAt:        Date;
  views:           number | null;
  forwards:        number | null;
  reactionsTotal:  number | null;
  reactions:       Record<string, number> | null;
  commentsCount:   number | null;
  adRefs:          AdRef[] | null;
  lastMetricsAt:   Date | null;
}

export interface UpsertPostInput {
  channelId:      string;
  tgMessageId:    string | number;
  text?:          string | null;
  hasMedia?:      boolean;
  mediaType?:     string | null;
  postedAt:       Date;
  views?:         number | null;
  forwards?:      number | null;
  reactionsTotal?: number | null;
  reactions?:     Record<string, number> | null;
  commentsCount?: number | null;
  adRefs?:        AdRef[] | null;
}

@Injectable()
export class TrackedPostsRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async upsert(input: UpsertPostInput): Promise<string> {
    const r = await this.pool.query<{ id: string }>(
      `INSERT INTO tracked_posts
         (channel_id, tg_message_id, text, has_media, media_type, posted_at,
          views, forwards, reactions_total, reactions, comments_count, ad_refs, last_metrics_at)
       VALUES ($1, $2, $3, COALESCE($4,false), $5, $6,
               $7, $8, $9, $10::jsonb, $11, $12::jsonb, now())
       ON CONFLICT (channel_id, tg_message_id)
       DO UPDATE SET
         text            = COALESCE(EXCLUDED.text,            tracked_posts.text),
         has_media       = COALESCE(EXCLUDED.has_media,       tracked_posts.has_media),
         media_type      = COALESCE(EXCLUDED.media_type,      tracked_posts.media_type),
         views           = COALESCE(EXCLUDED.views,           tracked_posts.views),
         forwards        = COALESCE(EXCLUDED.forwards,        tracked_posts.forwards),
         reactions_total = COALESCE(EXCLUDED.reactions_total, tracked_posts.reactions_total),
         reactions       = COALESCE(EXCLUDED.reactions,       tracked_posts.reactions),
         comments_count  = COALESCE(EXCLUDED.comments_count,  tracked_posts.comments_count),
         ad_refs         = COALESCE(EXCLUDED.ad_refs,         tracked_posts.ad_refs),
         last_metrics_at = now()
       RETURNING id`,
      [
        input.channelId,
        String(input.tgMessageId),
        input.text ?? null,
        input.hasMedia ?? null,
        input.mediaType ?? null,
        input.postedAt,
        input.views ?? null,
        input.forwards ?? null,
        input.reactionsTotal ?? null,
        input.reactions ? JSON.stringify(input.reactions) : null,
        input.commentsCount ?? null,
        input.adRefs && input.adRefs.length > 0 ? JSON.stringify(input.adRefs) : null,
      ],
    );
    return r.rows[0].id;
  }

  async getMaxMessageId(channelId: string): Promise<number> {
    const r = await this.pool.query<{ max: string | null }>(
      `SELECT MAX(tg_message_id)::text AS max FROM tracked_posts WHERE channel_id = $1`,
      [channelId],
    );
    return r.rows[0].max ? parseInt(r.rows[0].max, 10) : 0;
  }

  async countLast7Days(channelId: string): Promise<number> {
    const r = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM tracked_posts
       WHERE channel_id = $1 AND posted_at > now() - INTERVAL '7 days'`,
      [channelId],
    );
    return parseInt(r.rows[0].count, 10);
  }

  async listByChannel(
    channelId: string, from: Date | null, to: Date | null, limit: number, offset: number,
  ): Promise<{ items: TrackedPost[]; total: number }> {
    const args: unknown[] = [channelId];
    let where = `channel_id = $1`;
    if (from) { args.push(from); where += ` AND posted_at >= $${args.length}`; }
    if (to)   { args.push(to);   where += ` AND posted_at <= $${args.length}`; }

    const totalR = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM tracked_posts WHERE ${where}`, args,
    );
    args.push(limit);  const lim = `$${args.length}`;
    args.push(offset); const off = `$${args.length}`;
    const itemsR = await this.pool.query<any>(
      `SELECT * FROM tracked_posts WHERE ${where} ORDER BY posted_at DESC LIMIT ${lim} OFFSET ${off}`,
      args,
    );
    return {
      items: itemsR.rows.map((r) => this.toEntity(r)),
      total: parseInt(totalR.rows[0].count, 10),
    };
  }

  async topByMetric(channelId: string, metric: 'views' | 'reactions_total' | 'forwards', limit: number) {
    const allowed = ['views', 'reactions_total', 'forwards'];
    if (!allowed.includes(metric)) throw new Error(`Disallowed metric: ${metric}`);
    const r = await this.pool.query<any>(
      `SELECT * FROM tracked_posts WHERE channel_id = $1
       ORDER BY ${metric} DESC NULLS LAST LIMIT $2`,
      [channelId, limit],
    );
    return r.rows.map((row) => this.toEntity(row));
  }

  /** For ROI: mean views over last 30 days, with engagement aggregate. */
  async statsLast30Days(channelId: string): Promise<{ avgViews: number; engagementRate: number; postsCount: number }> {
    const r = await this.pool.query<any>(
      `SELECT
         AVG(views)::float AS avg_views,
         SUM(COALESCE(reactions_total,0) + COALESCE(forwards,0) + COALESCE(comments_count,0))::float AS sum_engage,
         SUM(views)::float AS sum_views,
         COUNT(*)::int AS posts
       FROM tracked_posts
       WHERE channel_id = $1 AND posted_at > now() - INTERVAL '30 days'`,
      [channelId],
    );
    const row = r.rows[0];
    const avgViews = row.avg_views ?? 0;
    const rate     = row.sum_views > 0 ? row.sum_engage / row.sum_views : 0;
    return { avgViews, engagementRate: rate, postsCount: row.posts ?? 0 };
  }

  async listByAdRefTarget(channelId: string, target: string): Promise<TrackedPost[]> {
    // ad_refs stores different shapes by kind:
    //   tg_channel / tg_user → { kind, username }
    //   web                  → { kind: 'web',       domain }
    //   instagram            → { kind: 'instagram', handle }
    //
    // The GraphCanvas passes whatever value lives in tracked_ad_edges.
    // target_username for the clicked edge — which is the username for
    // tg_*, the domain for web, the handle for instagram. So we need an
    // ORed match across all three keys to find the originating posts.
    //
    // jsonb_array_elements + EXISTS is faster than three @> probes on a
    // wide ad_refs array. The CASE-INSENSITIVE compare matches the
    // .toLowerCase() the service does before calling us.
    const r = await this.pool.query<any>(
      `SELECT * FROM tracked_posts
       WHERE channel_id = $1
         AND ad_refs IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(ad_refs) AS r
           WHERE LOWER(r->>'username') = $2
              OR LOWER(r->>'domain')   = $2
              OR LOWER(r->>'handle')   = $2
         )
       ORDER BY posted_at DESC
       LIMIT 100`,
      [channelId, target.toLowerCase()],
    );
    return r.rows.map((row: any) => this.toEntity(row));
  }

  private toEntity(r: any): TrackedPost {
    return {
      id:             r.id,
      channelId:      r.channel_id,
      tgMessageId:    String(r.tg_message_id),
      text:           r.text,
      hasMedia:       r.has_media,
      mediaType:      r.media_type,
      postedAt:       r.posted_at,
      views:          r.views,
      forwards:       r.forwards,
      reactionsTotal: r.reactions_total,
      reactions:      r.reactions,
      commentsCount:  r.comments_count,
      adRefs:         r.ad_refs,
      lastMetricsAt:  r.last_metrics_at,
    };
  }
}
