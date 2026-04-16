/**
 * Адаптує статті із data/normalized/samorozvytok/motivatory.json для Telegram-каналу мотивації.
 * Використовує Claude CLI (підписка, не API).
 *
 * Usage:
 *   node src/tg/adapt-samorozvytok.js
 *   ADAPT_LIMIT=3 node src/tg/adapt-samorozvytok.js
 */

import { spawnSync } from 'child_process';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { HUMAN_VOICE_SKILL, ANTI_SLOP_SKILL, buildSystemPrompt } from './skills.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');
const INPUT     = join(ROOT, 'data/normalized/samorozvytok/motivatory.json');
const OUTPUT    = join(ROOT, 'data/publish-ready/tg/samorozvytok-posts.json');

const LIMIT = process.env.ADAPT_LIMIT ? parseInt(process.env.ADAPT_LIMIT) : Infinity;

const BASE_PROMPT = `Ти — редактор Telegram-каналу з мотивації та саморозвитку.
Твоє завдання: взяти текст статті і написати мотиваційний пост для Telegram.

КРОК 1 — ВИЗНАЧ ТИП СТАТТІ:

A) СТАТТЯ З КОНКРЕТНИМ СПИСКОМ (фільми, книги, люди, поради, техніки тощо)
   → Використовуй ФОРМАТ СПИСКУ

B) ЗАГАЛЬНА МОТИВАЦІЙНА СТАТТЯ (психологія, звички, саморозвиток без конкретного переліку)
   → Використовуй ФОРМАТ ЕСЕ

---

ФОРМАТ СПИСКУ (для типу A):
- Перший рядок: <b>Заголовок — чітко про що список</b>
- Порожній рядок
- Один абзац <i>...</i> — чому цей список вартий уваги (1–3 речення, без переліку імен)
- Порожній рядок
- Сам список: кожен пункт з нового рядка у форматі:
  <b>Назва</b> — одне речення про суть або чому варто
- Порожній рядок
- Один короткий абзац <i>...</i> — мотиваційне закриття (необов'язково)

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

function adaptArticle(article) {
  const content = article.content ?? '';

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
    throw new Error(errMsg);
  }

  return result.stdout?.trim() || null;
}

async function run() {
  if (!existsSync(INPUT)) {
    console.error(`Input file not found: ${INPUT}`);
    console.error('Run: pnpm run parse:samorozvytok');
    process.exit(1);
  }

  const source   = JSON.parse(readFileSync(INPUT, 'utf8'));
  const articles = source.articles.slice(0, LIMIT === Infinity ? undefined : LIMIT);

  // Resume
  let existing = [];
  if (existsSync(OUTPUT)) {
    existing = JSON.parse(readFileSync(OUTPUT, 'utf8')).posts ?? [];
  }
  const doneUrls = new Set(existing.map(p => p.url));

  const posts = [...existing];
  let processed = 0;

  for (const article of articles) {
    if (doneUrls.has(article.url)) {
      console.log(`  [skip] ${article.title}`);
      continue;
    }

    process.stdout.write(`  [adapt] ${article.title} ... `);
    try {
      const post = adaptArticle(article);
      if (!post) {
        process.stdout.write('empty\n');
        continue;
      }

      posts.push({
        url:         article.url,
        title:       article.title,
        author:      article.author ?? null,
        publishedAt: article.publishedAt ?? null,
        imageUrl:    article.imageUrl ?? null,
        post,
        adaptedAt:   new Date().toISOString(),
      });

      processed++;
      save(posts);
      process.stdout.write(`done (${processed})\n`);
    } catch (err) {
      process.stdout.write(`error: ${err.message}\n`);
    }
  }

  console.log(`\nГотово: ${processed} нових постів. Всього у файлі: ${posts.length}`);
  console.log(`Збережено: ${OUTPUT}`);
}

function save(posts) {
  const dir = dirname(OUTPUT);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(
    OUTPUT,
    JSON.stringify({ source: 'samorozvytok.info/motivatory', count: posts.length, posts }, null, 2),
    'utf8',
  );
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
