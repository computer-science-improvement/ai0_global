/**
 * Loader: additional-data/datasets/faktypro/articles.json → facts table
 *
 * Flattens articles → individual facts (one row per fact).
 * Dedup key: content_hash = md5(content)
 *
 * LOAD_LIMIT=N — test mode, first N articles
 */
import { createHash } from 'crypto';
import { readFile }   from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pool }      from '../lib/db.js';
import { loadRows }  from '../lib/loader.js';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const INPUT_FILE  = join(__dirname, '..', 'data', 'normalized', 'faktypro', 'articles.json');

const limitArg = process.env.LOAD_LIMIT || process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1];
const LIMIT    = limitArg ? parseInt(limitArg, 10) : null;

function md5(text) {
  return createHash('md5').update(text).digest('hex');
}

const COLUMNS  = ['article_slug', 'article_title', 'article_url', 'image_url', 'content', 'content_hash', 'category', 'posted'];
const CONFLICT = '(content_hash)';

function mapFact(fact, article) {
  return {
    article_slug:  article.slug,
    article_title: article.title,
    article_url:   article.url   ?? null,
    image_url:     article.image_url ?? null,
    content:       fact,
    content_hash:  md5(fact),
    category:      article.category ?? null,
    posted:        '{}',
  };
}

async function main() {
  const raw  = await readFile(INPUT_FILE, 'utf-8');
  const data = JSON.parse(raw);

  const articles = data.articles ?? [];
  if (!articles.length) {
    console.error('No articles found in input file');
    process.exit(1);
  }

  const slice = LIMIT ? articles.slice(0, LIMIT) : articles;
  if (LIMIT) console.log(`Test mode: first ${LIMIT} articles\n`);

  // Flatten articles → facts
  const rows = [];
  for (const article of slice) {
    if (!article.slug || !Array.isArray(article.facts)) continue;
    for (const fact of article.facts) {
      if (fact && fact.trim()) rows.push(mapFact(fact.trim(), article));
    }
  }

  if (!rows.length) {
    console.log('No facts to load');
    await pool.end();
    return;
  }

  console.log(`Loading ${rows.length} facts from ${slice.length} articles`);
  const { inserted, skipped } = await loadRows('facts', rows, { columns: COLUMNS, conflictTarget: CONFLICT });
  console.log(`Facts — inserted: ${inserted}, skipped: ${skipped}`);

  await pool.end();
  console.log('Done.');
}

main().catch((err) => { console.error(err); process.exit(1); });
