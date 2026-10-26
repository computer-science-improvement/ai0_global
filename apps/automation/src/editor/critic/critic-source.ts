import type { Pool } from 'pg';
import { parseDataRef } from '../../data/data-refs';
import { retellSource } from '../post/verbatim-guard';

/**
 * Spec 067 FR-001 (A6): the critic and lint read the whole row, up to this many characters. A longer row is clipped,
 * and the gate then reports the coverage as `read`, not `full`.
 */
export const LIBRARY_ROW_CAP = 12_000;

/** The fields a library table retells (verbatim-guard RETELL_SOURCES), listed first in `libraryRowText`. */
const RETOLD_FIRST: Record<string, string[]> = {
  recipes:  ['description', 'instructions_uk', 'instructions'],
  facts:    ['content'],
  articles: ['excerpt', 'content'],
  tg_posts: ['post'],
};

const fieldText = (v: unknown): string | null => {
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v == null) return null;
  try { return JSON.stringify(v); } catch { return null; }
};

/**
 * Spec 067 A6: the whole row as `field: value` lines, the retold fields first, then the rest (a recipe's ingredients and
 * times too: the executor read them through query_data, so a number from them is grounded). Nested values are compact
 * JSON. Capped at LIBRARY_ROW_CAP.
 */
export function libraryRowText(key: string, row: Record<string, unknown>): string {
  const first = RETOLD_FIRST[key] ?? [];
  const order = [...first.filter((f) => f in row), ...Object.keys(row).filter((f) => !first.includes(f))];
  const lines = order.flatMap((f) => {
    const v = fieldText(row[f]);
    return v ? [`${f}: ${v}`] : [];
  });
  return lines.join('\n').slice(0, LIBRARY_ROW_CAP);
}

/**
 * Spec 034 FR-004: the source behind a `library_ref` for the critic's grounding check. Spec 067: the whole row
 * (`libraryRowText`), else the retold fields as before. Never throws; null when not found.
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
      return libraryRowText(key, row) || retellSource(key, row).slice(0, LIBRARY_ROW_CAP) || null;
    } catch {
      return null;
    }
  };
}
