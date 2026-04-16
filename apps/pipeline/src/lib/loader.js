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
 */
import { pool } from './db.js';

const BATCH_SIZE = 500;

/**
 * @param {string}   table           - Table name
 * @param {object[]} rows            - Array of row objects; keys must match columns
 * @param {object}   options
 * @param {string[]} options.columns         - Column names in insertion order
 * @param {string}   options.conflictTarget  - ON CONFLICT target, e.g. '(id)' or '(data_source, title)'
 * @returns {Promise<{ inserted: number, skipped: number }>}
 */
export async function loadRows(table, rows, { columns, conflictTarget }) {
  if (!rows.length) return { inserted: 0, skipped: 0 };

  const client = await pool.connect();
  let inserted = 0;

  try {
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const values = [];
      const placeholders = batch.map((row, idx) => {
        const base = idx * columns.length;
        columns.forEach((col) => values.push(row[col] ?? null));
        return '(' + columns.map((_, ci) => `$${base + ci + 1}`).join(', ') + ')';
      });

      const colList = columns.map((c) => `"${c}"`).join(', ');
      const sql = `
        INSERT INTO ${table} (${colList})
        VALUES ${placeholders.join(', ')}
        ON CONFLICT ${conflictTarget} DO NOTHING
      `;

      const result = await client.query(sql, values);
      inserted += result.rowCount ?? 0;
    }
  } finally {
    client.release();
  }

  return { inserted, skipped: rows.length - inserted };
}
