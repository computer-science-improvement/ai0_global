/**
 * Парсер ресурсів Academy OpenAI з таблицею колонок:
 * "Prompt (paste into ChatGPT)" → description
 * "Upload?" → extra.upload
 * "So What?" → title
 *
 * Приклад: https://academy.openai.com/public/resources/govt-prompt-pack-for-leaders
 */
import * as cheerio from 'cheerio';
import { pathToFileURL } from 'url';
import { fetchHtml } from '../lib/fetch.js';
import { saveRawJson } from '../lib/json.js';
import { cleanTitleOrDescription } from '../lib/text.js';

const PARSER_ID = 'academy-openai-resources';

/** URL сторінок з таблицями типу Prompt | Upload? | So What? (додавай нові сюди) */
const RESOURCE_URLS = [
  'https://academy.openai.com/public/resources/govt-prompt-pack-for-leaders',
];

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
  // Hex-кольори: F7F7F7, 00B1E2, FFF, "F7F7F7 2"
  if (/^[0-9A-Fa-f]{3,8}(\s*\d+)?$/.test(t)) return true;
  if (/^[0-9A-Fa-f]{2,8}$/.test(t)) return true;
  // Технічні рядки
  if (/^__\w+$/.test(t) || t === 'h' || t === 'next') return true;
  return false;
}

/** Витягти теги зі сторінки — лише осмислені (# OpenAI for Government, # Prompt Packs), без hex-кольорів і сміття */
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

/**
 * Визначити індекси колонок за заголовками.
 * Очікувані колонки: Prompt (paste into ChatGPT) | Upload? | So What?
 */
function findColumnIndices(headerTexts) {
  const normalized = headerTexts.map((t) => cleanText(t).toLowerCase());
  let idxPrompt = -1;
  let idxUpload = -1;
  let idxSoWhat = -1;
  normalized.forEach((text, i) => {
    if (text.includes('prompt') || text.includes('paste into chatgpt')) idxPrompt = i;
    if (text.includes('upload')) idxUpload = i;
    if (text.includes('so what')) idxSoWhat = i;
  });
  return { idxPrompt, idxUpload, idxSoWhat };
}

/**
 * Парсити HTML сторінки: знайти таблиці з колонками Prompt | Upload? | So What?
 * і повернути масив item { title, description, link, source, category, extra }.
 */
function parseResourcePage(html, pageUrl) {
  const $ = cheerio.load(html);
  const tags = extractTagsFromHtml(html);
  const items = [];

  $('table').each((_, table) => {
    const $table = $(table);
    const $rows = $table.find('tr');
    if ($rows.length < 2) return;

    const $headerRow = $table.find('thead tr').length ? $table.find('thead tr').first() : $rows.first();
    const headerTexts = $headerRow.find('th, td').map((__, cell) => $(cell).text()).get();
    const { idxPrompt, idxUpload, idxSoWhat } = findColumnIndices(headerTexts);

    if (idxPrompt === -1 || idxSoWhat === -1) return;

    const $bodyRows = $table.find('thead').length ? $table.find('tbody tr') : $rows.slice(1);
    $bodyRows.each((__, row) => {
      const $cells = $(row).find('td');
      if ($cells.length === 0) return;

      const get = (idx) => (idx >= 0 && idx < $cells.length ? cleanText($cells.eq(idx).text()) : '');

      const description = get(idxPrompt);
      const upload = idxUpload >= 0 ? get(idxUpload) : '';
      const title = get(idxSoWhat);

      if (!description && !title) return;

      items.push({
        title: cleanTitleOrDescription(title) || '',
        description: cleanTitleOrDescription(description) || '',
        link: null,
        source: pageUrl,
        category: tags[0] ?? null,
        extra: {
          upload: upload || undefined,
          tags: tags.length ? tags : undefined,
        },
      });
    });
  });

  return items;
}

async function run() {
  const allItems = [];

  for (const url of RESOURCE_URLS) {
    console.log('Завантажую:', url);
    const html = await fetchHtml(url);
    const items = parseResourcePage(html, url);
    allItems.push(...items);
    console.log('  знайдено рядків:', items.length);
  }

  const result = {
    source: 'academy-openai-resources',
    count: allItems.length,
    items: allItems,
  };

  const writtenPath = saveRawJson('assets', PARSER_ID, result);
  console.log('Збережено:', writtenPath, '— елементів:', result.count);
  return result;
}

export default run;
export { parseResourcePage, extractTagsFromHtml, RESOURCE_URLS };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
