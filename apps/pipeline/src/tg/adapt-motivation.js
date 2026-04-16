/**
 * Адаптує статті із articles-self-development.json для Telegram-каналу мотивації.
 * Кожну статтю прогоняє через Claude API і зберігає у data/publish-ready/tg/motivation-posts.json.
 *
 * Usage:
 *   node --env-file=../../.env src/tg/adapt-motivation.js
 *   ADAPT_LIMIT=5 node --env-file=../../.env src/tg/adapt-motivation.js   # тільки перші N
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import * as cheerio from 'cheerio';
import { fetchHtml } from '../lib/fetch.js';
import { HUMAN_VOICE_SKILL, ANTI_SLOP_SKILL, buildSystemPrompt } from './skills.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');
const INPUT     = join(ROOT, 'data/normalized/daytoday/articles-self-development.json');
const OUTPUT    = join(ROOT, 'data/publish-ready/tg/motivation-posts.json');

const LIMIT = process.env.ADAPT_LIMIT ? parseInt(process.env.ADAPT_LIMIT) : Infinity;

const BASE_PROMPT = `Ти — редактор Telegram-каналу з мотивації та саморозвитку.
Твоє завдання: взяти текст статті і написати мотиваційний пост для Telegram.

КРОК 1 — ВИЗНАЧ ТИП СТАТТІ:

A) СТАТТЯ З КОНКРЕТНИМ СПИСКОМ (фільми, книги, люди, поради, техніки тощо)
   → Використовуй ФОРМАТ СПИСКУ (див. нижче)

B) ЗАГАЛЬНА МОТИВАЦІЙНА СТАТТЯ (психологія, звички, саморозвиток без конкретного переліку)
   → Використовуй ФОРМАТ ЕСЕ (див. нижче)

---

ФОРМАТ СПИСКУ (для типу A):
- Перший рядок: <b>Заголовок — чітко про що список</b> (наприклад: «7 фільмів про жінок, які змінили світ» або «5 книг, що навчать тебе думати інакше»)
- Порожній рядок
- Один абзац <i>...</i> — чому цей список вартий уваги (1–3 речення, без переліку імен)
- Порожній рядок
- Сам список: кожен пункт з нового рядка у форматі:
  <b>Назва</b> — одне речення про суть або чому варто
- Порожній рядок
- Один короткий абзац <i>...</i> — мотиваційне закриття (необов'язково якщо список говорить сам за себе)

ФОРМАТ ЕСЕ (для типу B):
- Перший рядок: <b>Живий заголовок</b> (не копіюй назву статті)
- Порожній рядок
- 2–3 абзаци, кожен у <i>...</i>, розділені порожнім рядком

---

ДОВЖИНА ВИДИМОГО ТЕКСТУ (без HTML тегів):
- Список до 5 пунктів → до 1024 символів
- Список 6+ пунктів або есе з багатим змістом → до 4000 символів
- Ніколи не розтягуй штучно. Ніколи не обрізай важливе.

МОВА: українська. ТОН: конкретний, живий, без канцеляризмів.
НЕ ВКЛЮЧАЙ: хештеги, посилання, підписи, footer.
ПОВЕРНИ ТІЛЬКИ готовий текст поста. Без пояснень.`;

const SYSTEM_PROMPT = buildSystemPrompt(BASE_PROMPT, HUMAN_VOICE_SKILL, ANTI_SLOP_SKILL);

/** Fetch and extract full article text from daytoday.ua */
async function fetchFullContent(url) {
  try {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);

    // daytoday.ua uses .entry-content or .post-content for article body
    const body = $('.entry-content, .post-content, article .content').first();
    if (!body.length) return null;

    // Remove unwanted elements
    body.find('script, style, .sharedaddy, .jp-relatedposts, .post-navigation, nav, figure figcaption').remove();

    const text = body.text().replace(/\s+/g, ' ').trim();
    return text.length > 100 ? text : null;
  } catch (err) {
    return null;
  }
}

async function adaptArticle(article) {
  const fullContent = await fetchFullContent(article.url);
  const content = fullContent ?? article.content ?? article.excerpt ?? '';

  const prompt = `${SYSTEM_PROMPT}

---

НАЗВА СТАТТІ: ${article.title}

ЗМІСТ:
${content.slice(0, 8000)}`;

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;

  const result = spawnSync('claude', ['-p'], {
    input:     prompt,
    encoding:  'utf8',
    timeout:   120_000,
    maxBuffer: 10 * 1024 * 1024,
    env,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const errMsg = result.stderr?.trim() || result.stdout?.trim() || `claude exited with code ${result.status}`;
    throw new Error(`[stderr] ${errMsg}`);
  }

  return result.stdout?.trim() || null;
}

async function run() {
  const source = JSON.parse(readFileSync(INPUT, 'utf8'));
  const articles = source.articles.slice(0, LIMIT === Infinity ? undefined : LIMIT);

  // Завантажуємо вже оброблені (для resume при переривання)
  let existing = [];
  if (existsSync(OUTPUT)) {
    existing = JSON.parse(readFileSync(OUTPUT, 'utf8')).posts ?? [];
  }
  const doneSlуgs = new Set(existing.map(p => p.slug));

  const posts = [...existing];
  let processed = 0;

  for (const article of articles) {
    if (doneSlуgs.has(article.slug)) {
      console.log(`  [skip] ${article.title}`);
      continue;
    }

    process.stdout.write(`  [fetch] ${article.title} ... `);
    try {
      const post = await adaptArticle(article);
      process.stdout.write('done\n');
      if (!post) {
        console.warn(`  [warn] empty response for "${article.title}"`);
        continue;
      }

      posts.push({
        slug:      article.slug,
        title:     article.title,
        sourceUrl: article.url,
        imageUrl:  article.imageUrl ?? null,
        tags:      article.tags ?? [],
        post,
        adaptedAt: new Date().toISOString(),
      });

      processed++;
      save(posts);
      console.log(`  [done] ${processed} adapted`);
    } catch (err) {
      console.error(`  [error] "${article.title}": ${err.message}`);
    }
  }

  console.log(`\nГотово: ${processed} нових постів. Всього у файлі: ${posts.length}`);
  console.log(`Збережено: ${OUTPUT}`);
}

function save(posts) {
  const dir = dirname(OUTPUT);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(OUTPUT, JSON.stringify({ source: 'self-development', count: posts.length, posts }, null, 2), 'utf8');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
