/**
 * Loader: additional-data/datasets/*.json → prompts table
 *
 * Dedup key: (id) — id = realImage CDN URL
 * LOAD_LIMIT=N — test mode, first N items per file
 */
import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../lib/db.js';
import { loadRows } from '../lib/loader.js';

const __dirname    = dirname(fileURLToPath(import.meta.url));
const DATASETS_DIR = join(__dirname, '..', 'data', 'normalized', 'prompts');

const limitArg = process.env.LOAD_LIMIT || process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1];
const LIMIT    = limitArg ? parseInt(limitArg, 10) : null;

const COLUMNS         = ['id', 'prompt_source', 'category', 'posted', 'scraped_at', 'page_url'];
const CONFLICT_TARGET = '(id)';

function mapRow(item) {
  return {
    id:            item.realImage,
    prompt_source: item.href,
    category:      item.category   ?? null,
    posted:        '{}',
    scraped_at:    item.scrapedAt  ?? null,
    page_url:      item.pageUrl    ?? null,
  };
}

async function load() {
  const files = (await readdir(DATASETS_DIR)).filter((f) => f.endsWith('.json'));

  if (LIMIT) console.log(`Test mode: first ${LIMIT} items per file\n`);

  let totalInserted = 0;
  let totalSkipped  = 0;

  for (const file of files) {
    const raw = await readFile(join(DATASETS_DIR, file), 'utf-8');
    let data;
    try { data = JSON.parse(raw); } catch { console.warn(`Skip ${file}: invalid JSON`); continue; }
    if (!Array.isArray(data)) { console.warn(`Skip ${file}: not an array`); continue; }

    let rows = data.filter((item) => item.realImage && item.href).map(mapRow);
    const totalInFile = rows.length;
    if (LIMIT) rows = rows.slice(0, LIMIT);
    if (!rows.length) { console.log(`Skip ${file}: no valid rows`); continue; }

    console.log(`Loading ${LIMIT ? rows.length + '/' + totalInFile : rows.length} rows from ${file} -> prompts`);
    const { inserted, skipped } = await loadRows('prompts', rows, { columns: COLUMNS, conflictTarget: CONFLICT_TARGET });
    totalInserted += inserted;
    totalSkipped  += skipped;
    console.log(`  inserted: ${inserted}, skipped (duplicates): ${skipped}`);
  }

  console.log(`\nDone. Total inserted: ${totalInserted}, skipped: ${totalSkipped}`);
  await pool.end();
}

load().catch((err) => { console.error(err); process.exit(1); });
