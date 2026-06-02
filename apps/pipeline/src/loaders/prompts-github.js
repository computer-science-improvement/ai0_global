/**
 * Loader: data/normalized/prompts-github/prompts.json → prompts table.
 * Idempotent — ON CONFLICT (id) DO NOTHING. No TRUNCATE (the table also
 * holds prompthero rows).  LOAD_LIMIT=N for test mode.
 */
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../lib/db.js';
import { loadRows } from '../lib/loader.js';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const INPUT_FILE = join(__dirname, '..', 'data', 'normalized', 'prompts-github', 'prompts.json');

const limitArg = process.env.LOAD_LIMIT || process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1];
const LIMIT    = limitArg ? parseInt(limitArg, 10) : null;

const COLUMNS  = ['id', 'provider', 'category', 'title', 'prompt_text', 'source', 'media_url', 'media_type', 'prompt_source', 'page_url', 'posted'];
const CONFLICT = '(id)';

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
    posted:        '{}',
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
  const { inserted, skipped } = await loadRows('prompts', rows, { columns: COLUMNS, conflictTarget: CONFLICT });
  console.log(`Curated prompts — inserted: ${inserted}, skipped: ${skipped}`);
  await pool.end();
  console.log('Done.');
}

main().catch((err) => { console.error(err); process.exit(1); });
