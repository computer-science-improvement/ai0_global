/**
 * Spec 037 T11: media — a news post shows only its source page's main image (none in the source → no media), network
 * posters only on non-news posts whose topic matches `use_for`. The golden-set export does not carry poster identity
 * (it is slot data), so the 12.10 cases (Qwen-Image news with «Fine-tune / Model», the free-courses round-up with
 * «Prompt» and «Skill») are reproduced here from their text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuditCard, AuditContext, AuditPost } from './types';
import { isNewsPost, mediaCheck } from './checks/media';
import { auditPostFromSpec } from './from-post-spec';
import { AI_POSTERS, posterFitsTopic, posterOf } from '../media/posters';
import { normalizeImageUrl, sameImage } from '../media/image-url';
import { lintPost } from '../lint-post';
import { makeCard, makeSpec } from '../testing/fixtures';

const POSTER = (id: string) => `https://prdruteophdbnypnikij.supabase.co/storage/v1/object/public/common/${id}.png`;
const NEWS_CARD: AuditCard = { timezone: 'Europe/Kyiv', style: { content_kind: 'news' } as AuditCard['style'] };
const codes = (fs: Array<{ code: string; level: string }>) => fs.map((f) => `${f.code}:${f.level}`);

const post = (o: Partial<AuditPost> = {}): AuditPost => ({
  id: 't:1', channel: 'AI Технології', publishedAt: '2026-10-12T16:01:05+02:00', timezone: 'Europe/Kyiv',
  text: 'Звичайний текст.', links: [], buttons: [], hashtags: [], media: { kind: 'photo', count: 1 }, ...o,
});
const ctx = (o: Partial<AuditContext> = {}): AuditContext => ({ previous: [], card: NEWS_CARD, ...o });

// 12.10 16:01, AI Технології (golden ai-tekhnolohii:1042): news about a model release with the «Fine-tune / Model» poster.
const QWEN_URL = 'https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo';
const QWEN = post({
  title: 'Qwen-Image-2.1-Turbo',
  lead: 'Alibaba випустила Qwen-Image-2.1-Turbo, прискорену версію відкритої моделі генерації зображень.',
  text: 'Alibaba випустила Qwen-Image-2.1-Turbo, прискорену версію відкритої моделі генерації зображень. Вона малює картинку за 8 кроків замість 40.\n\nМодель відкрита: її можна завантажити з Hugging Face.\n\n→ Hugging Face',
  links: [{ text: 'Hugging Face', url: QWEN_URL }], sourceUrl: QWEN_URL, citedSourceUrl: QWEN_URL,
  imageUrls: [POSTER('17-fine-tune-model')],
});

// 12.10 19:17, AI Технології (golden ai-tekhnolohii:1043): a round-up of free courses with «Prompt» and «Skill».
const COURSES = post({
  id: 't:2', publishedAt: '2026-10-12T19:17:32+02:00', title: 'Безкоштовні курси з ШІ для старту',
  lead: 'Почати розбиратися в ШІ можна без платних курсів. Ось пʼять безкоштовних ресурсів для старту.',
  text: [
    'Почати розбиратися в ШІ можна без платних курсів. Ось пʼять безкоштовних ресурсів для старту.',
    '• Elements of AI (elementsofai.com). Курс від Університету Гельсінкі, пояснює, як працює ШІ, простими словами.\n'
    + '• OpenAI Academy (academy.openai.com). Безкоштовні уроки й промпти від OpenAI: від базових речей до роботи з ChatGPT.\n'
    + '• Google Machine Learning Crash Course (developers.google.com). Короткий курс від Google із відео й вправами.\n'
    + '• Kaggle Learn (kaggle.com/learn). Практичні мінікурси: Python, машинне навчання, дані.\n'
    + '• fast.ai (course.fast.ai). Курс про глибоке навчання для тих, хто вже трохи пише код.',
    'Усі курси безкоштовні.',
    '→ elementsofai.com',
  ].join('\n\n'),
  links: [
    { text: 'elementsofai.com', url: 'https://elementsofai.com' }, { text: 'academy.openai.com', url: 'https://academy.openai.com' },
    { text: 'developers.google.com', url: 'https://developers.google.com' }, { text: 'kaggle.com/learn', url: 'https://kaggle.com/learn' },
    { text: 'course.fast.ai', url: 'https://course.fast.ai' },
  ],
  sourceUrl: 'https://elementsofai.com/', citedSourceUrl: 'https://elementsofai.com/',
  media: { kind: 'photo', count: 2 }, imageUrls: [POSTER('01-prompt'), POSTER('12-skill')],
});

test('12.10 Qwen-Image news with the «Fine-tune / Model» poster → poster_mismatch error (a poster on news)', () => {
  assert.equal(isNewsPost(QWEN, NEWS_CARD), true);
  const f = mediaCheck.run(QWEN, ctx());
  assert.deepEqual(codes(f), ['poster_mismatch:error']);
  assert.match(f[0].message, /«Fine-tune \/ Model» на новині/);
});

test('12.10 free-courses round-up with «Prompt» and «Skill» → poster_mismatch warning (off topic, not news)', () => {
  assert.equal(isNewsPost(COURSES, NEWS_CARD), false, 'a list linking five sites is a round-up');
  const f = mediaCheck.run(COURSES, ctx());
  assert.deepEqual(codes(f), ['poster_mismatch:warning']);
  assert.match(f[0].message, /«Prompt» \(use_for: пост про один промпт/);
  assert.match(f[0].message, /«Skill» \(use_for: скіл/);
});

test('a poster on a non-news post whose topic matches use_for is fine; a mention in the head is enough', () => {
  const explainer = post({
    title: 'Що таке MCP-сервер', lead: 'MCP-сервер підключає AI-асистента до ваших сервісів.',
    text: 'MCP-сервер підключає AI-асистента до ваших сервісів.\n\nПояснюємо на прикладі календаря.', imageUrls: [POSTER('04-mcp-server')],
  });
  assert.deepEqual(mediaCheck.run(explainer, ctx()), []);
  assert.deepEqual(mediaCheck.run({ ...COURSES, imageUrls: [POSTER('02-community-prompt')], title: 'Добірка промптів для навчання' }, ctx()), []);
});

test('posters: only on non-news by story kind / topic / resource kind; a news post with a source is news', () => {
  const roundup = { ...QWEN, story: { kind: 'roundup' as const }, imageUrls: [POSTER('17-fine-tune-model')] };
  assert.equal(isNewsPost(roundup, NEWS_CARD), false);
  assert.deepEqual(codes(mediaCheck.run(roundup, ctx())), [], 'a digest about a model release may carry «Fine-tune / Model»');
  assert.equal(isNewsPost({ ...QWEN, topic: 'Глосарій: що таке файнтюнінг' }, NEWS_CARD), false);
  assert.equal(isNewsPost(QWEN, { style: { content_kind: 'explainer' } as AuditCard['style'] }), false);
  assert.equal(isNewsPost({ ...QWEN, sourceUrl: undefined, citedSourceUrl: undefined }, NEWS_CARD), false, 'no source → own post');
  assert.equal(isNewsPost(QWEN, undefined), true, 'no resource kind: a cited web source makes it news');
});

const PAGE = 'https://store.steampowered.com/news/app/123/view/456';
const OG = 'https://cdn.akamai.steamstatic.com/steam/apps/123/header.jpg?t=1728000000';
const NEWS = post({ text: 'Valve оновила гру.\n\n→ Steam', sourceUrl: PAGE, citedSourceUrl: PAGE, channel: 'Біржа Ігор' });

test('a news post with the source page\'s main image passes (noise in the URL tolerated)', () => {
  const sources = [{ url: PAGE, image: OG }];
  assert.deepEqual(mediaCheck.run({ ...NEWS, imageUrls: [OG] }, ctx({ sources })), []);
  assert.deepEqual(mediaCheck.run({ ...NEWS, imageUrls: ['http://cdn.akamai.steamstatic.com/steam/apps/123/header.jpg?t=1728000000&utm_source=x&w=1200'] }, ctx({ sources })), []);
});

test('a foreign image on a news post → image_not_from_source with the expected image', () => {
  const f = mediaCheck.run({ ...NEWS, imageUrls: ['https://images.unsplash.com/photo-gamer.jpg'] }, ctx({ sources: [{ url: `${PAGE}/`, image: OG }] }));
  assert.deepEqual(codes(f), ['image_not_from_source:error']);
  assert.match(f[0].message, /header\.jpg/);
});

test('the source page had no image → a news post goes without media (any image is image_not_from_source)', () => {
  const f = mediaCheck.run({ ...NEWS, imageUrls: ['https://cdn.example/stock.jpg'] }, ctx({ sources: [{ url: PAGE, image: null }] }));
  assert.deepEqual(codes(f), ['image_not_from_source:error']);
  assert.match(f[0].message, /немає зображення — новина йде без media, format text/);
  assert.deepEqual(mediaCheck.run({ ...NEWS, media: null }, ctx({ sources: [{ url: PAGE, image: null }] })), [], 'no media: fine');
});

test('never guesses: the source page not read in this run, or read without image info (a feed item) → nothing', () => {
  const foreign = { ...NEWS, imageUrls: ['https://cdn.example/stock.jpg'] };
  assert.deepEqual(mediaCheck.run(foreign, ctx()), []);
  assert.deepEqual(mediaCheck.run(foreign, ctx({ sources: [{ url: PAGE, title: 'feed item' }] })), []);
  assert.deepEqual(mediaCheck.run(foreign, ctx({ sources: [{ url: 'https://other.example/a', image: null }] })), []);
  assert.deepEqual(mediaCheck.run({ ...NEWS, imageUrls: undefined }, ctx({ sources: [{ url: PAGE, image: null }] })), [], 'an export has no image URLs');
});

test('lintPost: the spec\'s media and title reach the check; a foreign image blocks, the source image passes', () => {
  const card = { ...makeCard(), style: { content_kind: 'news' } } as ReturnType<typeof makeCard>;
  const spec = makeSpec({ hashtags: [], source: { url: PAGE, label: 'Steam' }, media: [{ url: 'https://images.nasa.gov/ring.jpg' }] });
  const audit = auditPostFromSpec(spec, { id: 's', channel: 'c', publishedAt: '2026-10-12T10:00:00Z', timezone: 'Europe/Kyiv' });
  assert.deepEqual(audit.imageUrls, ['https://images.nasa.gov/ring.jpg']);
  assert.equal(audit.title, spec.title);
  const integrity = { ctx: { sources: [{ url: PAGE, image: OG }] } };
  assert.ok(lintPost(spec, card, integrity).errors.some((e) => e.code === 'image_not_from_source'));
  const ok = lintPost(makeSpec({ hashtags: [], source: { url: PAGE, label: 'Steam' }, media: [{ url: OG }] }), card, integrity);
  assert.ok(!ok.errors.some((e) => e.code === 'image_not_from_source' || e.code === 'poster_mismatch'), JSON.stringify(ok.errors));
  const poster = lintPost(makeSpec({ hashtags: [], source: { url: PAGE, label: 'Steam' }, media: [{ url: POSTER('08-agent') }] }), card, {});
  assert.ok(poster.errors.some((e) => e.code === 'poster_mismatch'), 'a poster on news blocks even without the page');
});

test('posters: recognised by file name on any host; the catalogue equals docs/data/ai-posters.json', () => {
  assert.equal(posterOf(POSTER('12-skill'))?.title, 'Skill');
  assert.equal(posterOf('https://cdn.example/x/17-fine-tune-model.png?v=2')?.title, 'Fine-tune / Model');
  assert.equal(posterOf('https://cdn.example/x/hero.png'), null);
  assert.equal(posterOf('not a url'), null);
  const file = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', '..', '..', '..', 'docs', 'data', 'ai-posters.json'), 'utf8')) as Array<{ id: string; title: string; use_for: string }>;
  assert.deepEqual(AI_POSTERS.map((p) => [p.id, p.title, p.useFor]), file.map((p) => [p.id, p.title, p.use_for]));
  for (const p of AI_POSTERS) assert.ok(p.keywords.length, `${p.id} has keywords`);
});

test('posterFitsTopic: a keyword in the head, or twice in the text; one passing mention is not the topic', () => {
  const prompt = AI_POSTERS.find((p) => p.id === '01-prompt')!;
  assert.equal(posterFitsTopic(prompt, { head: ['Курси з ШІ'], text: 'Уроки й промпти від OpenAI.' }), false);
  assert.equal(posterFitsTopic(prompt, { head: ['Курси з ШІ'], text: 'Промпт для листа. Ще один промпт для резюме.' }), true);
  assert.equal(posterFitsTopic(prompt, { head: ['Один промпт для планування тижня'], text: '' }), true);
  const memory = AI_POSTERS.find((p) => p.id === '13-memory')!;
  assert.equal(posterFitsTopic(memory, { head: ["Пам'ять агента: як вона працює"], text: '' }), true, 'apostrophe variants');
});

test('normalizeImageUrl: scheme, www, case of the host, fragment, tracking and size params; the path stays', () => {
  assert.equal(normalizeImageUrl('HTTPS://WWW.Example.COM/img/Hero.jpg#x'), 'example.com/img/Hero.jpg');
  assert.equal(normalizeImageUrl('http://example.com:443/a.jpg?utm_source=tg&w=800&h=600&id=7&fit=crop'), 'example.com/a.jpg?id=7');
  assert.equal(normalizeImageUrl('https://example.com/a.jpg?b=2&a=1'), 'example.com/a.jpg?a=1&b=2');
  assert.ok(sameImage('https://cdn.example/a.jpg?width=1200&quality=80', 'http://www.cdn.example/a.jpg'));
  assert.ok(!sameImage('https://cdn.example/a-1200x630.jpg', 'https://cdn.example/a.jpg'), 'a size in the file name is another image');
  assert.ok(!sameImage('https://cdn.example/a.jpg?id=1', 'https://cdn.example/a.jpg?id=2'));
  assert.equal(normalizeImageUrl(' Not A URL '), 'not a url');
});
