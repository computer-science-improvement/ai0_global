/**
 * Loader: data/normalized/prompts-github/prompts.json → the `prompts` dataset (data store, spec 032).
 * Idempotent — an existing id is skipped. No TRUNCATE (the table also
 * holds prompthero rows).  LOAD_LIMIT=N for test mode.
 */
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../lib/db.js';
import { loadData, schemaFor, formatLoad } from '../lib/loader.js';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const INPUT_FILE = join(__dirname, '..', 'data', 'normalized', 'prompts-github', 'prompts.json');

const limitArg = process.env.LOAD_LIMIT || process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1];
const LIMIT    = limitArg ? parseInt(limitArg, 10) : null;

function mapRow(p) {
  return {
    id:            p.id,
    provider:      p.provider,
    category:      p.category ?? null,
    title:         p.title ?? null,
    prompt_text:   p.prompt_text ?? null,
    source:        p.source ?? null,
    media_url:     p.media_url ?? null,
    media_type:    p.media_type ?? null,
    prompt_source: p.prompt_source ?? p.media_url,
    page_url:      p.page_url ?? null,
  };
}

async function main() {
  const data    = JSON.parse(await readFile(INPUT_FILE, 'utf-8'));
  const prompts = data.prompts ?? data;
  if (!Array.isArray(prompts)) { console.error('Expected "prompts" array'); process.exit(1); }

  let rows = prompts.filter((p) => p.id && p.prompt_text).map(mapRow);
  if (LIMIT) { console.log(`Test mode: first ${LIMIT}`); rows = rows.slice(0, LIMIT); }

  if (!rows.length) { console.log('No prompts to load'); await pool.end(); return; }

  console.log(`Loading ${rows.length} curated prompts`);
  const r = await loadData(schemaFor('prompts-github'), rows, { filename: 'prompts-github/prompts.json' });
  console.log(`Curated prompts — ${formatLoad(r)}`);
  await pool.end();
  console.log('Done.');
}

main().catch((err) => { console.error(err); process.exit(1); });
