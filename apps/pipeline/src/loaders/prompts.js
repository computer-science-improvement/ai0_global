/**
 * Loader: data/normalized/prompts/*.json (PromptHero scrape) → the `prompts` dataset (data store, spec 032)
 *
 * Dedup key: (id) — id = realImage CDN URL
 * LOAD_LIMIT=N — test mode, first N items per file
 *
 * A scraped item is { href, realImage, category, scrapedAt, pageUrl }: `href` is the prompt's own page
 * (prompthero.com/prompt/<id>-…), `pageUrl` is the gallery the scraper was on (prompthero.com/flux-prompts).
 * page_url is the prompt's own page and media_url its image; the gallery is never stored as page_url
 * (until 2026-10-18 it was, and the catalog counted thousands of rows nothing could be posted from).
 * An item without a single-prompt link or an image is skipped and counted.
 *
 * Existing rows get page_url / media_url / media_type refreshed from the file, so a re-run repairs rows
 * loaded by the old mapping (migration 083 repairs them from the stored fields as well).
 */
import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { pool } from '../lib/db.js';
import { loadData, schemaFor, formatLoad } from '../lib/loader.js';

const __dirname    = dirname(fileURLToPath(import.meta.url));
const DATASETS_DIR = join(__dirname, '..', 'data', 'normalized', 'prompts');

const limitArg = process.env.LOAD_LIMIT || process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1];
const LIMIT    = limitArg ? parseInt(limitArg, 10) : null;

/** Fields refreshed on rows that already exist. */
export const REFRESH_FIELDS = ['page_url', 'media_url', 'media_type'];

const SINGLE_PROMPT_RE = /^https?:\/\/(www\.)?prompthero\.com\/prompt\/[^/?#]+/i;

/** A link to one prompt's page, not a gallery, search or listing page. */
export function isSinglePromptUrl(url) {
  return typeof url === 'string' && SINGLE_PROMPT_RE.test(url.trim());
}

/** Why an item cannot become a row, or null when it can. */
export function rejectReason(item) {
  if (!item || typeof item !== 'object') return 'not an object';
  if (!isSinglePromptUrl(item.href)) return 'no single-prompt link (href)';
  if (typeof item.realImage !== 'string' || !/^https?:\/\//i.test(item.realImage.trim())) return 'no image (realImage)';
  return null;
}

export function mapRow(item) {
  return {
    id:            item.realImage.trim(),
    prompt_source: item.href.trim(),
    page_url:      item.href.trim(),
    media_url:     item.realImage.trim(),
    media_type:    'image',
    category:      item.category   ?? null,
    provider:      'prompthero',
    scraped_at:    item.scrapedAt  ?? null,
  };
}

/** Items of one file → rows plus the count of skipped items by reason. */
export function mapItems(items) {
  const rows = [];
  const skipped = {};
  for (const item of items) {
    const why = rejectReason(item);
    if (why) skipped[why] = (skipped[why] ?? 0) + 1;
    else rows.push(mapRow(item));
  }
  return { rows, skipped };
}

async function load() {
  const files = (await readdir(DATASETS_DIR)).filter((f) => f.endsWith('.json'));

  if (LIMIT) console.log(`Test mode: first ${LIMIT} items per file\n`);

  let totalInserted = 0;
  let totalUpdated  = 0;
  let totalSkipped  = 0;

  for (const file of files) {
    const raw = await readFile(join(DATASETS_DIR, file), 'utf-8');
    let data;
    try { data = JSON.parse(raw); } catch { console.warn(`Skip ${file}: invalid JSON`); continue; }
    if (!Array.isArray(data)) { console.warn(`Skip ${file}: not an array`); continue; }

    let { rows, skipped } = mapItems(data);
    const totalInFile = rows.length;
    for (const [why, n] of Object.entries(skipped)) console.warn(`  ${file}: ${n} items skipped — ${why}`);
    if (LIMIT) rows = rows.slice(0, LIMIT);
    if (!rows.length) { console.log(`Skip ${file}: no valid rows`); continue; }

    console.log(`Loading ${LIMIT ? rows.length + '/' + totalInFile : rows.length} rows from ${file} -> prompts`);
    const r = await loadData(schemaFor('prompthero'), rows, { filename: file, updateFields: REFRESH_FIELDS });
    totalInserted += r.inserted;
    totalUpdated  += r.updated;
    totalSkipped  += r.skipped;
    console.log(`  ${formatLoad(r)}`);
  }

  console.log(`\nDone. Total inserted: ${totalInserted}, updated: ${totalUpdated}, skipped: ${totalSkipped}`);
  await pool.end();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  load().catch((err) => { console.error(err); process.exit(1); });
}
