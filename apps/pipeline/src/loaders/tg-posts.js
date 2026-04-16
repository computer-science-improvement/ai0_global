/**
 * Loader: data/publish-ready/tg/*.json → tg_posts table
 *
 * Завантажує адаптовані Telegram-пости з усіх файлів у data/publish-ready/tg/.
 * Dedup key: content_hash = md5(post)
 *
 * Usage:
 *   node --env-file=../../.env src/loaders/tg-posts.js
 *   LOAD_LIMIT=5 node --env-file=../../.env src/loaders/tg-posts.js
 */

import { createHash }     from 'crypto';
import { readFile }       from 'fs/promises';
import { join, dirname }  from 'path';
import { fileURLToPath }  from 'url';
import { pool }           from '../lib/db.js';
import { loadRows }       from '../lib/loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TG_DIR    = join(__dirname, '..', 'data', 'publish-ready', 'tg');

const LIMIT = process.env.LOAD_LIMIT ? parseInt(process.env.LOAD_LIMIT) : null;

const SOURCES = [
  { file: 'motivation-posts.json',    source: 'daytoday-self-development' },
  { file: 'samorozvytok-posts.json',  source: 'samorozvytok-motivatory'   },
  { file: 'biography-posts.json',     source: 'birthdays-db'              },
];

const COLUMNS  = ['source', 'source_url', 'title', 'image_url', 'post', 'content_hash', 'author', 'source_published_at', 'tags', 'posted'];
const CONFLICT = '(content_hash)';

function md5(text) {
  return createHash('md5').update(text).digest('hex');
}

function mapPost(item, source) {
  return {
    source,
    source_url:   item.sourceUrl ?? item.url ?? '',
    title:        item.title ?? '',
    image_url:    item.imageUrl ?? null,
    post:         item.post,
    content_hash: md5(item.post),
    author:              item.author ?? null,
    source_published_at: item.publishedAt ?? null,
    tags:         item.tags?.length ? item.tags : [],
    posted:       '{}',
  };
}

async function loadFile(file, source) {
  const path = join(TG_DIR, file);
  let raw;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    console.log(`  [skip] ${file} — not found`);
    return 0;
  }

  const data  = JSON.parse(raw);
  const items = data.posts ?? [];
  if (!items.length) {
    console.log(`  [skip] ${file} — empty`);
    return 0;
  }

  const slice = LIMIT ? items.slice(0, LIMIT) : items;
  const rows  = slice
    .filter(item => item.post?.trim())
    .map(item => mapPost(item, source));

  if (!rows.length) return 0;

  console.log(`  ${file}: ${rows.length} posts`);
  const { inserted, skipped } = await loadRows('tg_posts', rows, { columns: COLUMNS, conflictTarget: CONFLICT });
  console.log(`    inserted: ${inserted}, skipped: ${skipped}`);
  return inserted;
}

async function main() {
  if (LIMIT) console.log(`Test mode: first ${LIMIT} posts per file\n`);

  let total = 0;
  for (const { file, source } of SOURCES) {
    total += await loadFile(file, source);
  }

  console.log(`\nTotal inserted: ${total}`);
  await pool.end();
  console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
