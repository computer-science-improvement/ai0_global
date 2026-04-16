import * as cheerio from 'cheerio';
import { pathToFileURL } from 'url';
import { fetchHtml } from '../lib/fetch.js';
import { scrapeBySelectors } from '../lib/scrape.js';
import { saveRawJson } from '../lib/json.js';
import { cleanTitleOrDescription } from '../lib/text.js';

/** Прибрати з тексту CSS-класи/стилі та зайві пробіли */
function cleanText(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .replace(/\.css-[a-zA-Z0-9-]+\{[^}]*\}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Чи виглядає як сміття (hex-колір, CSS-клас, односимвольний тощо) */
function isJunkTag(t) {
  if (!t || t.length < 2) return true;
  if (/^[0-9A-Fa-f]{3,8}(\s*\d+)?$/.test(t)) return true;
  if (/^[0-9A-Fa-f]{2,8}$/.test(t)) return true;
  if (/^__\w+$/.test(t) || t === 'h' || t === 'next') return true;
  return false;
}

/** Витягти теги зі сторінки — лише осмислені (# Work Users, # Prompt Packs), без hex-кольорів і сміття */
function extractTagsFromHtml(html) {
  const $ = cheerio.load(html);
  const tags = new Set();
  const bodyText = $('body').text();
  const hashMatches = bodyText.match(/#\s*[\w\s]+/g);
  if (hashMatches) {
    hashMatches.forEach((m) => {
      const t = m.replace(/^#\s*/, '').trim();
      if (t.length >= 2 && t.length < 80 && !isJunkTag(t)) tags.add(t);
    });
  }
  $(`a[href*="/tags/"], a[href*="/clubs/"]`).each((_, el) => {
    const t = $(el).text().trim();
    if (t && !/^(Communities|navigation|content)$/i.test(t) && t.length < 80 && !isJunkTag(t)) tags.add(t);
  });
  return Array.from(tags);
}

async function getPromptPacks(path, title) {
    const url = `https://academy.openai.com${path}`;
    const html = await fetchHtml(url);
    const tags = extractTagsFromHtml(html);

    const selectors = {
        items: 'tbody tr',
        case: 'td:nth-of-type(1)',
        prompt: 'td:nth-of-type(2)',
        link: 'td:nth-of-type(3) a',
    };
    const raw = scrapeBySelectors(html, selectors);
    const rows = Array.isArray(raw?.items) ? raw.items : [];
    return rows
        .map((r) => {
            const case_ = cleanText(r.case) || null;
            const prompt = cleanText(r.prompt) || null;
            const link = (r.link || '').trim() || null;
            if (!link) return null;
            return {
                title: cleanTitleOrDescription(case_ ?? ''),
                description: cleanTitleOrDescription(prompt ?? ''),
                link,
                source: url,
                category: tags[0] ?? null,
                extra: { case: case_, prompt, tags: tags.length ? tags : undefined },
            };
        })
        .filter(Boolean);
};

function dedupeByHref(items) {
  if (!Array.isArray(items)) return [];
  const byHref = new Map();
  for (const item of items) {
    const href = (item.href || '').trim();
    if (!href || href.startsWith('#')) continue;
    const text = cleanText(item.text);
    if (!byHref.has(href) || text.length > (byHref.get(href).text || '').length) {
      byHref.set(href, { href, text: text || null });
    }
  }
  return Array.from(byHref.values());
}

async function run() {
  const url = 'https://academy.openai.com/public/tags/prompt-packs-6849a0f98c613939acef841c';
  const html = await fetchHtml(url);

  const selectors = {
    items: 'section a[href]',
    href: '',
    text: '',
  };
  const raw = scrapeBySelectors(html, selectors);
  const links = dedupeByHref(raw.items);
  // Тільки посилання на клуби: таблиця "Use Case | Prompt | URL" (/clubs/.../resources/...)
  const clubLinks = links.filter((item) => (item.href || '').includes('/clubs/'));
  const items = [];
  for (const item of clubLinks) {
    const rows = await getPromptPacks(item.href, item.text);
    items.push(...rows);
  }
  const result = { source: 'academy-openai', count: items.length, items };
  const writtenPath = saveRawJson('assets', 'academy-openai', result);
  console.log('Збережено:', writtenPath, '— елементів:', result.count);
  return result;
}

export default run;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
