import type { Pool } from 'pg';
import type { Decision } from './launch-graduation';

/** Spec 052: the reads behind the checklist, graduation and growth (one place, tested against Postgres). */
export function launchQueries(pool: Pick<Pool, 'query'>) {
  const mine = `channel_key = $1 AND (resource_ref IS NULL OR resource_ref = 'telegram:' || $1)`;
  return {
    /** Posts of the channel published since a time. */
    async published(key: string, since: Date): Promise<number> {
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM editor_slots WHERE status = 'published' AND ${mine} AND scheduled_at >= $2`, [key, since]);
      return Number(rows[0]?.n ?? 0);
    },
    /** The owner's decisions since a time, oldest first (approved clean or edited, rejected). */
    async decisions(key: string, since: Date): Promise<Decision[]> {
      const { rows } = await pool.query(
        `SELECT CASE WHEN approved_at IS NOT NULL THEN CASE WHEN owner_edited THEN 'edited' ELSE 'clean' END ELSE 'rejected' END AS outcome
           FROM editor_slots
          WHERE ${mine} AND (approved_at IS NOT NULL OR (status = 'skipped' AND error = 'rejected by owner'))
            AND COALESCE(approved_at, updated_at) >= $2
          ORDER BY COALESCE(approved_at, updated_at), id`, [key, since]);
      return rows.map((r: any) => r.outcome);
    },
    /** Critic verdicts on the channel's posts since a time. */
    async critic(key: string, since: Date): Promise<{ pass: number; revise: number; reject: number }> {
      const { rows } = await pool.query(
        `SELECT critic->>'verdict' AS verdict, count(*)::int AS n FROM editor_slots
          WHERE ${mine} AND critic IS NOT NULL AND updated_at >= $2 GROUP BY 1`, [key, since]);
      const n = (v: string) => Number(rows.find((r: any) => r.verdict === v)?.n ?? 0);
      return { pass: n('pass'), revise: n('revise'), reject: n('reject') };
    },
    /** Joins through the promo links to a resource since a time. */
    async joins(targetRef: string, since: Date): Promise<number> {
      const { rows } = await pool.query(
        `SELECT COALESCE(sum(j.count), 0)::int AS n FROM link_joins j JOIN tracked_links t ON t.id = j.link_id
          WHERE t.target_ref = $1 AND j.joined_at >= $2`, [targetRef, since]);
      return Number(rows[0]?.n ?? 0);
    },
    /** Our other Telegram channels with cards (the promo candidates and the analysis's network). */
    async ownChannels(exceptKey: string, limit = 50): Promise<Array<{ key: string; title: string | null; subs: number | null; topic: string | null }>> {
      const { rows } = await pool.query(
        `SELECT ec.channel_key, COALESCE(ec.title, tc.title) AS title, tc.subs_count, rp.profile->>'topic' AS topic
           FROM editor_channels ec
           JOIN tracked_channels tc ON tc.channel_key = ec.channel_key AND tc.is_mine
           LEFT JOIN resource_profiles rp ON rp.resource_ref = 'telegram:' || ec.channel_key
          WHERE lower(ec.channel_key) <> lower($1)
          ORDER BY ec.channel_key LIMIT $2`, [exceptKey, limit]);
      return rows.map((r: any) => ({ key: r.channel_key, title: r.title ?? null, subs: r.subs_count == null ? null : Number(r.subs_count), topic: r.topic ?? null }));
    },
  };
}
