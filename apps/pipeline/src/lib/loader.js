/**
 * Generic batch loader — inserts rows into any table with deduplication.
 *
 * Usage:
 *   import { loadRows } from '../lib/loader.js';
 *
 *   const { inserted, skipped } = await loadRows('assets', rows, {
 *     columns:        ['data_source', 'title', 'description', 'link', 'source_url', 'category', 'extra'],
 *     conflictTarget: '(data_source, title)',   // unique index columns
 *   });
 *
 * Pass `updateColumns` to upsert instead: on conflict only those columns are
 * overwritten from the incoming row; every other column keeps its DB value.
 * `inserted` then counts inserted + updated rows.
 */
import { pool } from './db.js';

const BATCH_SIZE = 500;

/**
 * Build the multi-row INSERT for one batch. Identifiers come from the calling
 * loader's hard-coded column lists (never user input); values are placeholders.
 *
 * @param {string}   table
 * @param {string[]} columns
 * @param {string}   conflictTarget  e.g. '(slug)'
 * @param {number}   rowCount        rows in this batch
 * @param {string[]} [updateColumns] columns to overwrite on conflict (upsert)
 */
export function buildInsertSql(table, columns, conflictTarget, rowCount, updateColumns = []) {
  const placeholders = [];
  for (let idx = 0; idx < rowCount; idx++) {
    const base = idx * columns.length;
    placeholders.push('(' + columns.map((_, ci) => `$${base + ci + 1}`).join(', ') + ')');
  }
  const colList = columns.map((c) => `"${c}"`).join(', ');
  const onConflict = updateColumns.length
    ? `DO UPDATE SET ${updateColumns.map((c) => `"${c}" = EXCLUDED."${c}"`).join(', ')}`
    : 'DO NOTHING';
  return `
        INSERT INTO ${table} (${colList})
        VALUES ${placeholders.join(', ')}
        ON CONFLICT ${conflictTarget} ${onConflict}
      `;
}

/**
 * @param {string}   table           - Table name
 * @param {object[]} rows            - Array of row objects; keys must match columns
 * @param {object}   options
 * @param {string[]} options.columns         - Column names in insertion order
 * @param {string}   options.conflictTarget  - ON CONFLICT target, e.g. '(id)' or '(data_source, title)'
 * @param {string[]} [options.updateColumns] - Upsert: columns overwritten on conflict
 * @returns {Promise<{ inserted: number, skipped: number }>}
 */
export async function loadRows(table, rows, { columns, conflictTarget, updateColumns = [] }) {
  if (!rows.length) return { inserted: 0, skipped: 0 };

  const client = await pool.connect();
  let inserted = 0;

  try {
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const values = [];
      batch.forEach((row) => columns.forEach((col) => values.push(row[col] ?? null)));

      const sql = buildInsertSql(table, columns, conflictTarget, batch.length, updateColumns);
      const result = await client.query(sql, values);
      inserted += result.rowCount ?? 0;
    }
  } finally {
    client.release();
  }

  return { inserted, skipped: rows.length - inserted };
}
