/**
 * Loader: data/*.json → the `assets` dataset (data store, spec 032)
 *
 * Dedup key: (data_source, title)
 * LOAD_LIMIT=N — test mode, first N items per file
 */
import { readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../lib/db.js';
import { loadData, schemaFor, formatLoad } from '../lib/loader.js';
import { cleanTitleOrDescription } from '../lib/text.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = join(__dirname, '..', 'data', 'raw', 'assets');

const limitArg = process.env.LOAD_LIMIT || process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1];
const LIMIT    = limitArg ? parseInt(limitArg, 10) : null;

/** Known sources are mapped in load-config.json; any other asset file goes to the `assets` dataset. */
function datasetFor(dataSource) {
  try { return schemaFor(dataSource); } catch { return schemaFor('assets'); }
}

function mapItem(item, dataSource) {
  return {
    data_source: dataSource,
    title:       cleanTitleOrDescription(item.title ?? item.name ?? ''),
    description: cleanTitleOrDescription(item.description ?? ''),
    link:        item.link      ?? null,
    source_url:  item.source    ?? null,
    category:    item.category  ?? null,
    extra:       item.extra ?? null,
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
    const r = await loadData(datasetFor(dataSource), rows, { filename: file });
    totalInserted += r.inserted;
    totalSkipped  += r.skipped;
    console.log(`  ${formatLoad(r)}`);
  }

  console.log(`\nDone. Total inserted: ${totalInserted}, skipped: ${totalSkipped}`);
  await pool.end();
}

load().catch((err) => { console.error(err); process.exit(1); });
