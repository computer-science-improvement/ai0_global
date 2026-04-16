/**
 * Loader: additional-data/datasets/daytoday/*.json
 *
 * Tables:
 *   on_this_day  ← monthly files (01-sichnia.json … 12-hrudnia.json)
 *   articles     ← articles-*.json
 *   jokes        ← jokes.json
 *   quotes       ← quotes.json
 *
 * LOAD_LIMIT=N — test mode, first N items per file
 */
import { createHash } from 'crypto';
import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../lib/db.js';
import { loadRows } from '../lib/loader.js';

const __dirname    = dirname(fileURLToPath(import.meta.url));
const DATASETS_DIR = join(__dirname, '..', 'data', 'normalized', 'daytoday');

const limitArg = process.env.LOAD_LIMIT || process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1];
const LIMIT    = limitArg ? parseInt(limitArg, 10) : null;

function md5(text) {
  return createHash('md5').update(text).digest('hex');
}

/** Encode a JS array as a Postgres text[] literal */
function pgArray(arr) {
  if (!arr || !arr.length) return '{}';
  return `{${arr.map((t) => `"${String(t).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
}

// ─── Events (monthly files) → on_this_day ─────────────────────────────────

const EVENT_COLUMNS  = ['day', 'month', 'title', 'slug', 'excerpt', 'description', 'image_url', 'tags', 'posted'];
const EVENT_CONFLICT = '(month, day, slug)';

function mapEvent(event, day, month) {
  return {
    day,
    month,
    title:       event.title,
    slug:        event.slug,
    excerpt:     event.excerpt     ?? null,
    description: event.description ?? null,
    image_url:   event.imageUrl    ?? null,
    tags:        pgArray(event.tags),
    posted:      '{}',
  };
}

async function loadEvents() {
  const files = (await readdir(DATASETS_DIR)).filter((f) => /^\d{2}-/.test(f) && f.endsWith('.json'));
  files.sort();

  let totalInserted = 0;
  let totalSkipped  = 0;

  for (const file of files) {
    const raw  = await readFile(join(DATASETS_DIR, file), 'utf-8');
    const data = JSON.parse(raw);
    const rows = [];

    for (const dayObj of data.days ?? []) {
      for (const event of dayObj.events ?? []) {
        if (event.title && event.slug) {
          rows.push(mapEvent(event, dayObj.day, dayObj.month));
        }
      }
    }

    const slice = LIMIT ? rows.slice(0, LIMIT) : rows;
    if (!slice.length) continue;

    console.log(`Loading ${LIMIT ? slice.length + '/' + rows.length : rows.length} events from ${file}`);
    const { inserted, skipped } = await loadRows('on_this_day', slice, { columns: EVENT_COLUMNS, conflictTarget: EVENT_CONFLICT });
    totalInserted += inserted;
    totalSkipped  += skipped;
    console.log(`  inserted: ${inserted}, skipped: ${skipped}`);
  }

  console.log(`Events total — inserted: ${totalInserted}, skipped: ${totalSkipped}\n`);
}

// ─── Articles ────────────────────────────────────────────────────────────────

const ARTICLE_COLUMNS  = ['title', 'slug', 'url', 'excerpt', 'content', 'image_url', 'category', 'tags', 'posted'];
const ARTICLE_CONFLICT = '(slug)';

function mapArticle(article) {
  return {
    title:     article.title,
    slug:      article.slug,
    url:       article.url,
    excerpt:   article.excerpt  ?? null,
    content:   article.content  ?? null,
    image_url: article.imageUrl ?? null,
    category:  article.category ?? null,
    tags:      pgArray(article.tags),
    posted:    '{}',
  };
}

async function loadArticles() {
  const files = (await readdir(DATASETS_DIR)).filter((f) => f.startsWith('articles-') && f.endsWith('.json'));
  files.sort();

  let totalInserted = 0;
  let totalSkipped  = 0;

  for (const file of files) {
    const raw  = await readFile(join(DATASETS_DIR, file), 'utf-8');
    const data = JSON.parse(raw);
    let rows   = (data.articles ?? []).filter((a) => a.title && a.slug).map(mapArticle);

    if (LIMIT) rows = rows.slice(0, LIMIT);
    if (!rows.length) continue;

    console.log(`Loading ${rows.length} articles from ${file}`);
    const { inserted, skipped } = await loadRows('articles', rows, { columns: ARTICLE_COLUMNS, conflictTarget: ARTICLE_CONFLICT });
    totalInserted += inserted;
    totalSkipped  += skipped;
    console.log(`  inserted: ${inserted}, skipped: ${skipped}`);
  }

  console.log(`Articles total — inserted: ${totalInserted}, skipped: ${totalSkipped}\n`);
}

// ─── Jokes ───────────────────────────────────────────────────────────────────

const JOKE_COLUMNS  = ['title', 'content', 'content_hash', 'url', 'posted'];
const JOKE_CONFLICT = '(content_hash)';

function mapJoke(joke) {
  return {
    title:        joke.title   ?? null,
    content:      joke.content,
    content_hash: md5(joke.content),
    url:          joke.url     ?? null,
    posted:       '{}',
  };
}

async function loadJokes() {
  const file = join(DATASETS_DIR, 'jokes.json');
  const raw  = await readFile(file, 'utf-8');
  const data = JSON.parse(raw);
  let rows   = (data.jokes ?? []).filter((j) => j.content).map(mapJoke);

  if (LIMIT) rows = rows.slice(0, LIMIT);
  if (!rows.length) { console.log('No jokes to load'); return; }

  console.log(`Loading ${rows.length} jokes`);
  const { inserted, skipped } = await loadRows('jokes', rows, { columns: JOKE_COLUMNS, conflictTarget: JOKE_CONFLICT });
  console.log(`Jokes — inserted: ${inserted}, skipped: ${skipped}\n`);
}

// ─── Quotes ──────────────────────────────────────────────────────────────────

const QUOTE_COLUMNS  = ['text', 'text_hash', 'author', 'category', 'url', 'posted'];
const QUOTE_CONFLICT = '(text_hash)';

/** Clean quote text: strip numbering, all curly/smart quotes, trailing dashes */
function cleanQuoteText(raw) {
  return raw
    .trim()
    .replace(/^\d+\.\s*/, '')                      // "12. …" → "…"
    .replace(/[\u201C\u201D\u201E\u201F]/g, '')    // remove all curly quotes
    .replace(/^[\s"«»]+/, '')                      // strip leading straight quotes/guillemets
    .replace(/[\s"«»]+$/, '')                      // strip trailing straight quotes/guillemets
    .replace(/\s*[–—]\s*$/, '')                    // trailing dash
    .trim();
}

function mapQuote(quote) {
  const text = cleanQuoteText(quote.text);
  return {
    text,
    text_hash: md5(text),
    author:    quote.author   ?? null,
    category:  quote.category ?? null,
    url:       quote.url      ?? null,
    posted:    '{}',
  };
}

async function loadQuotes() {
  const file = join(DATASETS_DIR, 'quotes.json');
  const raw  = await readFile(file, 'utf-8');
  const data = JSON.parse(raw);
  let rows   = (data.quotes ?? []).filter((q) => q.text).map(mapQuote);

  if (LIMIT) rows = rows.slice(0, LIMIT);
  if (!rows.length) { console.log('No quotes to load'); return; }

  console.log(`Loading ${rows.length} quotes`);
  const { inserted, skipped } = await loadRows('quotes', rows, { columns: QUOTE_COLUMNS, conflictTarget: QUOTE_CONFLICT });
  console.log(`Quotes — inserted: ${inserted}, skipped: ${skipped}\n`);
}

// ─── Name Days ───────────────────────────────────────────────────────────────

const NAME_DAY_COLUMNS  = ['month', 'day', 'name'];
const NAME_DAY_CONFLICT = '(month, day, name)';

async function loadNameDays() {
  const files = (await readdir(DATASETS_DIR)).filter((f) => /^\d{2}-/.test(f) && f.endsWith('.json'));
  files.sort();

  let totalInserted = 0;
  let totalSkipped  = 0;

  for (const file of files) {
    const raw  = await readFile(join(DATASETS_DIR, file), 'utf-8');
    const data = JSON.parse(raw);
    const rows = [];

    for (const dayObj of data.days ?? []) {
      for (const name of dayObj.nameDays ?? []) {
        if (name && name.trim()) {
          rows.push({ month: dayObj.month, day: dayObj.day, name: name.trim() });
        }
      }
    }

    const slice = LIMIT ? rows.slice(0, LIMIT) : rows;
    if (!slice.length) continue;

    const { inserted, skipped } = await loadRows('name_days', slice, { columns: NAME_DAY_COLUMNS, conflictTarget: NAME_DAY_CONFLICT });
    totalInserted += inserted;
    totalSkipped  += skipped;
  }

  console.log(`Name days — inserted: ${totalInserted}, skipped: ${totalSkipped}`);
}

// ─── Birthdays ───────────────────────────────────────────────────────────────

const BIRTHDAY_COLUMNS  = ['month', 'day', 'year', 'name', 'posted'];
const BIRTHDAY_CONFLICT = '(month, day, name)';

async function loadBirthdays() {
  const files = (await readdir(DATASETS_DIR)).filter((f) => /^\d{2}-/.test(f) && f.endsWith('.json'));
  files.sort();

  let totalInserted = 0;
  let totalSkipped  = 0;

  for (const file of files) {
    const raw  = await readFile(join(DATASETS_DIR, file), 'utf-8');
    const data = JSON.parse(raw);
    const rows = [];

    for (const dayObj of data.days ?? []) {
      for (const b of dayObj.birthdays ?? []) {
        if (b.name && b.name.trim()) {
          rows.push({ month: dayObj.month, day: dayObj.day, year: b.year ?? null, name: b.name.trim(), posted: '{}' });
        }
      }
    }

    const slice = LIMIT ? rows.slice(0, LIMIT) : rows;
    if (!slice.length) continue;

    const { inserted, skipped } = await loadRows('birthdays', slice, { columns: BIRTHDAY_COLUMNS, conflictTarget: BIRTHDAY_CONFLICT });
    totalInserted += inserted;
    totalSkipped  += skipped;
  }

  console.log(`Birthdays — inserted: ${totalInserted}, skipped: ${totalSkipped}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (LIMIT) console.log(`Test mode: first ${LIMIT} items per file\n`);

  await loadEvents();
  await loadArticles();
  await loadJokes();
  await loadQuotes();
  await loadNameDays();
  await loadBirthdays();

  await pool.end();
  console.log('Done.');
}

main().catch((err) => { console.error(err); process.exit(1); });
