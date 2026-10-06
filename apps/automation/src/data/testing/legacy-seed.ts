import { randomUUID, createHash } from 'crypto';
import type { Pool, PoolClient } from 'pg';

/**
 * Production-shaped rows for the 12 pre-058 content tables (spec 032 T2 tests): Cyrillic text, NULLs in
 * every nullable column, `posted` markers (incl. `error:` keys), nested JSON with nulls, numeric scales,
 * text[] with commas/quotes, the empty-title_uk recipe sentinel, case-only dedup collisions and a jsonb
 * column holding JSON null. Deterministic for a given `n`. Test-only — never run against real data.
 */

const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const UK = ['Київ', 'Львів', 'борщ', 'вареники', 'Шевченко', 'Леся Українка', 'їжак', 'ґанок', 'Євген', 'щедрик'];
const uk = (i: number, words = 6) => Array.from({ length: words }, (_, k) => UK[(i * 7 + k * 3) % UK.length]).join(' ');
const at = (i: number) => new Date(Date.UTC(2025, 0, 1) + i * 3_600_000).toISOString();
const posted = (i: number) =>
  i % 3 === 0 ? {} :
  i % 3 === 1 ? { TELEGRAM: at(i), '@chan_a': at(i + 1) } :
  { '@chan_b': at(i), 'error:@chan_c': { at: at(i), reason: 'dead page (HTTP 404)' }, 'IG:7f0c': at(i + 2) };
const maybe = <T>(i: number, v: T, every = 4): T | null => (i % every === 0 ? null : v);
const license = (i: number) => ['unknown', 'permitted', 'own', 'cc-by', 'pd'][i % 5];

type Q = Pick<Pool | PoolClient, 'query'>;

async function insert(db: Q, table: string, rows: Record<string, unknown>[]): Promise<void> {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200);
    const params: unknown[] = [];
    const values = batch.map((r) => `(${cols.map((c) => { params.push(r[c]); return `$${params.length}`; }).join(', ')})`);
    await db.query(`INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(', ')}) VALUES ${values.join(', ')}`, params);
  }
}

export const SEEDED_TABLES = ['recipes', 'facts', 'quotes', 'prompts', 'on_this_day', 'articles', 'pdr_questions',
  'birthdays', 'assets', 'tg_posts', 'jokes', 'name_days'] as const;

export async function seedLegacyTables(db: Q, n = 300): Promise<Record<string, number>> {
  const R = (f: (i: number) => Record<string, unknown>) => Array.from({ length: n }, (_, i) => f(i));
  const counts: Record<string, number> = {};
  const put = async (t: string, rows: Record<string, unknown>[]) => { await insert(db, t, rows); counts[t] = rows.length; };

  await put('recipes', R((i) => ({
    id: randomUUID(), title: `Recipe ${i} ${i % 2 ? 'with "quotes", commas' : 'plain'}`, slug: `recipe-${i}`,
    url: maybe(i, `https://www.example.com/r/${i}`), description: maybe(i, `Опис ${uk(i)}`, 5),
    ingredients: `1 cup flour\n2 eggs\n${uk(i, 2)}`, instructions: maybe(i, `Step 1.\nStep 2. ${uk(i, 3)}`, 7),
    image_url: maybe(i, `https://img.example.com/${i}.jpg`, 9), category: maybe(i, ['dessert', 'soup', 'main'][i % 3], 6),
    tags: i % 4 === 0 ? [] : ['quick', `tag, with comma ${i}`, 'має "лапки"'], post_text: maybe(i, 'old post', 2),
    posted: JSON.stringify(posted(i)),
    title_uk: i % 5 === 0 ? null : i % 11 === 0 ? '' : `Рецепт ${i} ${uk(i, 2)}`,
    ingredients_uk: i % 5 === 0 ? null : `1 склянка борошна ${i}`, instructions_uk: i % 5 === 0 ? null : 'Крок 1.',
    translated_at: i % 5 === 0 ? null : at(i), telegraph_url: maybe(i, `https://telegra.ph/Recipe-${i}`, 3),
    telegraph_path: maybe(i, `Recipe-${i}`, 3),
    kcal: i % 10 === 0 ? null : (250 + i + 0.5).toFixed(2), protein_g: maybe(i, '12.0', 8), fat_g: maybe(i, (i / 7).toFixed(3), 8),
    carbs_g: maybe(i, '0', 8), serving_size_g: maybe(i, '150', 8),
    raw: i % 6 === 0 ? null : JSON.stringify({ recipe_name: `R${i}`, nutrition_per_serving: { calories: String(250 + i), sodium_mg: null }, notes: [uk(i, 2), null] }),
    created_at: at(i), source_name: maybe(i, 'epicure.kaikaku.ai'), source_url: maybe(i, `https://www.example.com/r/${i}`), license: license(i),
  })));

  await put('facts', R((i) => {
    const content = `Факт ${i}: ${uk(i, 8)}.`;
    return {
      id: randomUUID(), article_slug: `article-${i % 40}`, article_title: `Стаття ${i % 40} — ${uk(i, 3)}`,
      article_url: maybe(i, `https://faktypro.com.ua/a/${i % 40}`), image_url: maybe(i, `https://faktypro.com.ua/i/${i % 40}.webp`, 3),
      content, content_hash: md5(content), category: maybe(i, ['наука', 'історія', 'тварини'][i % 3]),
      posted: JSON.stringify(posted(i)), created_at: at(i), source_name: 'faktypro.com.ua', source_url: maybe(i, `https://faktypro.com.ua/a/${i % 40}`), license: license(i),
    };
  }));

  await put('quotes', R((i) => {
    const text = `Цитата ${i} ${uk(i, 5)}`;
    return {
      id: randomUUID(), text, text_hash: md5(text), author: maybe(i, `Автор ${i % 30}`, 6), category: maybe(i, 'мотивація', 3),
      url: maybe(i, `https://daytoday.ua/q/${i}`), posted: JSON.stringify(posted(i)), created_at: at(i),
      source_name: maybe(i, 'daytoday.ua'), source_url: maybe(i, `https://daytoday.ua/q/${i}`), license: license(i),
    };
  }));

  await put('prompts', R((i) => ({
    // Ids are URLs with mixed case; rows 1 and 2 differ only by case (a lower-cased dedup collision).
    id: i === 2 ? 'https://CDN.prompthero.com/Img/1.PNG'.toLowerCase() : i === 1 ? 'https://CDN.prompthero.com/Img/1.PNG' : `https://cdn.prompthero.com/img/${i}/${i % 2 ? 'A' : 'b'}.png`,
    prompt_source: `https://prompthero.com/prompt/${i}`, category: maybe(i, ['anime', 'architecture'][i % 2]),
    posted: JSON.stringify(posted(i)), scraped_at: maybe(i, at(i)), page_url: maybe(i, `https://prompthero.com/prompt/${i}`),
    status: i % 13 === 0 ? 'ERROR' : null, provider: i % 4 === 0 ? 'nanobanana' : 'prompthero',
    title: i % 4 === 0 ? `Prompt ${i}` : null, prompt_text: i % 4 === 0 ? `a cat in ${uk(i, 2)}, 8k` : null,
    source: i % 4 === 0 ? 'github.com/x/y' : null, media_url: i % 4 === 0 ? `https://m.example.com/${i}.mp4` : null,
    media_type: i % 4 === 0 ? (i % 8 === 0 ? 'video' : 'image') : null, created_at: at(i),
    source_name: maybe(i, 'prompthero.com'), source_url: maybe(i, `https://prompthero.com/prompt/${i}`), license: license(i),
  })));

  await put('on_this_day', R((i) => ({
    id: randomUUID(), day: (i % 28) + 1, month: (i % 12) + 1, title: `Подія ${i} ${uk(i, 3)}`, slug: `event-${i}`,
    excerpt: maybe(i, uk(i, 10)), description: maybe(i, uk(i, 30), 3), image_url: maybe(i, `https://daytoday.ua/e/${i}.jpg`),
    tags: i % 2 ? ['свято'] : [], posted: JSON.stringify(posted(i)), created_at: at(i),
    source_name: 'daytoday.ua', source_url: null, license: license(i),
  })));

  await put('articles', R((i) => ({
    id: randomUUID(), title: `Стаття ${i}`, slug: `art-${i}`, url: `https://daytoday.ua/art/${i}`,
    excerpt: maybe(i, uk(i, 12)), content: maybe(i, uk(i, 200), 5), image_url: maybe(i, `https://daytoday.ua/art/${i}.jpg`),
    category: maybe(i, ['science', 'movies'][i % 2]), tags: [`t${i % 5}`], posted: JSON.stringify(posted(i)), created_at: at(i),
    source_name: 'daytoday.ua', source_url: `https://daytoday.ua/art/${i}`, license: license(i),
  })));

  await put('pdr_questions', R((i) => ({
    id: randomUUID(), question_id: 10_000 + i, ticket_number: Math.floor(i / 20) + 1, question_num: (i % 20) + 1,
    text: `Питання ${i}: ${uk(i, 6)}?`, image_url: maybe(i, `https://pdr-online.com.ua/img/${i}.jpg`, 2),
    answers: JSON.stringify(i % 3 ? ['Так', 'Ні', 'Залежить від знака'] : [{ text: 'A' }, { text: 'B' }]),
    correct_answer_num: (i % 3) + 1 > 2 ? 2 : (i % 3) + 1, explanation: i % 5 ? `Пункт ${i % 30}.${i % 9}` : '',
    posted: JSON.stringify(posted(i)), created_at: at(i), source_name: 'pdr-online.com.ua', license: license(i),
  })));

  await put('birthdays', R((i) => ({
    id: randomUUID(), month: (i % 12) + 1, day: (i % 28) + 1, year: maybe(i, 1800 + i, 5), name: `Особа ${i} ${UK[i % UK.length]}`,
    posted: JSON.stringify(posted(i)), created_at: at(i), source_name: 'daytoday.ua', license: license(i),
  })));

  await put('assets', R((i) => ({
    // Titles 'Tool 1' and 'tool 1' collide once lower-cased.
    id: randomUUID(), data_source: ['academy-openai', 'mcpservers', 'prompts-md'][i % 3],
    title: i === 4 ? 'tool 1' : i === 1 ? 'Tool 1' : `Tool ${i}`, description: i % 7 ? `What tool ${i} does: ${uk(i, 4)}` : '',
    link: maybe(i, `https://github.com/x/tool-${i}`), source_url: maybe(i, `https://academy.openai.com/${i}`, 3),
    category: maybe(i, 'mcp'), extra: i % 9 === 0 ? 'null' : i % 2 ? JSON.stringify({ stars: i, tags: ['a', null] }) : null,
    posted: JSON.stringify(posted(i)), created_at: at(i), source_name: maybe(i, 'github.com'), license: license(i),
  })).map((r, i) => (i === 1 || i === 4 ? { ...r, data_source: 'mcpservers' } : r)));

  await put('tg_posts', R((i) => {
    const post = `<b>Пост ${i}</b>\n${uk(i, 20)}`;
    return {
      id: randomUUID(), source: ['daytoday-self-development', 'samorozvytok-motivatory', 'birthdays-db'][i % 3],
      source_url: i % 3 === 2 ? '' : `https://daytoday.ua/p/${i}`, title: `Пост ${i}`, image_url: maybe(i, `https://x.ua/${i}.jpg`),
      post, content_hash: md5(post), author: maybe(i, 'Редакція', 2), source_published_at: maybe(i, at(i), 3),
      tags: i % 2 ? ['мотивація', 'успіх'] : [], posted: JSON.stringify(posted(i)), created_at: at(i),
      source_name: maybe(i, 'daytoday.ua'), license: license(i),
    };
  }));

  await put('jokes', R((i) => {
    const content = `Жарт ${i}: ${uk(i, 7)}`;
    return {
      id: randomUUID(), title: maybe(i, `Жарт ${i}`, 2), content, content_hash: md5(content), url: maybe(i, `https://daytoday.ua/j/${i}`),
      posted: JSON.stringify(posted(i)), created_at: at(i), source_name: 'daytoday.ua', license: license(i),
    };
  }));

  await put('name_days', R((i) => ({
    id: randomUUID(), month: (i % 12) + 1, day: (i % 28) + 1, name: `${UK[i % UK.length]} ${i}`, created_at: at(i),
    source_name: 'daytoday.ua', license: license(i),
  })));

  return counts;
}
