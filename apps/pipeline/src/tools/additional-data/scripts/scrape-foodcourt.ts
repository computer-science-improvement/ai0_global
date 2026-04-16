/**
 * Scraper for foodcourt.com.ua recipes via WordPress REST API.
 *
 * Fetches all posts (423 total, 5 pages × 100), parses ingredients,
 * instructions and images from content HTML, resolves category/tag names.
 *
 * Output: src/data/raw/recipes/recipes_scraped.json
 *
 * Run: npx tsx apps/pipeline/src/tools/additional-data/scripts/scrape-foodcourt.ts
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = 'https://foodcourt.com.ua';
const WP_API = `${BASE_URL}/wp-json/wp/v2`;
const OUTPUT_FILE = path.join(__dirname, '..', '..', '..', 'data', 'raw', 'recipes', 'recipes_scraped.json');
const DELAY_MS = 300;
const REQUEST_TIMEOUT = 15_000;
const PER_PAGE = 100;

// Priority order for picking the "primary" category label
const CATEGORY_PRIORITY: Array<[number, string]> = [
  [13, 'Супи'],
  [11, 'Салати'],
  [14, 'Десерти'],
  [15, 'Закуски'],
  [18, 'Напої'],
  [478, 'Гарніри'],
  [248, 'Риба'],
  [289, 'Птиця'],
  [140, 'Алкогольне'],
  [17, 'Маринад'],
  [19, 'Соуси'],
  [16, 'Тісто'],
  [48, 'Гаряче'],
  [20, 'Без цукру'],
  [49, 'Вегетаріанське'],
  [10, 'Вечеря'],
  [8, 'Сніданки'],
  [9, 'Обід'],
  [34, 'Сезонна'],
  [338, 'Хельсі'],
  [12, 'Страви'],
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface Recipe {
  title: string;
  slug: string;
  url: string;
  description: string;
  ingredients: string;
  instructions: string;
  image_url: string;
  category: string;
  tags: string[];
  post_text: string;
}

interface WPPost {
  id: number;
  title: { rendered: string };
  slug: string;
  link: string;
  excerpt: { rendered: string };
  content: { rendered: string };
  categories: number[];
  tags: number[];
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await axios.get<T>(url, {
      timeout: REQUEST_TIMEOUT,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; recipe-scraper/1.0)',
        Accept: 'application/json',
      },
    });
    return res.data;
  } catch (err: any) {
    console.error(`  [ERROR] ${url}: ${err.message}`);
    return null;
  }
}

// ─── Taxonomy loaders ─────────────────────────────────────────────────────────

async function loadCategories(): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  const data = await fetchJson<Array<{ id: number; name: string }>>(
    `${WP_API}/categories?per_page=100&_fields=id,name`,
  );
  if (data) {
    for (const cat of data) map.set(cat.id, cat.name);
  }
  return map;
}

async function loadTags(): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  let page = 1;
  while (true) {
    const data = await fetchJson<Array<{ id: number; name: string }>>(
      `${WP_API}/tags?per_page=100&page=${page}&_fields=id,name`,
    );
    if (!data || data.length === 0) break;
    for (const tag of data) map.set(tag.id, tag.name);
    if (data.length < 100) break;
    page++;
    await delay(DELAY_MS);
  }
  return map;
}

// ─── Content parser ───────────────────────────────────────────────────────────

interface ParsedContent {
  ingredients: string;
  instructions: string;
  imageUrl: string;
}

function parseContent(html: string): ParsedContent {
  const $ = cheerio.load(html);

  // ── Image ──────────────────────────────────────────────────────────────────
  // Prefer the main recipe image inside wp-block-media-text
  let imageUrl = '';
  const mediaImg = $('.wp-block-media-text__media img').first();
  if (mediaImg.length) {
    // Pick the original (largest) URL from srcset — last entry has the highest width
    const srcset = mediaImg.attr('srcset') || '';
    const parts = srcset
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const last = parts.at(-1);
    if (last) imageUrl = last.split(/\s+/)[0] ?? '';
    if (!imageUrl) imageUrl = mediaImg.attr('src') || '';
  }
  if (!imageUrl) {
    imageUrl = $('img').first().attr('src') || '';
  }

  // ── Ingredients ────────────────────────────────────────────────────────────
  // Live inside .wp-block-media-text__content, separated from the cook-time
  // block by an <hr>.  Items may be <p> tags OR <ul><li> list items.
  const ingredientParts: string[] = [];
  const contentBlock = $('.wp-block-media-text__content').first();
  let foundHeader = false;

  contentBlock.children().each((_, el) => {
    const $el = $(el);

    // Stop collecting when we hit the <hr> separator
    if ($el.is('hr')) return false;

    const text = $el.text().trim();
    if (!text) return;

    // The "Інгредієнти" heading — a <p> with <strong> before any ingredients
    if ($el.is('p') && $el.find('strong').length && !foundHeader) {
      foundHeader = true;
      return;
    }

    if (!foundHeader) return;

    if ($el.is('ul')) {
      // Each <li> is one ingredient
      $el.find('li').each((_, li) => {
        const item = $(li).text().trim();
        if (item) ingredientParts.push(item);
      });
    } else if ($el.is('p')) {
      ingredientParts.push(text);
    }
  });

  // ── Instructions ───────────────────────────────────────────────────────────
  // Numbered steps live OUTSIDE the media-text block as plain <p> tags.
  // Step numbers use various Unicode dot characters (e.g. U+2024 ONE DOT LEADER)
  // so we match "digit(s) followed by any non-digit non-space character".
  const instructionParts: string[] = [];
  let inInstructions = false;

  $('p').each((_, el) => {
    const $el = $(el);
    const text = $el.text().trim();
    if (!text) return;

    const strongText = $el.find('strong').text().trim().toLowerCase();

    if (
      strongText.startsWith('приготування') ||
      strongText.startsWith('як приготувати')
    ) {
      inInstructions = true;
      return;
    }

    if (inInstructions && /^\d+\S/.test(text)) {
      // Strip "1․ " / "1. " / "1) " etc. — one non-space separator char after digits
      const normalised = text.replace(/^(\d+)\S\s*/, '$1. ');
      instructionParts.push(normalised);
    }
  });

  return {
    imageUrl,
    ingredients: ingredientParts.join(', '),
    instructions: instructionParts.join('\n'),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return cheerio.load(html).text().trim().replace(/\s+/g, ' ');
}

function pickCategory(
  categoryIds: number[],
  categoryMap: Map<number, string>,
): string {
  for (const [id, label] of CATEGORY_PRIORITY) {
    if (categoryIds.includes(id)) return label;
  }
  return categoryIds.length > 0
    ? (categoryMap.get(categoryIds[0]) ?? 'Страви')
    : 'Страви';
}

function resolveTagNames(tagIds: number[], tagMap: Map<number, string>): string[] {
  return tagIds
    .map((id) => tagMap.get(id))
    .filter((name): name is string => Boolean(name))
    .map((name) => name.toLowerCase().replace(/\s+/g, '_'));
}

// ─── Posts fetcher ────────────────────────────────────────────────────────────

async function fetchPostsPage(page: number): Promise<WPPost[]> {
  const url =
    `${WP_API}/posts` +
    `?per_page=${PER_PAGE}&page=${page}` +
    `&_fields=id,title,slug,link,excerpt,content,categories,tags`;
  const data = await fetchJson<WPPost[]>(url);
  return data ?? [];
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('foodcourt.com.ua recipe scraper');
  console.log(`Output: ${OUTPUT_FILE}`);
  console.log('');

  console.log('Loading categories...');
  const categoryMap = await loadCategories();
  console.log(`  ${categoryMap.size} categories`);

  console.log('Loading tags...');
  const tagMap = await loadTags();
  console.log(`  ${tagMap.size} tags`);
  console.log('');

  const recipes: Recipe[] = [];
  let page = 1;

  while (true) {
    console.log(`Fetching page ${page}...`);
    const posts = await fetchPostsPage(page);
    if (posts.length === 0) break;

    for (const post of posts) {
      const { ingredients, instructions, imageUrl } = parseContent(
        post.content.rendered,
      );

      recipes.push({
        title: stripHtml(post.title.rendered),
        slug: post.slug,
        url: post.link,
        description: stripHtml(post.excerpt.rendered),
        ingredients,
        instructions,
        image_url: imageUrl,
        category: pickCategory(post.categories, categoryMap),
        tags: resolveTagNames(post.tags, tagMap),
        post_text: '',
      });
    }

    console.log(`  +${posts.length} posts (total: ${recipes.length})`);
    if (posts.length < PER_PAGE) break;
    page++;
    await delay(DELAY_MS);
  }

  const output = {
    source: 'foodcourt.com.ua',
    scraped_at: new Date().toISOString(),
    recipes,
  };

  const dir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf-8');

  console.log('');
  console.log(`Done! ${recipes.length} recipes → ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
