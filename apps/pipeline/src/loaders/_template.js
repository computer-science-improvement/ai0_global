/**
 * TEMPLATE: a new loader (spec 032 — content goes into the data store, never into a new table).
 * Copy this file and replace the values marked ← CHANGE.
 *
 * Checklist:
 *   1. SOURCE        — the source name; map it to a dataset in config/load-config.json ("schemaMap")
 *   2. The dataset   — if it is new, create its schema in the dashboard (/app/data) or with
 *                      POST /api/data/schemas: fields with plain-English descriptions, roles, dedup key.
 *                      No migration is needed.
 *   3. SOURCE_DIR    — where the JSON files are
 *   4. mapRow()      — one JSON record → one row keyed by the dataset's field names (plain JSON values:
 *                      arrays for lists, objects for JSON fields; never `posted`)
 *   5. Add a script to package.json: "load:<name>": "node --env-file=../../.env src/loaders/<name>.js"
 *
 * For a one-off file you can skip the loader entirely: import a CSV/JSON/JSONL in the dashboard or
 * POST it to /api/data/:schema/rows.
 */
import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../lib/db.js';
import { loadData, schemaFor, formatLoad } from '../lib/loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ← CHANGE: folder with the JSON files
const SOURCE_DIR = join(__dirname, '..', 'data');

// ← CHANGE: source name (a key of schemaMap in config/load-config.json)
const SOURCE = 'my-source';

const limitArg = process.env.LOAD_LIMIT || process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1];
const LIMIT    = limitArg ? parseInt(limitArg, 10) : null;

// ← CHANGE: one JSON record → one dataset row
function mapRow(item) {
  return {
    title:    item.title ?? '',
    category: item.category ?? null,
  };
}

async function load() {
  const dataset = schemaFor(SOURCE);
  const files = (await readdir(SOURCE_DIR)).filter((f) => f.endsWith('.json'));

  if (LIMIT) console.log(`Test mode: first ${LIMIT} items per file\n`);

  for (const file of files) {
    const raw = await readFile(join(SOURCE_DIR, file), 'utf-8');
    let data;
    try { data = JSON.parse(raw); } catch { console.warn(`Skip ${file}: invalid JSON`); continue; }

    // ← CHANGE if the file has another shape (data.items, data.results, …)
    let rows = Array.isArray(data) ? data : (data.items ?? []);
    if (!rows.length) { console.log(`Skip ${file}: no rows`); continue; }

    const totalInFile = rows.length;
    if (LIMIT) rows = rows.slice(0, LIMIT);

    rows = rows.map(mapRow);

    console.log(`Loading ${LIMIT ? rows.length + '/' + totalInFile : rows.length} rows from ${file} -> ${dataset}`);
    const r = await loadData(dataset, rows, { filename: file });
    console.log(`  ${formatLoad(r)}`);
  }

  await pool.end();
}

load().catch((err) => { console.error(err); process.exit(1); });
