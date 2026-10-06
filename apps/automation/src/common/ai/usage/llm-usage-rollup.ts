import type { Pool } from 'pg';

const KYIV_TODAY = `(now() AT TIME ZONE 'Europe/Kyiv')::date`;

/** The aggregate written to llm_usage_daily (also the "raw aggregate" the rollup must equal). */
export const DAILY_SELECT = `
  SELECT (at AT TIME ZONE 'Europe/Kyiv')::date AS day, provider, model, feature, root_agent_id, role, resource_ref,
         COUNT(*)::int AS calls, (COUNT(*) FILTER (WHERE status <> 'ok'))::int AS errors,
         COALESCE(SUM(tokens_in), 0) AS tokens_in, COALESCE(SUM(tokens_out), 0) AS tokens_out,
         COALESCE(SUM(tokens_cached_read), 0) AS tokens_cached,
         COALESCE(SUM(cost_usd), 0) AS cost_usd,
         COALESCE(SUM(cost_usd) FILTER (WHERE cost_source = 'estimate'), 0) AS estimated_usd,
         (COUNT(*) FILTER (WHERE cost_source = 'unpriced'))::int AS unpriced_calls,
         COALESCE(SUM(cost_usd) FILTER (WHERE shadow), 0) AS shadow_usd
    FROM llm_usage`;
const GROUP_BY = `GROUP BY 1, 2, 3, 4, 5, 6, 7`;

/**
 * Daily rollup and raw retention of the LLM ledger (spec 029 FR-007).
 * `rollup()` recomputes today and yesterday (Kyiv days, so late rows land on
 * the right day) with delete-and-insert in one transaction; `prune()` deletes
 * raw rows older than the retention in batches. The rollup is kept forever.
 */
export class LlmUsageRollup {
  constructor(
    private readonly pool: Pick<Pool, 'connect' | 'query'>,
    private readonly opts: { retentionDays?: number; batchSize?: number; log?: (m: string) => void } = {},
  ) {}

  /** Recompute the rollup for the last `days` Kyiv days including today (default: today and yesterday). */
  async rollup(days = 2): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM llm_usage_daily WHERE day > ${KYIV_TODAY} - $1::int`, [days]);
      const { rowCount } = await client.query(
        `INSERT INTO llm_usage_daily (day, provider, model, feature, root_agent_id, role, resource_ref, calls, errors,
                                      tokens_in, tokens_out, tokens_cached, cost_usd, estimated_usd, unpriced_calls, shadow_usd)
         ${DAILY_SELECT}
          WHERE at >= ((${KYIV_TODAY} - ($1::int - 1))::timestamp AT TIME ZONE 'Europe/Kyiv')
         ${GROUP_BY}`, [days]);
      await client.query('COMMIT');
      return rowCount ?? 0;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Delete raw rows older than the retention (default 90 days), `batchSize` rows per statement. */
  async prune(): Promise<number> {
    const days = this.opts.retentionDays ?? 90;
    const batch = this.opts.batchSize ?? 10_000;
    let total = 0;
    for (;;) {
      const { rowCount } = await this.pool.query(
        `DELETE FROM llm_usage WHERE id IN (
           SELECT id FROM llm_usage WHERE at < now() - make_interval(days => $1::int) ORDER BY id LIMIT $2)`, [days, batch]);
      total += rowCount ?? 0;
      if ((rowCount ?? 0) < batch) return total;
    }
  }
}

export { GROUP_BY as DAILY_GROUP_BY };
