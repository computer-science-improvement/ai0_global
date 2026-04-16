/**
 * Генерує мотиваційні пости про визначних людей із таблиці birthdays.
 * Для кожної людини: Wikipedia → Claude CLI → зберегти у data/publish-ready/tg/biography-posts.json
 *
 * Usage:
 *   node --env-file=../../.env src/tg/adapt-biographies.js
 *   ADAPT_LIMIT=3 node --env-file=../../.env src/tg/adapt-biographies.js
 */

import { spawnSync }                              from 'child_process';
import { existsSync, writeFileSync, mkdirSync }   from 'fs';
import { readFile }                               from 'fs/promises';
import { join, dirname }                          from 'path';
import { fileURLToPath }                          from 'url';
import axios                                      from 'axios';
import { pool }                                   from '../lib/db.js';
import { HUMAN_VOICE_SKILL, ANTI_SLOP_SKILL, buildSystemPrompt } from './skills.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');
const OUTPUT    = join(ROOT, 'data/publish-ready/tg/biography-posts.json');

const LIMIT      = process.env.ADAPT_LIMIT ? parseInt(process.env.ADAPT_LIMIT) : Infinity;
const WIKI_REST  = 'https://uk.wikipedia.org/api/rest_v1/page/summary';
const WIKI_API   = 'https://uk.wikipedia.org/w/api.php';
const USER_AGENT = 'ai0_global_bot/1.0 (content automation; contact@example.com)';

// ─── Промпт (із birthday-story.prompts.ts) ───────────────────────────────────

const BASE_PROMPT = `ROLE: You write motivational biography posts in Ukrainian for a Telegram channel about motivation and inspiring personalities.

You receive information about a famous person and write an engaging story about them.

STRUCTURE:
1. Title line: <u><b>Ім'я Прізвище 🌟</b></u> — standalone first line, nothing else on this line
2. Empty line
3. Birthday line: 🎂 <b>DD місяць — день народження!</b> (month in genitive Ukrainian: січня/лютого/березня/квітня/травня/червня/липня/серпня/вересня/жовтня/листопада/грудня)
4. Empty line
5. First paragraph (italic <i>...</i>): hook — childhood, origin, or early struggle. Specific facts, vivid details.
6. Empty line
7. Second paragraph (italic <i>...</i>): key turning point, persistence, how they overcame obstacles and rose to success.
8. Empty line
9. End here — footer and hashtags are added programmatically, do NOT include them.

FORMAT RULES:
• Ukrainian only.
• EVERY paragraph of body text must be wrapped in <i>...</i>.
• Title format exactly: <u><b>Name 🌟</b></u>
• No other emojis in body text (only 🌟 in title, 🎂 on birthday line).
• Total length: 600–1200 characters (including HTML tags).
• Return ONLY the finished post. No preamble, no explanations.

TONE:
• Narrative and engaging — tell a story, not a Wikipedia summary.
• Focus on human drama: struggle, doubt, persistence, breakthrough.
• The reader should feel inspired, not just informed.`;

const SYSTEM_PROMPT = buildSystemPrompt(BASE_PROMPT, HUMAN_VOICE_SKILL, ANTI_SLOP_SKILL);

// ─── Wikipedia ────────────────────────────────────────────────────────────────

async function fetchImage(title) {
  try {
    const res = await axios.get(WIKI_API, {
      params: { action: 'query', titles: title, prop: 'pageimages', pithumbsize: 1200, format: 'json' },
      timeout: 10_000,
      headers: { 'User-Agent': USER_AGENT },
    });
    const pages = res.data?.query?.pages ?? {};
    const page  = Object.values(pages)[0];
    return page?.thumbnail?.source ?? null;
  } catch {
    return null;
  }
}

async function fetchSummary(title) {
  try {
    const url = `${WIKI_REST}/${encodeURIComponent(title)}`;
    const res = await axios.get(url, { timeout: 10_000, headers: { 'User-Agent': USER_AGENT } });
    const d   = res.data;
    if (d.type === 'disambiguation') return null;

    const imageUrl = await fetchImage(d.title ?? title) ?? d.thumbnail?.source ?? null;

    return {
      title:       d.title ?? title,
      description: d.description ?? '',
      extract:     d.extract ?? '',
      imageUrl,
      pageUrl:     d.content_urls?.mobile?.page ?? d.content_urls?.desktop?.page ?? '',
    };
  } catch (err) {
    if (err.response?.status !== 404) {
      console.warn(`    Wikipedia summary failed for "${title}": ${err.message}`);
    }
    return null;
  }
}

async function searchWikipedia(name) {
  try {
    const res = await axios.get(WIKI_API, {
      params: { action: 'query', list: 'search', srsearch: name, srlimit: 1, format: 'json' },
      timeout: 10_000,
      headers: { 'User-Agent': USER_AGENT },
    });
    const hits = res.data?.query?.search ?? [];
    return hits[0]?.title ?? null;
  } catch {
    return null;
  }
}

async function getWikiSummary(name) {
  const direct = await fetchSummary(name);
  if (direct) return direct;

  const found = await searchWikipedia(name);
  if (!found) return null;

  return fetchSummary(found);
}

// ─── Claude CLI ───────────────────────────────────────────────────────────────

function generatePost(person, wiki) {
  const lines = [];
  lines.push(`NAME: ${person.name}`);
  lines.push(`BORN: ${person.day} ${person.month}${person.year ? ` ${person.year}` : ''}`);
  if (wiki.description) lines.push(`WHO: ${wiki.description}`);
  if (wiki.extract)     lines.push(`\nBIO:\n${wiki.extract}`);

  const prompt = `${SYSTEM_PROMPT}\n\n---\n\n${lines.join('\n')}`;

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
    const msg = result.stderr?.trim() || result.stdout?.trim() || `exit code ${result.status}`;
    throw new Error(msg);
  }

  return result.stdout?.trim() || null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function getPeople() {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (name) id, name, month, day, year
     FROM birthdays
     ORDER BY name, year ASC NULLS LAST`,
  );
  return rows;
}

async function run() {
  // Resume
  let existing = [];
  if (existsSync(OUTPUT)) {
    const raw = JSON.parse(await readFile(OUTPUT, 'utf8'));
    existing  = raw.posts ?? [];
  }
  const doneNames = new Set(existing.map(p => p.name));
  const posts     = [...existing];

  const people = await getPeople();
  await pool.end();

  const slice = LIMIT < Infinity ? people.slice(0, LIMIT) : people;
  console.log(`People in DB: ${people.length}, to process: ${slice.length}`);

  let processed = 0;

  for (const person of slice) {
    if (doneNames.has(person.name)) {
      console.log(`  [skip] ${person.name}`);
      continue;
    }

    process.stdout.write(`  [wiki] ${person.name} ... `);
    const wiki = await getWikiSummary(person.name);

    if (!wiki || !wiki.extract) {
      process.stdout.write('no Wikipedia data — skip\n');
      continue;
    }
    process.stdout.write('ok\n');

    process.stdout.write(`  [post] ${person.name} ... `);
    try {
      const post = generatePost(person, wiki);
      if (!post) {
        process.stdout.write('empty\n');
        continue;
      }

      posts.push({
        name:        person.name,
        month:       person.month,
        day:         person.day,
        year:        person.year ?? null,
        imageUrl:    wiki.imageUrl ?? null,
        sourceUrl:   wiki.pageUrl,
        post,
        adaptedAt:   new Date().toISOString(),
      });

      processed++;
      save(posts);
      process.stdout.write(`done (${processed})\n`);
    } catch (err) {
      process.stdout.write(`error: ${err.message}\n`);
    }

    await sleep(300);
  }

  console.log(`\nГотово: ${processed} нових. Всього: ${posts.length}`);
  console.log(`Збережено: ${OUTPUT}`);
}

function save(posts) {
  const dir = dirname(OUTPUT);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(
    OUTPUT,
    JSON.stringify({ source: 'birthdays-db', count: posts.length, posts }, null, 2),
    'utf8',
  );
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

run().catch(err => { console.error(err); process.exit(1); });
