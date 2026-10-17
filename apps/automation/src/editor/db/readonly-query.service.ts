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
      const details = [err?.message ?? String(err), err?.hint].filter(Boolean).join(' — ');
      if (err?.code !== UNDEFINED_COLUMN) return { error: 'sql_failed', details };
      // Spec 046 FR-008: a guessed column gets the real columns of the tables the query names.
      try { await client.query('ROLLBACK'); } catch { /* rolled back below anyway */ }
      const columns = await this.columnsOf(client, tablesIn(verdict.sql)).catch(() => ({}));
      return { error: 'sql_failed', details, ...(Object.keys(columns).length ? { columns } : {}) };
    } finally {
      try { await client.query('ROLLBACK'); } catch { /* connection may be broken */ }
      client.release();
    }
  }

  /** Columns of the named tables / views the read-only role may select (never secret tables). */
  private async columnsOf(client: { query: Pool['query'] }, tables: string[]): Promise<Record<string, string[]>> {
    if (!tables.length) return {};
    const { rows } = await client.query(
      `SELECT table_name, array_agg(column_name::text ORDER BY ordinal_position) AS cols
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])
          AND has_table_privilege('editor_ro', quote_ident(table_name), 'SELECT')
        GROUP BY table_name`, [tables]);
    return Object.fromEntries(rows.map((r: { table_name: string; cols: string[] }) => [r.table_name, r.cols]));
  }
}

/** Postgres `undefined_column`. */
const UNDEFINED_COLUMN = '42703';

/** Table / view names after FROM or JOIN (lower-case, schema dropped), at most 6. */
export function tablesIn(sql: string): string[] {
  const out = new Set<string>();
  for (const m of sql.matchAll(/\b(?:from|join)\s+(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?/giu)) out.add(m[1].toLowerCase());
  return [...out].slice(0, 6);
}
