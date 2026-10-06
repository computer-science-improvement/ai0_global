/**
 * Loader: additional-data/datasets normalized/treatfield/articles-*.json → the `articles` dataset (data store, spec 032)
 *
 * Expects the shape from scrape-treatfield-articles.js (`articles` array with
 * title, slug, url, excerpt, content, imageUrl, category, tags).
 *
 * LOAD_LIMIT=N — first N articles only (test)
 */
import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../lib/db.js';
import { loadData, schemaFor, formatLoad } from '../lib/loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATASETS_DIR = join(__dirname, '..', 'data', 'normalized', 'treatfield');

const limitArg = process.env.LOAD_LIMIT || process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1];
const LIMIT = limitArg ? parseInt(limitArg, 10) : null;

function mapArticle(article) {
  return {
    title: article.title,
    slug: article.slug,
    url: article.url,
    excerpt: article.excerpt ?? null,
    content: article.content ?? null,
    image_url: article.imageUrl ?? null,
    category: article.category ?? null,
    tags: article.tags ?? [],
  };
}

async function loadTreatfieldArticles() {
  let files;
  try {
    files = (await readdir(DATASETS_DIR)).filter((f) => f.startsWith('articles-') && f.endsWith('.json'));
  } catch {
    console.log(`No treatfield datasets dir or files: ${DATASETS_DIR}`);
    return;
  }
  files.sort();

  let totalInserted = 0;
  let totalSkipped = 0;

  for (const file of files) {
    const raw = await readFile(join(DATASETS_DIR, file), 'utf-8');
    const data = JSON.parse(raw);
    let rows = (data.articles ?? []).filter((a) => a.title && a.slug).map(mapArticle);

    if (LIMIT) rows = rows.slice(0, LIMIT);
    if (!rows.length) continue;

    console.log(`Loading ${rows.length} articles from treatfield/${file}`);
    const r = await loadData(schemaFor('treatfield'), rows, { filename: `treatfield/${file}` });
    totalInserted += r.inserted;
    totalSkipped += r.skipped;
    console.log(`  ${formatLoad(r)}`);
  }

  console.log(`Treatfield articles total — inserted: ${totalInserted}, skipped: ${totalSkipped}\n`);
}

async function main() {
  await loadTreatfieldArticles();
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
