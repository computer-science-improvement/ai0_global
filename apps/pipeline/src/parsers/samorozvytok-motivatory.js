/**
 * Парсер статей з розділу "Мотиватори" на samorozvytok.info
 * Обходить всі сторінки пагінації, витягує повний контент кожної статті.
 *
 * Usage:
 *   node src/parsers/samorozvytok-motivatory.js
 *   PARSE_LIMIT=5 node src/parsers/samorozvytok-motivatory.js   # тільки перші N статей
 */

import * as cheerio from 'cheerio';
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { fetchHtml } from '../lib/fetch.js';
import { getLifecyclePath } from '../lib/json.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT    = getLifecyclePath('normalized', 'samorozvytok', 'motivatory');

const BASE_URL    = 'https://samorozvytok.info';
const LISTING_URL = `${BASE_URL}/%D1%80%D1%83%D0%B1%D1%80%D0%B8%D0%BA%D0%B8-%D1%81%D0%B0%D0%B9%D1%82%D1%83/%D0%BC%D0%BE%D1%82%D0%B8%D0%B2%D0%B0%D1%82%D0%BE%D1%80%D0%B8`;
const LIMIT       = process.env.PARSE_LIMIT ? parseInt(process.env.PARSE_LIMIT) : Infinity;

/** Визначити кількість сторінок із пагінатора */
async function getTotalPages() {
  const html = await fetchHtml(LISTING_URL);
  const $    = cheerio.load(html);
  const lastLink = $('ul.pager li.pager-last a').attr('href');
  if (!lastLink) {
    // Якщо немає "остання" — лише одна сторінка
    return 1;
  }
  const match = lastLink.match(/page=(\d+)/);
  return match ? parseInt(match[1]) + 1 : 1;
}

/** Отримати список посилань на статті з однієї сторінки лістингу */
async function getArticleLinks(pageIndex) {
  const url  = pageIndex === 0 ? LISTING_URL : `${LISTING_URL}?page=${pageIndex}`;
  const html = await fetchHtml(url);
  const $    = cheerio.load(html);

  const links = [];
  $('article.node-teaser h2.title a').each((_, el) => {
    const href = $(el).attr('href');
    if (href) {
      links.push(href.startsWith('http') ? href : `${BASE_URL}${href}`);
    }
  });
  return links;
}

/** Завантажити та спарсити повну статтю */
async function parseArticle(url) {
  const html = await fetchHtml(url);
  const $    = cheerio.load(html);

  const title = $('h1.page-title').text().trim();

  // Автор
  const author = $('#block-system-main .submitted .username').text().trim() || null;

  // Дата публікації
  const dateRaw = $('#block-system-main .submitted span[property="dc:date dc:created"]').attr('content');
  const publishedAt = dateRaw ? new Date(dateRaw).toISOString() : null;

  // Контент
  const contentEl = $('#block-system-main .field-name-body .field-item');

  // Зображення — перше у тілі статті
  const imgSrc = contentEl.find('img').first().attr('src') ?? null;
  const imageUrl = imgSrc
    ? (imgSrc.startsWith('http') ? imgSrc : `${BASE_URL}${imgSrc}`)
    : null;

  // Текст контенту (без HTML)
  const content = contentEl.text().replace(/\s+/g, ' ').trim();

  // HTML контент (зберігаємо оригінал для якіснішої обробки)
  const contentHtml = contentEl.html()?.trim() ?? null;

  if (!title && !content) return null;

  return {
    url,
    title,
    author,
    publishedAt,
    imageUrl,
    content,
    contentHtml,
  };
}

async function run() {
  // Resume: завантажити вже оброблені
  let existing = [];
  if (existsSync(OUTPUT)) {
    existing = JSON.parse(readFileSync(OUTPUT, 'utf8')).articles ?? [];
  }
  const doneUrls = new Set(existing.map(a => a.url));
  const articles = [...existing];

  console.log('Визначаємо кількість сторінок...');
  const totalPages = await getTotalPages();
  console.log(`Сторінок: ${totalPages}`);

  let totalFetched  = 0;
  let totalSkipped  = 0;
  let limitReached  = false;

  for (let page = 0; page < totalPages; page++) {
    if (limitReached) break;

    console.log(`\n[page ${page + 1}/${totalPages}]`);
    const links = await getArticleLinks(page);
    console.log(`  Знайдено посилань: ${links.length}`);

    for (const url of links) {
      if (limitReached) break;

      if (doneUrls.has(url)) {
        console.log(`  [skip] ${url}`);
        totalSkipped++;
        continue;
      }

      process.stdout.write(`  [fetch] ${url} ... `);
      try {
        const article = await parseArticle(url);
        if (!article) {
          process.stdout.write('empty\n');
          continue;
        }

        articles.push(article);
        doneUrls.add(url);
        totalFetched++;
        save(articles);
        process.stdout.write('done\n');

        if (totalFetched >= LIMIT) {
          limitReached = true;
        }

        await sleep(300); // ввічливий rate limit
      } catch (err) {
        process.stdout.write(`error: ${err.message}\n`);
      }
    }
  }

  console.log(`\nГотово: ${totalFetched} нових, ${totalSkipped} пропущено. Всього: ${articles.length}`);
  console.log(`Збережено: ${OUTPUT}`);
}

function save(articles) {
  const dir = dirname(OUTPUT);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(
    OUTPUT,
    JSON.stringify({ source: 'samorozvytok.info/motivatory', count: articles.length, articles }, null, 2),
    'utf8',
  );
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
