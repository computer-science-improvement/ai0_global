/**
 * Loading content into the unified data store (spec 032).
 *
 *   import { loadData, schemaFor } from '../lib/loader.js';
 *
 *   const r = await loadData(schemaFor('faktypro'), rows);              // insert new, skip existing
 *   const r = await loadData('recipes', rows, { updateFields: [...] }); // refresh those fields of existing rows
 *
 * `loadData` is a thin wrapper around the SQL write path `data_items_upsert()` (migration 058): the
 * database validates rows against the dataset schema, builds the dedup key, inserts or merges, and reports
 * {inserted, updated, skipped, invalid}. Every call is recorded in `data_imports` (source 'pipeline'), so
 * a pipeline load can be audited and undone like a dashboard import.
 *
 * Rows are plain JSON: arrays for list fields, objects for JSON fields, numbers for numeric fields. They
 * never carry `posted` (publication state belongs to the strategies).
 *
 * `loadRows` (raw INSERT … ON CONFLICT into a table) is kept only for non-content tables; content tables
 * are compatibility views since 058 and do not accept a targeted ON CONFLICT.
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pool as defaultPool } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BATCH_SIZE = 500;

let loadConfig = null;

/** Dataset (schema key) a pipeline source loads into, from config/load-config.json. */
export function schemaFor(source, config = null) {
  const cfg = config ?? (loadConfig ??= JSON.parse(readFileSync(join(__dirname, '..', 'config', 'load-config.json'), 'utf8')));
  const key = cfg.schemaMap?.[source];
  if (!key) throw new Error(`load-config.json: no dataset mapped for source "${source}"`);
  return key;
}

/** The SQL call for one batch (pure; exported for tests). */
export function buildUpsertCall(schemaKey, rows, importId = null, updateFields = null) {
  return {
    text: 'SELECT data_items_upsert($1, $2::jsonb, $3::uuid, $4::text[]) AS r',
    values: [schemaKey, JSON.stringify(rows), importId, updateFields],
  };
}

/**
 * @param {string}   schemaKey              dataset key, e.g. 'facts'
 * @param {object[]} rows                   plain JSON rows (field name → value)
 * @param {object}   [opts]
 * @param {string[]|null} [opts.updateFields]  merge these fields into existing rows; default [] = insert-or-skip
 * @param {string}   [opts.filename]        recorded in data_imports (e.g. the loader or input file)
 * @param {boolean}  [opts.audit=true]      record the load in data_imports
 * @param {object}   [opts.pool]            pg pool (tests)
 * @returns {Promise<{inserted:number, updated:number, skipped:number, invalid:number, errors:object[], importId:string|null}>}
 */
export async function loadData(schemaKey, rows, opts = {}) {
  const { updateFields = [], filename = null, audit = true, pool = defaultPool } = opts;
  const total = { inserted: 0, updated: 0, skipped: 0, invalid: 0, errors: [], importId: null };
  if (!rows.length) return total;

  const client = await pool.connect();
  try {
    if (audit) {
      const { rows: imp } = await client.query(
        `INSERT INTO data_imports (schema_id, schema_version, source, filename, rows_total, status, created_by, options)
         SELECT id, version, 'pipeline', $2, $3, 'running', 'pipeline', $4::jsonb FROM data_schemas WHERE key = $1
         RETURNING id`,
        [schemaKey, filename, rows.length, JSON.stringify({ updateFields })]);
      if (!imp.length) throw new Error(`unknown dataset "${schemaKey}" (is migration 058 applied?)`);
      total.importId = imp[0].id;
    }
    try {
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        const { rows: out } = await client.query(buildUpsertCall(schemaKey, batch, total.importId, updateFields));
        const r = out[0].r;
        total.inserted += r.inserted;
        total.updated += r.updated;
        total.skipped += r.skipped;
        total.invalid += r.invalid_rows;
        for (const e of r.invalid) if (total.errors.length < 100) total.errors.push({ ...e, row: e.row + i });
      }
    } catch (err) {
      if (total.importId) {
        await client.query(`UPDATE data_imports SET status = 'failed', finished_at = now(), errors = $2::jsonb WHERE id = $1`,
          [total.importId, JSON.stringify([{ row: null, field: null, error: String(err.message ?? err) }])]).catch(() => undefined);
      }
      throw err;
    }
    if (total.importId) {
      await client.query(
        `UPDATE data_imports SET status = 'committed', finished_at = now(), inserted = $2, updated = $3, skipped = $4,
                invalid = $5, errors = $6::jsonb WHERE id = $1`,
        [total.importId, total.inserted, total.updated, total.skipped, total.invalid, JSON.stringify(total.errors)]);
      await client.query(`SELECT data_schema_stats_refresh(schema_id) FROM data_imports WHERE id = $1`, [total.importId]);
    }
  } finally {
    client.release();
  }
  return total;
}

/** One-line summary for loader logs. */
export function formatLoad(r) {
  const base = `inserted: ${r.inserted}, updated: ${r.updated}, skipped: ${r.skipped}, invalid: ${r.invalid}`;
  return r.errors?.length ? `${base}\n  first errors: ${r.errors.slice(0, 5).map((e) => `row ${e.row} ${e.field ?? ''} ${e.error}`).join('; ')}` : base;
}

// ─── Legacy raw table loader (non-content tables only) ───────────────────────

/**
 * Build the multi-row INSERT for one batch. Identifiers come from the calling
 * loader's hard-coded column lists (never user input); values are placeholders.
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

/** @deprecated for content — use loadData(schemaKey, rows). Kept for non-content tables. */
export async function loadRows(table, rows, { columns, conflictTarget, updateColumns = [] }) {
  if (!rows.length) return { inserted: 0, skipped: 0 };

  const client = await defaultPool.connect();
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
