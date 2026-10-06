import type { Pool } from 'pg';
import { ContentLedger, specRefs } from '../../data/content-ledger';

export interface PlatformPostRow {
  id:          number;
  resourceRef: string;
  platform:    string;
  externalId:  string | null;
  url:         string | null;
  slotId:      string | null;
  ideaId:      string | null;
  format:      string;
  caption:     string | null;
  status:      'published' | 'shadowed' | 'failed' | 'awaiting_approval' | 'canceled';
  error:       string | null;
  postedAt:    Date;
}

const toRow = (r: any): PlatformPostRow => ({
  id: Number(r.id), resourceRef: r.resource_ref, platform: r.platform, externalId: r.external_id ?? null, url: r.url ?? null,
  slotId: r.slot_id ?? null, ideaId: r.idea_id ?? null, format: r.format, caption: r.caption ?? null, status: r.status,
  error: r.error ?? null, postedAt: r.posted_at,
});

/** platform_posts / platform_post_metrics / resource_daily_stats (051). */
export class PlatformPostsRepository {
  private readonly ledger: ContentLedger;

  constructor(private readonly pool: Pick<Pool, 'query'>) {
    this.ledger = new ContentLedger(pool);
  }

  async insert(p: {
    resourceRef: string; platform: string; externalId?: string | null; url?: string | null; slotId?: string | null; ideaId?: string | null;
    format: string; caption: string; spec: unknown; sourceRef?: string | null; status: PlatformPostRow['status']; error?: string | null; agentId?: string | null;
  }): Promise<PlatformPostRow> {
    const { rows } = await this.pool.query(
      `INSERT INTO platform_posts (resource_ref, platform, external_id, url, slot_id, idea_id, format, caption, spec, source_ref, status, error, agent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [p.resourceRef, p.platform, p.externalId ?? null, p.url ?? null, p.slotId ?? null, p.ideaId ?? null, p.format, p.caption,
        JSON.stringify(p.spec), p.sourceRef ?? null, p.status, p.error ?? null, p.agentId ?? null]);
    const row = toRow(rows[0]);
    if (p.status === 'published' || p.status === 'shadowed') {
      // Spec 023 FR-010: every source ref of the post goes into the content ledger.
      await this.ledger.recordRefs([p.sourceRef, ...specRefs(p.spec as any)], {
        resourceRef: p.resourceRef, origin: 'platform', status: p.status, platformPostId: row.id, slotId: p.slotId ?? null,
      });
    }
    return row;
  }

  /**
   * Spec 031: settle a waiting (awaiting_approval) row — published with its
   * external id, failed, or canceled (rejected, expired, dropped). A row that
   * is no longer waiting is left alone.
   */
  async settle(id: number, status: 'published' | 'failed' | 'canceled', p: { externalId?: string | null; url?: string | null; error?: string | null } = {}): Promise<boolean> {
    const { rows, rowCount } = await this.pool.query(
      `UPDATE platform_posts SET status = $2, external_id = COALESCE($3, external_id), url = COALESCE($4, url), error = $5,
              posted_at = CASE WHEN $2 = 'published' THEN now() ELSE posted_at END
        WHERE id = $1 AND status = 'awaiting_approval'
        RETURNING resource_ref, source_ref, spec, slot_id`,
      [id, status, p.externalId ?? null, p.url ?? null, p.error ?? null]);
    if (status === 'published' && rows?.[0]) {
      const r = rows[0];
      await this.ledger.recordRefs([r.source_ref, ...specRefs(r.spec)], {
        resourceRef: r.resource_ref, origin: 'platform', status: 'published', platformPostId: id, slotId: r.slot_id ?? null,
      });
    }
    return (rowCount ?? 0) > 0;
  }

  async get(id: number): Promise<PlatformPostRow | null> {
    const { rows } = await this.pool.query(`SELECT * FROM platform_posts WHERE id = $1`, [id]);
    return rows[0] ? toRow(rows[0]) : null;
  }

  /**
   * Dedup on this resource. The source / library item goes through the content ledger (spec 023 FR-010:
   * published for ever or within the dataset's reuse window, shadowed 7 days, error anywhere; with
   * `waiting`, also posts that wait for approval — spec 031). The same idea is a repeat when it went out
   * here since `since`.
   */
  async alreadyPosted(resourceRef: string, ref: { source?: string | null; ideaId?: string | null }, since: Date, waiting = false): Promise<boolean> {
    if (ref.source && await this.ledger.used(resourceRef, ref.source, { waiting })) return true;
    if (!ref.ideaId) return false;
    const { rows } = await this.pool.query(
      `SELECT 1 FROM platform_posts WHERE resource_ref = $1 AND (status = 'published' OR ($4 AND status = 'awaiting_approval')) AND posted_at >= $2
          AND idea_id = $3 LIMIT 1`,
      [resourceRef, since, ref.ideaId, waiting]);
    return rows.length > 0;
  }

  async countPublishedSince(resourceRef: string, since: Date): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM platform_posts WHERE resource_ref = $1 AND status = 'published' AND posted_at >= $2`, [resourceRef, since]);
    return Number(rows[0]?.n ?? 0);
  }

  async lastPostAt(resourceRef: string): Promise<Date | null> {
    const { rows } = await this.pool.query(
      `SELECT max(posted_at) AS at FROM platform_posts WHERE resource_ref = $1 AND status = 'published'`, [resourceRef]);
    return rows[0]?.at ?? null;
  }

  /** Recent captions for the similarity guard; with `waiting`, posts that wait for approval count too (spec 031). */
  async recentCaptions(resourceRef: string, limit = 40, waiting = false): Promise<string[]> {
    const { rows } = await this.pool.query(
      `SELECT caption FROM platform_posts WHERE resource_ref = $1 AND (status IN ('published','shadowed') OR ($3 AND status = 'awaiting_approval'))
          AND caption IS NOT NULL ORDER BY posted_at DESC LIMIT $2`, [resourceRef, limit, waiting]);
    return rows.map((r) => String(r.caption));
  }

  async recent(resourceRef: string | null, days: number, limit = 100): Promise<PlatformPostRow[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM platform_posts WHERE ($1::text IS NULL OR resource_ref = $1) AND posted_at >= now() - ($2 || ' days')::interval
        ORDER BY posted_at DESC LIMIT $3`, [resourceRef, String(days), limit]);
    return rows.map(toRow);
  }

  /** Published posts of the last `days` days that need fresh metrics. */
  async needingMetrics(days: number): Promise<PlatformPostRow[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM platform_posts WHERE status = 'published' AND external_id IS NOT NULL AND posted_at >= now() - ($1 || ' days')::interval
        ORDER BY posted_at DESC`, [String(days)]);
    return rows.map(toRow);
  }

  async addMetrics(postId: number, m: { views?: number | null; reach?: number | null; likes?: number | null; comments?: number | null; shares?: number | null; saves?: number | null; extra?: unknown }): Promise<void> {
    await this.pool.query(
      `INSERT INTO platform_post_metrics (post_id, views, reach, likes, comments, shares, saves, extra) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [postId, m.views ?? null, m.reach ?? null, m.likes ?? null, m.comments ?? null, m.shares ?? null, m.saves ?? null, m.extra == null ? null : JSON.stringify(m.extra)]);
  }

  /** Upsert today's follower count; the delta is computed against the previous stored day. */
  async upsertDaily(resourceRef: string, day: string, v: { followers?: number | null; reach?: number | null; views?: number | null; engagement?: number | null; extra?: unknown }): Promise<void> {
    await this.pool.query(
      `INSERT INTO resource_daily_stats (resource_ref, day, followers, followers_delta, reach, views, engagement, extra)
       VALUES ($1, $2::date, $3,
               $3 - (SELECT followers FROM resource_daily_stats WHERE resource_ref = $1 AND day < $2::date AND followers IS NOT NULL ORDER BY day DESC LIMIT 1),
               $4, $5, $6, $7)
       ON CONFLICT (resource_ref, day) DO UPDATE SET
         followers = COALESCE(EXCLUDED.followers, resource_daily_stats.followers),
         followers_delta = COALESCE(EXCLUDED.followers_delta, resource_daily_stats.followers_delta),
         reach = COALESCE(EXCLUDED.reach, resource_daily_stats.reach),
         views = COALESCE(EXCLUDED.views, resource_daily_stats.views),
         engagement = COALESCE(EXCLUDED.engagement, resource_daily_stats.engagement),
         extra = COALESCE(EXCLUDED.extra, resource_daily_stats.extra)`,
      [resourceRef, day, v.followers ?? null, v.reach ?? null, v.views ?? null, v.engagement ?? null, v.extra == null ? null : JSON.stringify(v.extra)]);
  }
}
