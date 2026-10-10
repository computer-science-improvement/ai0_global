import type { Pool } from 'pg';
import { parseDataRef } from '../../data/data-refs';
import { retellSource } from '../post/verbatim-guard';

const CAP = 4_000;

/**
 * Spec 034 FR-004: the source excerpt behind a `library_ref` for the critic's
 * grounding check — the retold fields of a library row (recipes, facts,
 * articles…), else the row as JSON. Never throws; null when not found.
 */
export function libraryTextOf(pool: Pick<Pool, 'query'>): (ref: string) => Promise<string | null> {
  return async (ref) => {
    try {
      const lib = ref.match(/^library:\/\/([a-z_]+)\/(.+)$/);
      const data = parseDataRef(ref);
      const key = lib?.[1] ?? data?.schemaKey;
      if (!key) return null;
      const { rows } = await pool.query(
        `SELECT d.data FROM data_items d JOIN data_schemas s ON s.id = d.schema_id
          WHERE s.key = $1 AND (d.legacy_ref = $2 OR ($3::bigint IS NOT NULL AND d.id = $3::bigint)) LIMIT 1`,
        [key, lib ? ref : null, data?.id ?? null]);
      const row = rows[0]?.data as Record<string, unknown> | undefined;
      if (!row) return null;
      const text = retellSource(key, row) || JSON.stringify(row);
      return text.slice(0, CAP);
    } catch {
      return null;
    }
  };
}
