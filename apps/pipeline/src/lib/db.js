import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  database: process.env.POSTGRES_DB || 'ai0global',
  user: process.env.POSTGRES_USER || 'ai0',
  password: process.env.POSTGRES_PASSWORD || 'changeme',
});

/**
 * Insert or upsert rows into a table.
 * Insert rows with optional ON CONFLICT handling.
 *
 * @param {string} table - Table name
 * @param {object[]} rows - Array of row objects (keys must match column names)
 * @param {object} options - { upsert, onConflict }
 */
export async function loadToTable(table, rows, options = {}) {
  if (!rows.length) return;

  const { upsert = false, onConflict = 'id' } = options;

  const columns = Object.keys(rows[0]);
  const placeholders = rows.map(
    (_, rowIdx) =>
      '(' + columns.map((_, colIdx) => `$${rowIdx * columns.length + colIdx + 1}`).join(', ') + ')'
  );
  const values = rows.flatMap((row) => columns.map((col) => row[col] ?? null));

  const colList = columns.map((c) => `"${c}"`).join(', ');
  const conflictClause = upsert
    ? `ON CONFLICT (${onConflict}) DO UPDATE SET ${columns
        .filter((c) => c !== onConflict)
        .map((c) => `"${c}" = EXCLUDED."${c}"`)
        .join(', ')}`
    : 'ON CONFLICT DO NOTHING';

  const sql = `INSERT INTO ${table} (${colList}) VALUES ${placeholders.join(', ')} ${conflictClause}`;

  const client = await pool.connect();
  try {
    await client.query(sql, values);
  } finally {
    client.release();
  }
}

export { pool };
