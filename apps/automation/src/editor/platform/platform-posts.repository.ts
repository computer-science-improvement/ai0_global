import type { Pool } from 'pg';

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
  status:      'published' | 'shadowed' | 'failed';
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
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async insert(p: {
    resourceRef: string; platform: string; externalId?: string | null; url?: string | null; slotId?: string | null; ideaId?: string | null;
    format: string; caption: string; spec: unknown; sourceRef?: string | null; status: PlatformPostRow['status']; error?: string | null; agentId?: string | null;
  }): Promise<PlatformPostRow> {
    const { rows } = await this.pool.query(
      `INSERT INTO platform_posts (resource_ref, platform, external_id, url, slot_id, idea_id, format, caption, spec, source_ref, status, error, agent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [p.resourceRef, p.platform, p.externalId ?? null, p.url ?? null, p.slotId ?? null, p.ideaId ?? null, p.format, p.caption,
        JSON.stringify(p.spec), p.sourceRef ?? null, p.status, p.error ?? null, p.agentId ?? null]);
    return toRow(rows[0]);
  }

  async get(id: number): Promise<PlatformPostRow | null> {
    const { rows } = await this.pool.query(`SELECT * FROM platform_posts WHERE id = $1`, [id]);
    return rows[0] ? toRow(rows[0]) : null;
  }

  /** Same source / library item / idea on this resource within `days` (live posts only). */
  async alreadyPosted(resourceRef: string, ref: { source?: string | null; ideaId?: string | null }, since: Date): Promise<boolean> {
    if (!ref.source && !ref.ideaId) return false;
    const { rows } = await this.pool.query(
      `SELECT 1 FROM platform_posts WHERE resource_ref = $1 AND status = 'published' AND posted_at >= $2
          AND (($3::text IS NOT NULL AND source_ref = $3) OR ($4::uuid IS NOT NULL AND idea_id = $4)) LIMIT 1`,
      [resourceRef, since, ref.source ?? null, ref.ideaId ?? null]);
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

  async recentCaptions(resourceRef: string, limit = 40): Promise<string[]> {
    const { rows } = await this.pool.query(
      `SELECT caption FROM platform_posts WHERE resource_ref = $1 AND status IN ('published','shadowed') AND caption IS NOT NULL
        ORDER BY posted_at DESC LIMIT $2`, [resourceRef, limit]);
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
