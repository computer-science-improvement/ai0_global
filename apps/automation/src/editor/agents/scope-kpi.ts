import type { Pool } from 'pg';
import type { Agent } from './agent.types';
import { parseResourceRef } from './agent.types';

/** One primary KPI of a scope: average views per post, 7-day window vs the 28 days before it. */
export interface KpiPoint {
  metric:      'views_per_post';
  value7d:     number | null;
  baseline28d: number | null;
  /** Std-dev of the daily averages in the baseline window (noise band). */
  std28d:      number | null;
  posts7d:     number;
  postsBase:   number;
  at:          string;
}

export interface ScopeKpi {
  primary(agent: Pick<Agent, 'scope' | 'scopeId'>, now?: Date): Promise<KpiPoint | null>;
}

/** The Telegram channel keys a scope publishes to (resource → itself; network → its group's channel; system → all own). */
export async function telegramKeysOfScope(pool: Pick<Pool, 'query'>, a: Pick<Agent, 'scope' | 'scopeId'>): Promise<string[]> {
  if (a.scope === 'resource') {
    const r = a.scopeId ? parseResourceRef(a.scopeId) : null;
    return r?.platform === 'telegram' ? [r.id] : [];
  }
  if (a.scope === 'network') {
    const { rows } = await pool.query(`SELECT channel_key FROM tracked_channels WHERE group_id = $1 AND channel_key IS NOT NULL`, [a.scopeId]);
    return rows.map((r) => r.channel_key);
  }
  const { rows } = await pool.query(`SELECT channel_key FROM tracked_channels WHERE is_mine AND channel_key IS NOT NULL`);
  return rows.map((r) => r.channel_key);
}

/**
 * Views per post from the latest stats snapshot of each Telegram post. Posts
 * younger than a day are excluded (their views are still growing), so the
 * "7d" window is days 1–8 ago and the baseline days 8–36 ago.
 */
export class TelegramScopeKpi implements ScopeKpi {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async primary(a: Pick<Agent, 'scope' | 'scopeId'>, now = new Date()): Promise<KpiPoint | null> {
    const keys = await telegramKeysOfScope(this.pool, a);
    if (!keys.length) return null;
    const { rows } = await this.pool.query(
      `WITH p AS (
         SELECT (posted_at AT TIME ZONE 'Europe/Kyiv')::date AS day, views,
                posted_at >= $2::timestamptz - interval '8 days' AS recent
           FROM editor_v_post_performance
          WHERE channel_id = ANY($1::text[]) AND views IS NOT NULL
            AND posted_at <  $2::timestamptz - interval '1 day'
            AND posted_at >= $2::timestamptz - interval '36 days'
       ), d AS (
         SELECT day, recent, AVG(views)::float8 AS avg_views, COUNT(*)::int AS n FROM p GROUP BY day, recent
       )
       SELECT
         (SELECT SUM(avg_views * n) / NULLIF(SUM(n), 0) FROM d WHERE recent)      AS value7d,
         (SELECT COALESCE(SUM(n), 0) FROM d WHERE recent)                          AS posts7d,
         (SELECT SUM(avg_views * n) / NULLIF(SUM(n), 0) FROM d WHERE NOT recent)  AS baseline,
         (SELECT stddev_samp(avg_views) FROM d WHERE NOT recent)                   AS std,
         (SELECT COALESCE(SUM(n), 0) FROM d WHERE NOT recent)                      AS posts_base`,
      [keys, now]);
    const r = rows[0] ?? {};
    const num = (v: unknown) => (v == null ? null : Number(v));
    return {
      metric: 'views_per_post', value7d: num(r.value7d), baseline28d: num(r.baseline), std28d: num(r.std),
      posts7d: Number(r.posts7d ?? 0), postsBase: Number(r.posts_base ?? 0), at: now.toISOString(),
    };
  }
}

export type KpiVerdict =
  | { verdict: 'kept'; deltaPct: number | null; z: number | null }
  | { verdict: 'rolled_back'; deltaPct: number; z: number }
  | { verdict: 'insufficient' };

export const ROLLBACK_DROP_PCT = -15;
export const ROLLBACK_Z = -1.5;
export const MIN_POSTS_FOR_VERDICT = 3;

/**
 * Did the KPI drop after a change (FR-009)? `before` is the snapshot taken at
 * the edit (its baseline is the pre-change level), `after` is the snapshot at
 * the review date (its 7-day value is the post-change level). A rollback needs
 * BOTH a ≥15% drop and a drop outside the noise band (z ≤ -1.5).
 */
export function judgeKpiChange(before: KpiPoint | null, after: KpiPoint | null): KpiVerdict {
  const base = before?.baseline28d ?? before?.value7d ?? null;
  if (!after || after.value7d == null || base == null || base <= 0 || after.posts7d < MIN_POSTS_FOR_VERDICT) return { verdict: 'insufficient' };
  const deltaPct = ((after.value7d - base) / base) * 100;
  const std = before?.std28d && before.std28d > 0 ? before.std28d : null;
  const z = std ? (after.value7d - base) / std : null;
  if (deltaPct <= ROLLBACK_DROP_PCT && z != null && z <= ROLLBACK_Z) return { verdict: 'rolled_back', deltaPct, z };
  return { verdict: 'kept', deltaPct, z };
}
