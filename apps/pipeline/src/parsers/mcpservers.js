/**
 * Парсер списку MCP-серверів з mcpservers.org: всі категорії та всі сторінки.
 */
import { fetchHtml } from '../lib/fetch.js';
import { scrapeBySelectors } from '../lib/scrape.js';
import { saveRawJson } from '../lib/json.js';
import { pathToFileURL } from 'url';

const BASE = 'https://mcpservers.org';
const PER_PAGE = 30;
const PARSER_ID = 'mcpservers';

const CATEGORIES = [
  { url: `${BASE}/official`, slug: 'official' },
  { url: `${BASE}/category/search`, slug: 'search' },
  { url: `${BASE}/category/web-scraping`, slug: 'web-scraping' },
  { url: `${BASE}/category/communication`, slug: 'communication' },
  { url: `${BASE}/category/productivity`, slug: 'productivity' },
  { url: `${BASE}/category/development`, slug: 'development' },
  { url: `${BASE}/category/database`, slug: 'database' },
  { url: `${BASE}/category/cloud-service`, slug: 'cloud-service' },
  { url: `${BASE}/category/file-system`, slug: 'file-system' },
  { url: `${BASE}/category/cloud-storage`, slug: 'cloud-storage' },
  { url: `${BASE}/category/version-control`, slug: 'version-control' },
  { url: `${BASE}/category/other`, slug: 'other' },
];

function cleanText(s) {
  if (!s || typeof s !== 'string') return '';
  return s.replace(/\s+/g, ' ').trim();
}

/** Розбити текст картки: назва, опис, чи є позначка sponsor. Якщо один рядок — спочатку шукаємо "official"/"sponsor", інакше межа lowercase→uppercase. */
function parseCardText(text) {
  const raw = (text || '').trim();
  const lines = raw.split(/\n/).map((l) => l.trim()).filter(Boolean);
  const isSponsor = lines.some((l) => l.toLowerCase() === 'sponsor');
  if (lines.length === 1) {
    const line = lines[0];
    const badgeMatch = line.match(/\b(official|sponsor)\s*/i);
    if (badgeMatch) {
      const idx = badgeMatch.index + badgeMatch[0].length;
      const name = cleanText(line.slice(0, badgeMatch.index));
      const description = cleanText(line.slice(idx));
      return { name: name || null, description: description || null, isSponsor };
    }
    const match = line.match(/([a-z])([A-Z])/);
    if (match) {
      const idx = line.indexOf(match[0]) + 1;
      const name = cleanText(line.slice(0, idx));
      const description = cleanText(line.slice(idx));
      return { name: name || null, description: description || null, isSponsor };
    }
    return { name: line || null, description: null, isSponsor };
  }
  const nameParts = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    if (lower === 'sponsor' || lower === 'official') continue;
    nameParts.push(lines[i]);
    i++;
    break;
  }
  const name = cleanText(nameParts.join(' '));
  const description = cleanText(lines.slice(i).join(' '));
  return { name: name || null, description: description || null, isSponsor };
}

/** Зробити посилання абсолютним */
function absoluteUrl(href, base) {
  if (!href) return null;
  if (href.startsWith('http://') || href.startsWith('https://')) return href;
  const u = new globalThis.URL(base);
  return href.startsWith('/') ? `${u.origin}${href}` : `${u.origin}/${href}`;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** URL сторінки пагінації (?page=N) */
function pageUrl(categoryUrl, page) {
  if (page <= 1) return categoryUrl;
  const u = new globalThis.URL(categoryUrl);
  u.searchParams.set('page', String(page));
  return u.toString();
}

/** Парсити одну HTML-сторінку, повернути масив { name, description, link } з категорією */
function parsePageItems(html, categoryUrl, categorySlug) {
  const selectors = {
    items: 'a[href*="/servers/"]',
    name: 'h3, h2, [class*="title"], [class*="name"]',
    description: 'p, [class*="desc"], [class*="summary"]',
    href: '',
    text: '',
  };
  const raw = scrapeBySelectors(html, selectors);
  const rows = Array.isArray(raw?.items) ? raw.items : [];

  return rows
    .map((r) => {
      const link = absoluteUrl((r.href || r.link || '').trim(), categoryUrl);
      if (!link) return null;
      const fullText = (r.text || '').trim();
      if (fullText.toLowerCase().includes('sponsor')) return null;
      let name = cleanText(r.name);
      let description = cleanText(r.description);
      if (!name || !description) {
        const parsed = parseCardText(fullText);
        if (!name) name = parsed.name;
        if (!description) description = parsed.description;
      }
      const n = name || '(no name)';
      return {
        name: n,
        title: n,
        description: description || '',
        link,
        source: null,
        category: categorySlug,
        extra: {},
      };
    })
    .filter(Boolean);
}

async function run() {
  const allItems = [];

  for (const { url: categoryUrl, slug: categorySlug } of CATEGORIES) {
    console.log(`Категорія: ${categorySlug}`);
    let page = 1;
    let totalInCategory = 0;

    while (true) {
      const pageUrlStr = pageUrl(categoryUrl, page);
      const html = await fetchHtml(pageUrlStr);
      const items = parsePageItems(html, categoryUrl, categorySlug);
      if (items.length === 0) break;
      allItems.push(...items);
      totalInCategory += items.length;
      if (page % 5 === 0) {
        console.log(`  сторінка ${page}, знайдено: ${items.length}`);
      }
      page++;
      await delay(400);
    }

    console.log(`  всього сторінок: ${page}, записів: ${totalInCategory}`);
  }

  const result = {
    source: 'mcpservers',
    count: allItems.length,
    categories: CATEGORIES.map((c) => c.slug),
    items: allItems,
  };

  const writtenPath = saveRawJson('assets', PARSER_ID, result);
  console.log('Всього записів:', allItems.length, '— збережено:', writtenPath);
  return result;
}

export default run;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
