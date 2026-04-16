/**
 * Scraper for faktypro.com.ua — цікаві факти про все на світі.
 *
 * Phase 1: crawl all 31 listing pages → collect article URLs (≈ 744 total).
 * Phase 2: fetch each article → extract title, slug, category, date,
 *           image_url, description (lead text before facts), and facts (ol > li).
 *
 * Output structure per article:
 * {
 *   title, slug, url, category, date, image_url, description,
 *   facts: string[]   ← each <li> is one fact
 * }
 *
 * Writes progress to OUTPUT_FILE after every BATCH_SIZE articles.
 *
 * Run:
 *   npx tsx apps/pipeline/src/tools/additional-data/scripts/scrape-faktypro.ts
 *
 * Options (env):
 *   BATCH_SIZE=20   — save interval (default 20)
 *   CONCURRENCY=5   — parallel article fetches (default 5)
 *   DELAY_MS=200    — delay between requests in ms (default 200)
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Config ───────────────────────────────────────────────────────────────────

const BASE_URL = 'https://faktypro.com.ua';
const TOTAL_PAGES = 31;
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? 20);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 5);
const DELAY_MS = Number(process.env.DELAY_MS ?? 200);
const REQUEST_TIMEOUT = 15_000;

const OUTPUT_FILE = path.join(__dirname, '..', '..', '..', 'data', 'normalized', 'faktypro', 'articles.json');

// ─── Types ────────────────────────────────────────────────────────────────────

interface Article {
  title: string;
  slug: string;
  url: string;
  category: string;
  date: string;
  image_url: string;
  description: string;
  facts: string[];
}

interface Output {
  source: string;
  scraped_at: string;
  total_articles: number;
  total_facts: number;
  articles: Article[];
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

const http = axios.create({
  timeout: REQUEST_TIMEOUT,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml',
    'Accept-Language': 'uk,en;q=0.9',
  },
});

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const res = await http.get<string>(url);
    return res.data;
  } catch (err: any) {
    console.error(`  [ERROR] ${url}: ${err.message}`);
    return null;
  }
}

// ─── Concurrency limiter ──────────────────────────────────────────────────────

async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = [];
  let i = 0;

  async function worker(): Promise<void> {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await tasks[idx]();
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

// ─── Listing pages — collect URLs ─────────────────────────────────────────────

function listingPageUrl(page: number): string {
  return page === 1 ? BASE_URL + '/' : `${BASE_URL}/home/next/${page}`;
}

async function collectArticleUrls(): Promise<string[]> {
  const urls = new Set<string>();

  for (let page = 1; page <= TOTAL_PAGES; page++) {
    const url = listingPageUrl(page);
    console.log(`  Listing page ${page}/${TOTAL_PAGES}: ${url}`);

    const html = await fetchHtml(url);
    if (!html) continue;

    const $ = cheerio.load(html);

    // Article cards: .mso-page-only article h2 a
    $('.mso-page-only article h2 a').each((_, el) => {
      const href = $(el).attr('href');
      if (href && href.includes('/page/')) urls.add(href);
    });

    await delay(DELAY_MS);
  }

  return [...urls];
}

// ─── Article page — extract content ──────────────────────────────────────────

function slugFromUrl(url: string): string {
  return url.split('/page/')[1]?.replace(/\/$/, '') ?? '';
}

function parseArticle(url: string, html: string): Article {
  const $ = cheerio.load(html);

  // Title
  const title = $('header h1').first().text().trim();

  // Category
  const category = $('header .im-bookmark a').first().text().trim();

  // Date — prefer datetime attribute, fall back to visible text
  const timeEl = $('header time').first();
  const date = timeEl.attr('datetime') ?? timeEl.text().trim();

  // Content area — HTML has two nested .mso-page-content divs; pick the innermost
  const contentDivs = $('.mso-page-content');
  const content = contentDivs.length > 1 ? contentDivs.last() : contentDivs.first();

  // Image — first <img> inside the content area
  // The image is typically wrapped in <a href="full-size-url">
  let imageUrl = '';
  const imgLink = content.find('a').filter((_, el) => {
    const href = $(el).attr('href') ?? '';
    return /\.(jpg|jpeg|png|webp)/i.test(href);
  }).first();
  if (imgLink.length) {
    imageUrl = imgLink.attr('href') ?? '';
  } else {
    imageUrl = content.find('img').first().attr('src') ?? '';
  }

  // Description — paragraph(s) before the <ol>
  // Collect <p> texts until we hit the <ol>
  const descParts: string[] = [];
  content.children().each((_, el) => {
    const $el = $(el);
    if ($el.is('ol')) return false; // stop at first <ol>
    if ($el.is('p')) {
      const text = $el.text().trim();
      if (text) descParts.push(text);
    }
  });
  const description = descParts.join(' ').trim();

  // Facts — each <li> in the first <ol>
  const facts: string[] = [];
  content.find('ol').first().find('li').each((_, el) => {
    const text = $(el).text().trim();
    if (text) facts.push(text);
  });

  return {
    title,
    slug: slugFromUrl(url),
    url,
    category,
    date,
    image_url: imageUrl,
    description,
    facts,
  };
}

// ─── Save helpers ─────────────────────────────────────────────────────────────

function saveOutput(articles: Article[]): void {
  const dir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const totalFacts = articles.reduce((sum, a) => sum + a.facts.length, 0);
  const output: Output = {
    source: 'faktypro.com.ua',
    scraped_at: new Date().toISOString(),
    total_articles: articles.length,
    total_facts: totalFacts,
    articles,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf-8');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('faktypro.com.ua scraper');
  console.log(`Output:      ${OUTPUT_FILE}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log(`Batch size:  ${BATCH_SIZE}`);
  console.log('');

  // Phase 1 — collect all article URLs
  console.log(`Phase 1: collecting article URLs from ${TOTAL_PAGES} listing pages...`);
  const articleUrls = await collectArticleUrls();
  console.log(`  Found ${articleUrls.length} article URLs`);
  console.log('');

  // Phase 2 — fetch and parse each article
  console.log('Phase 2: fetching articles...');
  const articles: Article[] = [];
  let processed = 0;
  let errors = 0;

  // Build task list
  const tasks = articleUrls.map((url) => async (): Promise<void> => {
    await delay(Math.random() * DELAY_MS); // jitter

    const html = await fetchHtml(url);
    if (!html) {
      errors++;
      return;
    }

    try {
      const article = parseArticle(url, html);
      articles.push(article);
    } catch (err: any) {
      console.error(`  [PARSE ERROR] ${url}: ${err.message}`);
      errors++;
    }

    processed++;
    if (processed % BATCH_SIZE === 0 || processed === articleUrls.length) {
      saveOutput(articles);
      console.log(
        `  [${processed}/${articleUrls.length}] saved — ${articles.length} ok, ${errors} errors`,
      );
    }
  });

  await runWithConcurrency(tasks, CONCURRENCY);

  // Final save
  saveOutput(articles);

  const totalFacts = articles.reduce((sum, a) => sum + a.facts.length, 0);
  console.log('');
  console.log(`Done!`);
  console.log(`  Articles:  ${articles.length}`);
  console.log(`  Facts:     ${totalFacts}`);
  console.log(`  Errors:    ${errors}`);
  console.log(`  Output:    ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
