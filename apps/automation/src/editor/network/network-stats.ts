type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

/** Spec 053 FR-005: how far back the orchestrator's stats block looks. */
export const STATS_SUMMARY_DAYS = 7;

export interface ResourceStatsRow { ref: string; posts: number; avgViews: number | null; bestFormat: string | null }
export interface TopPostRow { ref: string; format: string; excerpt: string; views: number | null; postRef: string | null }

/**
 * Spec 053 FR-005: the network's last 7 days as a few prompt lines — per resource and the 3 best posts. The
 * orchestrator used to open every run with get_network_posts / get_platform_stats calls, and every later step re-sent
 * their results.
 */
export function renderStatsSummary(rows: readonly ResourceStatsRow[], top: readonly TopPostRow[]): string | null {
  if (!rows.length) return null;
  const n = (v: number | null) => (v == null ? '—' : String(v));
  return [
    `## Статистика ${STATS_SUMMARY_DAYS} днів (код уже порахував; get_network_posts / get_platform_stats — лише щоб копнути глибше)`,
    ...rows.map((r) => `- ${r.ref}: ${r.posts} пост., сер. перегляди ${n(r.avgViews)}${r.bestFormat ? `, найкращий формат ${r.bestFormat}` : ''}`),
    ...(top.length ? ['Найкращі пости:', ...top.map((p) => {
      const id = p.postRef?.startsWith('tg:') ? `, published_post_id ${p.postRef.slice(3)}` : p.postRef?.startsWith('pp:') ? `, platform_post_id ${p.postRef.slice(3)}` : '';
      return `- ${p.ref} · ${p.format} · ${n(p.views)} перегл. · «${p.excerpt.split('\n')[0].slice(0, 80)}»${id}`;
    })] : []),
  ].join('\n');
}

/** The stats block of these resources (null when they have no posts in the window, or on a query error). */
export async function statsSummaryOf(pool: Queryable, refs: readonly string[]): Promise<string | null> {
  if (!refs.length) return null;
  try {
    const params = [[...refs], String(STATS_SUMMARY_DAYS)];
    const { rows } = await pool.query(
      `WITH p AS (SELECT resource_ref, format, views FROM network_posts
                   WHERE resource_ref = ANY($1::text[]) AND posted_at >= now() - ($2 || ' days')::interval),
            f AS (SELECT resource_ref, format, AVG(views) AS v, ROW_NUMBER() OVER (PARTITION BY resource_ref ORDER BY AVG(views) DESC NULLS LAST) AS k
                    FROM p GROUP BY resource_ref, format)
       SELECT p.resource_ref AS ref, COUNT(*)::int AS posts, ROUND(AVG(p.views))::int AS avg_views,
              (SELECT f.format FROM f WHERE f.resource_ref = p.resource_ref AND f.k = 1) AS best_format
         FROM p GROUP BY p.resource_ref ORDER BY p.resource_ref`, params);
    const { rows: top } = await pool.query(
      `SELECT resource_ref AS ref, format, COALESCE(excerpt, '') AS excerpt, views, post_ref FROM network_posts
        WHERE resource_ref = ANY($1::text[]) AND posted_at >= now() - ($2 || ' days')::interval AND views IS NOT NULL
        ORDER BY views DESC LIMIT 3`, params);
    return renderStatsSummary(
      rows.map((r) => ({ ref: r.ref, posts: Number(r.posts), avgViews: r.avg_views == null ? null : Number(r.avg_views), bestFormat: r.best_format ?? null })),
      top.map((r) => ({ ref: r.ref, format: r.format, excerpt: r.excerpt, views: r.views == null ? null : Number(r.views), postRef: r.post_ref ?? null })),
    );
  } catch {
    return null;
  }
}
