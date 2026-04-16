/**
 * Loader: data/*.json → assets table
 *
 * Dedup key: (data_source, title)
 * LOAD_LIMIT=N — test mode, first N items per file
 */
import { readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../lib/db.js';
import { loadRows } from '../lib/loader.js';
import { cleanTitleOrDescription } from '../lib/text.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = join(__dirname, '..', 'data', 'raw', 'assets');

const limitArg = process.env.LOAD_LIMIT || process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1];
const LIMIT    = limitArg ? parseInt(limitArg, 10) : null;

const COLUMNS          = ['data_source', 'title', 'description', 'link', 'source_url', 'category', 'extra'];
const CONFLICT_TARGET  = '(data_source, title)';

function mapItem(item, dataSource) {
  return {
    data_source: dataSource,
    title:       cleanTitleOrDescription(item.title ?? item.name ?? ''),
    description: cleanTitleOrDescription(item.description ?? ''),
    link:        item.link      ?? null,
    source_url:  item.source    ?? null,
    category:    item.category  ?? null,
    extra:       item.extra ? JSON.stringify(item.extra) : null,
  };
}

async function load() {
  const files = readdirSync(DATA_DIR).filter((f) => f.endsWith('.json'));

  if (LIMIT) console.log(`Test mode: first ${LIMIT} items per file\n`);

  let totalInserted = 0;
  let totalSkipped  = 0;

  for (const file of files) {
    const base = file.replace(/\.json$/, '');
    const data = JSON.parse(readFileSync(join(DATA_DIR, file), 'utf8'));
    let items  = Array.isArray(data) ? data : (data.items || [data]);

    if (!items.length) { console.log(`Skip ${file}: no rows`); continue; }

    const totalInFile = items.length;
    if (LIMIT) items = items.slice(0, LIMIT);

    const dataSource = data.source || base;
    const rows = items.map((item) => mapItem(item, dataSource));

    console.log(`Loading ${LIMIT ? rows.length + '/' + totalInFile : rows.length} rows from ${file} -> assets`);
    const { inserted, skipped } = await loadRows('assets', rows, { columns: COLUMNS, conflictTarget: CONFLICT_TARGET });
    totalInserted += inserted;
    totalSkipped  += skipped;
    console.log(`  inserted: ${inserted}, skipped (duplicates): ${skipped}`);
  }

  console.log(`\nDone. Total inserted: ${totalInserted}, skipped: ${totalSkipped}`);
  await pool.end();
}

load().catch((err) => { console.error(err); process.exit(1); });
