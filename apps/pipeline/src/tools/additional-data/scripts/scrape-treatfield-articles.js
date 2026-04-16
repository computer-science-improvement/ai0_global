/**
 * TreatField — scrape psychotherapy category into normalized JSON for `articles` loader.
 *
 * Listing: https://www.treatfield.com/category/psihoterapia
 * Articles: https://www.treatfield.com/field/{slug}
 *
 * Run (from repo root):
 *   pnpm --filter pipeline run scrape:treatfield
 *
 * Env:
 *   BASE_URL=https://www.treatfield.com
 *   CATEGORY_PATH=/category/psihoterapia
 *   MAX_LISTING_PAGES=0   — 0 = crawl until a page adds no new slugs
 *   MAX_ARTICLES=0          — 0 = fetch all collected slugs
 *   DELAY_MS=500
 *   CONCURRENCY=3
 *   REQUEST_TIMEOUT=15000
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE_URL = (process.env.BASE_URL ?? 'https://www.treatfield.com').replace(/\/$/, '');
const CATEGORY_PATH = process.env.CATEGORY_PATH ?? '/category/psihoterapia';
const MAX_LISTING_PAGES = Number(process.env.MAX_LISTING_PAGES ?? 0);
const MAX_ARTICLES = Number(process.env.MAX_ARTICLES ?? 0);
const DELAY_MS = Number(process.env.DELAY_MS ?? 500);
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY ?? 3));
const REQUEST_TIMEOUT = Number(process.env.REQUEST_TIMEOUT ?? 15_000);

const OUTPUT_FILE = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'data',
  'normalized',
  'treatfield',
  'articles-psihoterapia.json',
);

const http = axios.create({
  timeout: REQUEST_TIMEOUT,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'uk,en;q=0.9',
  },
  validateStatus: (s) => s < 500,
});

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** @param {string} html */
function parseListingSlugs(html) {
  const $ = cheerio.load(html);
  const out = new Set();
  $('a[href^="/field/"]').each((_, el) => {
    let href = $(el).attr('href');
    if (!href) return;
    href = href.replace(/&amp;/g, '&');
    const m = href.match(/^\/field\/([a-zA-Z0-9_-]+)\/?(?:\?|$)/);
    if (!m) return;
    const slug = m[1];
    if (slug === 'posts' || slug === 'videos') return;
    out.add(slug);
  });
  return [...out];
}

function listingUrl(page) {
  if (page <= 1) return `${BASE_URL}${CATEGORY_PATH}`;
  return `${BASE_URL}${CATEGORY_PATH}?page=${page}&per-page=21`;
}

async function collectAllSlugs() {
  const seen = new Set();
  let page = 1;
  let stagnant = 0;

  while (true) {
    if (MAX_LISTING_PAGES > 0 && page > MAX_LISTING_PAGES) break;

    const url = listingUrl(page);
    console.log(`Listing ${url}`);
    const res = await http.get(url);
    if (res.status !== 200 || !res.data) {
      console.warn(`  status ${res.status} — stop pagination`);
      break;
    }

    const slugs = parseListingSlugs(res.data);
    let added = 0;
    for (const s of slugs) {
      if (!seen.has(s)) {
        seen.add(s);
        added++;
      }
    }
    console.log(`  +${added} new slugs (total ${seen.size})`);
    if (added === 0) stagnant++;
    else stagnant = 0;
    if (stagnant >= 2) break;

    page++;
    await delay(DELAY_MS);
  }

  return [...seen];
}

/** @param {string} slug */
function extractBodyText($) {
  const paras = [];
  $('article p').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t) paras.push(t);
  });
  if (paras.length) return paras.join('\n\n');
  const body = $('[itemprop="articleBody"]');
  if (body.length) return body.text().replace(/\s+/g, ' ').trim();
  return $('article').text().replace(/\s+/g, ' ').trim();
}

/** @param {string} slug */
async function scrapeArticle(slug) {
  /** Canonical public URL — always from slug; HTML `link[rel=canonical]` may omit the slug. */
  const url = `${BASE_URL}/field/${slug}`;
  const res = await http.get(url);
  if (res.status !== 200 || !res.data) {
    console.error(`  [skip] ${url} status ${res.status}`);
    return null;
  }

  const $ = cheerio.load(res.data);
  const title = ($('title').first().text() || '').trim();
  const articleUrl = url;
  const excerpt = ($('meta[name="description"]').attr('content') || '').trim() || null;
  const imageUrl = ($('meta[property="og:image"]').attr('content') || '').trim() || null;
  const content = extractBodyText($);

  if (!title) {
    console.error(`  [skip] no title ${url}`);
    return null;
  }

  return {
    title,
    slug: `treatfield-${slug}`,
    url: articleUrl,
    excerpt,
    content: content || null,
    imageUrl,
    category: 'psihoterapia',
    tags: ['treatfield', 'psihoterapia'],
  };
}

async function mapPool(items, concurrency, fn) {
  const out = [];
  let next = 0;
  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      const r = await fn(items[idx], idx);
      if (r) out.push(r);
    }
  }
  const nWorkers = Math.min(concurrency, Math.max(1, items.length));
  await Promise.all(Array.from({ length: nWorkers }, () => worker()));
  return out;
}

async function main() {
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });

  const slugs = await collectAllSlugs();
  console.log(`Collected ${slugs.length} slugs`);

  const take = MAX_ARTICLES > 0 ? slugs.slice(0, MAX_ARTICLES) : slugs;
  console.log(`Fetching ${take.length} article pages (concurrency ${CONCURRENCY})`);

  let done = 0;
  const articles = await mapPool(take, CONCURRENCY, async (slug) => {
    done++;
    if (done % 10 === 0) console.log(`  … ${done}/${take.length}`);
    await delay(DELAY_MS);
    try {
      return await scrapeArticle(slug);
    } catch (e) {
      console.error(`  [err] ${slug}: ${e.message}`);
      return null;
    }
  });

  const payload = {
    source: 'treatfield',
    category: 'psihoterapia',
    scraped_at: new Date().toISOString(),
    articles,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(payload, null, 2), 'utf-8');
  console.log(`Wrote ${articles.length} articles → ${OUTPUT_FILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
