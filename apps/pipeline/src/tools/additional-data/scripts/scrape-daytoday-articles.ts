/**
 * Scraper for daytoday.ua article sections.
 *
 * Sections:
 *  - Цікаві факти    /interesting/           (paginated /page/N/)
 *  - Цікава наука    /tsikava-nauka/         (paginated /page/N/)
 *  - Саморозвиток    /samorozvytok/          (paginated /page/N/)
 *  - Здорове життя   /zdorove-zhyttia/       (paginated /page/N/)
 *  - Анекдот дня     /anekdot-dnia/          (special: jokes via ?_page=N)
 *  - Фільми на вечір /filmy-na-vechir/       (paginated /page/N/)
 *  - Добірки         /dobirky/               (paginated /page/N/)
 *  - Цитати          multiple sub-categories (via ?_page=N)
 *  - Рецепт дня      /retsept-dnia/          (paginated /page/N/)
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';

// ─── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = 'https://daytoday.ua';
const OUTPUT_DIR = path.join(__dirname, '..', '..', '..', 'data', 'normalized', 'daytoday');
const DELAY_MS = 500;
const REQUEST_TIMEOUT = 10_000;
const PARALLEL_DETAIL = 3;
/** Maximum listing pages per section (set to Infinity to scrape everything). */
const MAX_PAGES = 5;

// ─── Types ────────────────────────────────────────────────────────────────────

interface ArticleStub {
  title: string;
  slug: string;
  url: string;
  excerpt: string;
  imageUrl: string;
  category: string;
}

interface Article extends ArticleStub {
  content: string;
  tags: string[];
}

interface SectionArticles {
  section: string;
  sectionName: string;
  articles: Article[];
}

interface Joke {
  title: string;
  content: string;
  url: string;
  imageUrl: string | null;
}

interface SectionJokes {
  section: 'jokes';
  sectionName: string;
  jokes: Joke[];
}

interface Quote {
  text: string;
  author: string;
  category: string;
  url: string;
}

interface SectionQuotes {
  section: 'quotes';
  sectionName: string;
  quotes: Quote[];
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function fetchHtml(url: string): Promise<string | null> {
  try {
    const res = await axios.get<string>(url, {
      timeout: REQUEST_TIMEOUT,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'uk,en;q=0.9',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    return res.data;
  } catch (err: any) {
    console.error(`  [ERROR] fetch ${url}: ${err.message}`);
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Article listing scraper ──────────────────────────────────────────────────

/**
 * Scrape one listing page (e.g. /interesting/ or /interesting/page/2/).
 * Returns array of stubs found on that page, or null if page not found / empty.
 */
function parseListingPage(
  html: string,
  categoryName: string,
): ArticleStub[] | null {
  const $ = cheerio.load(html);
  const stubs: ArticleStub[] = [];

  $('article').each((_, el) => {
    const $el = $(el);

    // Title + URL from h2 > a (or h3 > a)
    const titleLink = $el.find('h2 a, h3 a').first();
    const title = titleLink.text().trim();
    const url = titleLink.attr('href') || '';
    if (!title || !url) return;

    // Slug: last path segment
    const slugMatch = url.replace(/\/$/, '').match(/\/([^/]+)$/);
    const slug = slugMatch ? slugMatch[1] : url;

    // Excerpt from the <p> in the article card
    const excerpt = $el.find('p').first().text().trim();

    // Image — prefer the linked img, then any img
    const imgEl = $el.find('.entry-image img, a > img, img').first();
    const imageUrl =
      imgEl.attr('src') || imgEl.attr('data-src') || imgEl.attr('data-lazy-src') || '';

    stubs.push({ title, slug, url, excerpt, imageUrl, category: categoryName });
  });

  return stubs.length > 0 ? stubs : null;
}

/**
 * Crawl all paginated listing pages for a section using /page/N/ pattern.
 * Stops when a page returns no articles or when MAX_PAGES is reached.
 */
async function scrapeListingSection(
  sectionSlug: string,
  categoryName: string,
): Promise<ArticleStub[]> {
  const allStubs: ArticleStub[] = [];
  let page = 1;

  while (page <= MAX_PAGES) {
    const url =
      page === 1
        ? `${BASE_URL}/${sectionSlug}/`
        : `${BASE_URL}/${sectionSlug}/page/${page}/`;

    console.log(`  [listing] page ${page}: ${url}`);
    const html = await fetchHtml(url);
    if (!html) break;

    const stubs = parseListingPage(html, categoryName);
    if (!stubs || stubs.length === 0) {
      console.log(`  [listing] page ${page}: no articles found — stopping.`);
      break;
    }

    allStubs.push(...stubs);
    console.log(`  [listing] page ${page}: ${stubs.length} articles (total ${allStubs.length})`);

    // Check if there's a next page link in the HTML
    const $ = cheerio.load(html);
    const nextLink = $('a.next, a[rel="next"]').attr('href') ||
      $('.page-numbers a').filter((_, el) => $(el).text().trim() === String(page + 1)).attr('href');
    if (!nextLink) {
      console.log(`  [listing] no next page link — stopping.`);
      break;
    }

    page++;
    await delay(DELAY_MS);
  }

  return allStubs;
}

// ─── Article detail scraper ───────────────────────────────────────────────────

interface ArticleDetail {
  content: string;
  tags: string[];
  imageUrl: string;
}

async function scrapeArticleDetail(url: string): Promise<ArticleDetail> {
  const html = await fetchHtml(url);
  if (!html) return { content: '', tags: [], imageUrl: '' };

  const $ = cheerio.load(html);

  // Content from .entry-content — get all text, remove scripts/ads
  const entryContent = $('article .entry-content');
  // Remove noise elements
  entryContent.find(
    'script, style, .wulmb-top-widget-container, .wpulike, [id^="ezoic"], .ezoic-ad, ' +
    '.subscribe-section, .wp-block-embed, figure.wp-block-embed, .dayto-v2_nad_page_title_korotka',
  ).remove();

  const contentText = entryContent.text().replace(/\s+/g, ' ').trim();
  const content = contentText.substring(0, 1000);

  // Tags: a[rel="tag"]
  const tags: string[] = [];
  $('a[rel="tag"]').each((_, el) => {
    const tag = $(el).text().trim();
    if (tag) tags.push(tag);
  });

  // Full-size image from article
  const imgEl = $('article .entry-image img, article > img, .wp-post-image').first();
  const imageUrl =
    imgEl.attr('src') ||
    imgEl.attr('data-src') ||
    imgEl.attr('data-lazy-src') ||
    '';

  return { content, tags, imageUrl };
}

// ─── Full article section processor ──────────────────────────────────────────

async function processSectionArticles(
  sectionSlug: string,
  sectionName: string,
  outputFile: string,
): Promise<void> {
  console.log(`\n=== Section: ${sectionName} (/${sectionSlug}/) ===`);

  const stubs = await scrapeListingSection(sectionSlug, sectionName);
  console.log(`  Total stubs collected: ${stubs.length}`);

  const articles: Article[] = [];

  for (let i = 0; i < stubs.length; i += PARALLEL_DETAIL) {
    const batch = stubs.slice(i, i + PARALLEL_DETAIL);
    const results = await Promise.all(
      batch.map(async (stub) => {
        await delay(DELAY_MS);
        console.log(`  [detail] ${stub.url}`);
        const detail = await scrapeArticleDetail(stub.url);
        return {
          ...stub,
          content: detail.content,
          tags: detail.tags,
          imageUrl: detail.imageUrl || stub.imageUrl,
        } as Article;
      }),
    );
    articles.push(...results);
    console.log(`  Progress: ${articles.length}/${stubs.length}`);
  }

  const output: SectionArticles = {
    section: sectionSlug,
    sectionName,
    articles,
  };

  const outPath = path.join(OUTPUT_DIR, outputFile);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`  Saved: ${outPath} (${articles.length} articles)`);
}

// ─── Jokes scraper ────────────────────────────────────────────────────────────

/**
 * The jokes page (/anekdot-dnia/) is a single WordPress post with a
 * Content Views block (.nicespysky.anekdoty).  Each joke is in a
 * .pt-cv-content-item > .pt-cv-content > p  element.
 * Pagination uses ?_page=N (19 pages).
 */
async function scrapeJokes(): Promise<void> {
  console.log('\n=== Section: Анекдот дня (/anekdot-dnia/) ===');

  const baseUrl = `${BASE_URL}/anekdot-dnia/`;
  const jokes: Joke[] = [];

  // First page — also determines total pages
  const firstHtml = await fetchHtml(baseUrl);
  if (!firstHtml) {
    console.error('  [ERROR] Could not fetch jokes page.');
    return;
  }

  let totalPages = 1;
  const $first = cheerio.load(firstHtml);
  const paginationEl = $first('.pt-cv-pagination');
  if (paginationEl.length) {
    const dataTotalPages = parseInt(paginationEl.attr('data-totalpages') || '1', 10);
    totalPages = Math.min(dataTotalPages, MAX_PAGES);
  }

  console.log(`  Total joke pages: ${totalPages} (capped at ${MAX_PAGES})`);

  // Scrape page 1 jokes
  extractJokesFromHtml($first, baseUrl, jokes);
  console.log(`  Page 1: ${jokes.length} jokes so far`);

  // Scrape remaining pages
  for (let p = 2; p <= totalPages; p++) {
    await delay(DELAY_MS);
    const url = `${baseUrl}?_page=${p}`;
    console.log(`  [jokes] page ${p}: ${url}`);
    const html = await fetchHtml(url);
    if (!html) continue;
    const $ = cheerio.load(html);
    const before = jokes.length;
    extractJokesFromHtml($, url, jokes);
    console.log(`  Page ${p}: +${jokes.length - before} jokes (total ${jokes.length})`);
  }

  const output: SectionJokes = {
    section: 'jokes',
    sectionName: 'Анекдот дня',
    jokes,
  };

  const outPath = path.join(OUTPUT_DIR, 'jokes.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`  Saved: ${outPath} (${jokes.length} jokes)`);
}

function extractJokesFromHtml(
  $: cheerio.CheerioAPI,
  pageUrl: string,
  out: Joke[],
): void {
  // Each joke is a .pt-cv-content-item inside the jokes container
  $('.nicespysky.anekdoty .pt-cv-content-item, .anekdoty .pt-cv-content-item').each((_, item) => {
    const $item = $(item);
    const paragraphs: string[] = [];

    $item.find('p').each((_, p) => {
      const text = $(p).text().trim();
      if (text) paragraphs.push(text);
    });

    const content = paragraphs.join('\n').trim();
    if (!content) return;

    // The "title" of the joke page is the first short paragraph, or empty
    const title = paragraphs.length > 1 ? '' : paragraphs[0].substring(0, 60);

    const pid = $item.attr('data-pid');
    const jokeUrl = pid
      ? `${BASE_URL}/?p=${pid}`
      : pageUrl;

    out.push({
      title,
      content,
      url: pageUrl,
      imageUrl: null,
    });
  });
}

// ─── Quotes scraper ───────────────────────────────────────────────────────────

interface QuoteSubCategory {
  slug: string;
  name: string;
}

const QUOTE_CATEGORIES: QuoteSubCategory[] = [
  { slug: 'tsytaty-pro-zhyttia', name: 'Про життя' },
  { slug: 'motyvatsiyni-tsytaty', name: 'Мотиваційні' },
  { slug: 'tsytaty-iaki-berut-za-dushu', name: 'Які беруть за душу' },
  { slug: 'tsytaty-pro-kokhannia', name: 'Про кохання' },
  { slug: 'tsytaty-pro-shchastia', name: 'Про щастя' },
];

/**
 * Quotes pages use a Content Views block (.pt-cv-content-item).
 * Each quote:
 *   - text in p.has-large-font-size  (quoted text)
 *   - author in <em> tag inside that <p>  (preceded by —)
 * Pagination uses ?_page=N.
 */
async function scrapeQuotes(): Promise<void> {
  console.log('\n=== Section: Цитати ===');

  const allQuotes: Quote[] = [];

  for (const cat of QUOTE_CATEGORIES) {
    console.log(`  [quotes] Category: ${cat.name} (/${cat.slug}/)`);
    const baseUrl = `${BASE_URL}/${cat.slug}/`;

    // Fetch first page to get total pages
    const firstHtml = await fetchHtml(baseUrl);
    if (!firstHtml) {
      console.error(`  [ERROR] Could not fetch ${baseUrl}`);
      continue;
    }

    const $first = cheerio.load(firstHtml);
    let totalPages = 1;
    const paginationEl = $first('.pt-cv-pagination');
    if (paginationEl.length) {
      const dataTotalPages = parseInt(paginationEl.attr('data-totalpages') || '1', 10);
      // For quotes we want all pages (they are finite)
      totalPages = dataTotalPages;
    }

    console.log(`    Total pages: ${totalPages}`);

    // Extract from page 1
    const beforeCount = allQuotes.length;
    extractQuotesFromHtml($first, baseUrl, cat.name, allQuotes);
    console.log(`    Page 1: +${allQuotes.length - beforeCount} quotes`);

    // Remaining pages
    for (let p = 2; p <= totalPages; p++) {
      await delay(DELAY_MS);
      const url = `${baseUrl}?_page=${p}`;
      const html = await fetchHtml(url);
      if (!html) continue;
      const $ = cheerio.load(html);
      const before2 = allQuotes.length;
      extractQuotesFromHtml($, url, cat.name, allQuotes);
      console.log(`    Page ${p}: +${allQuotes.length - before2} quotes`);
    }

    await delay(DELAY_MS);
  }

  const output: SectionQuotes = {
    section: 'quotes',
    sectionName: 'Цитати',
    quotes: allQuotes,
  };

  const outPath = path.join(OUTPUT_DIR, 'quotes.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`  Saved: ${outPath} (${allQuotes.length} quotes total)`);
}

function extractQuotesFromHtml(
  $: cheerio.CheerioAPI,
  pageUrl: string,
  categoryName: string,
  out: Quote[],
): void {
  $('.pt-cv-content-item').each((_, item) => {
    const $item = $(item);

    // The quote paragraph has class "has-large-font-size"
    const p = $item.find('p.has-large-font-size').first();
    if (!p.length) return;

    const emEl = p.find('em').first();
    const rawAuthor = emEl.text().trim();
    // Author is after — or – dash
    const author = rawAuthor.replace(/^[—–\-]\s*/, '').trim();

    // Text: full paragraph text, minus the author (em) part
    const fullText = p.text().trim();
    let text = fullText
      .replace(emEl.text(), '')
      .replace(/\s*—\s*$/, '')
      .replace(/^[""]/, '')
      .replace(/[""]$/, '')
      .trim();

    if (!text && !author) return;

    const pid = $item.attr('data-pid');
    const url = pid ? `${BASE_URL}/?p=${pid}` : pageUrl;

    out.push({ text, author, category: categoryName, url });
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  console.log('daytoday.ua articles scraper');
  console.log(`Output dir: ${OUTPUT_DIR}`);
  console.log(`Max pages per section: ${MAX_PAGES}`);
  console.log('');

  // ── Article sections ──────────────────────────────────────────────────────

  await processSectionArticles(
    'interesting',
    'Цікаві факти',
    'articles-interesting-facts.json',
  );

  await processSectionArticles(
    'tsikava-nauka',
    'Цікава наука',
    'articles-science.json',
  );

  await processSectionArticles(
    'samorozvytok',
    'Саморозвиток',
    'articles-self-development.json',
  );

  await processSectionArticles(
    'zdorove-zhyttia',
    'Здорове життя',
    'articles-healthy-lifestyle.json',
  );

  await processSectionArticles(
    'filmy-na-vechir',
    'Фільми на вечір',
    'articles-movies.json',
  );

  await processSectionArticles(
    'dobirky',
    'Добірки',
    'articles-collections.json',
  );

  await processSectionArticles(
    'retsept-dnia',
    'Рецепт дня',
    'articles-recipes.json',
  );

  // ── Jokes ─────────────────────────────────────────────────────────────────

  await scrapeJokes();

  // ── Quotes ────────────────────────────────────────────────────────────────

  await scrapeQuotes();

  console.log('\n=== All done! ===');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
