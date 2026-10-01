import type { Pool } from 'pg';
import { classifySql, wrapWithLimit } from './readonly-sql';

export interface ReadonlyResult {
  columns:  string[];
  rows:     Record<string, unknown>[];
  rowCount: number;
}

const CELL_MAX = 500;

function clipCell(v: unknown): unknown {
  if (typeof v === 'string' && v.length > CELL_MAX) return `${v.slice(0, CELL_MAX)}…`;
  if (v instanceof Date) return v.toISOString();
  return v;
}

/**
 * Executes agent SQL with three independent guards: the static classifier,
 * a READ ONLY transaction, and `SET LOCAL ROLE editor_ro` (SELECT grants only
 * on content/stats/editor tables — never on token/session/settings tables).
 * Always rolls back.
 */
export class ReadonlyQueryService {
  constructor(private readonly pool: Pool, private readonly timeoutMs = 3_000) {}

  async run(query: string, limit = 50): Promise<ReadonlyResult | { error: string; details?: string }> {
    const verdict = classifySql(query);
    if (!verdict.ok) return { error: 'sql_rejected', details: verdict.reason };

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query('SET LOCAL ROLE editor_ro');
      await client.query(`SET LOCAL statement_timeout = ${Math.floor(this.timeoutMs)}`);
      const res = await client.query(wrapWithLimit(verdict.sql, limit));
      return {
        columns:  res.fields.map((f) => f.name),
        rows:     res.rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, clipCell(v)]))),
        rowCount: res.rowCount ?? res.rows.length,
      };
    } catch (err: any) {
      return { error: 'sql_failed', details: err?.message ?? String(err) };
    } finally {
      try { await client.query('ROLLBACK'); } catch { /* connection may be broken */ }
      client.release();
    }
  }
}
