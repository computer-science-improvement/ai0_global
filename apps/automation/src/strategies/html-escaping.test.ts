// 002 T003 — everything from scraped data / DB rows / URLs that lands in a
// Telegram HTML caption must be escaped; hrefs must also escape `"`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecipesStrategy } from './recipes/recipes.strategy';
import { QuotesStrategy } from './quotes/quotes.strategy';
import { GameChannelStrategy } from './game-channel/game-channel.strategy';
import { MoviesStrategy } from './movies/movies.strategy';
import { SpaceStrategy } from './space/space.strategy';
import { DailyPhotoStrategy } from './daily-photo/daily-photo.strategy';
import { Ai0NewsStrategy } from './ai0-news/ai0-news.strategy';
import { UaNewsStrategy } from './ua-news/ua-news.strategy';

const EVIL_URL = 'https://ex.com/a?x=1&y="2"><b>pwn</b>';
const EVIL_URL_ATTR = 'https://ex.com/a?x=1&amp;y=&quot;2&quot;&gt;&lt;b&gt;pwn&lt;/b&gt;';

/** Every href value must be free of raw `"`, `<`, `>` and bare `&`. */
function assertSafeHrefs(html: string) {
  for (const m of html.matchAll(/href="([^"]*)"/g)) {
    assert.doesNotMatch(m[1], /[<>]/, `href has raw < or >: ${m[1]}`);
    assert.doesNotMatch(m[1], /&(?!amp;|quot;|lt;|gt;)/, `href has a bare &: ${m[1]}`);
  }
  // An unescaped `"` inside an href would end the attribute early: every
  // anchor tag must be exactly one quoted href with nothing after it.
  for (const tag of html.match(/<a [^>]*>/g) ?? []) {
    assert.match(tag, /^<a href="[^"<>]*">$/, `malformed anchor: ${tag}`);
  }
}

function proto<T>(cls: new (...a: any[]) => T): any {
  return Object.create(cls.prototype);
}

test('recipes.buildCaption escapes title, category, nutrition and ingredients', () => {
  const s = proto(RecipesStrategy);
  const out: string = s.buildCaption('Fish & <Chips>', 'Brit<ish>', '🔥 100 ккал', 'Salt & pepper\n<1> egg');
  assert.ok(out.includes('<b>Fish &amp; &lt;Chips&gt;</b>'));
  assert.ok(out.includes('Brit&lt;ish&gt;'));
  assert.ok(out.includes('Salt &amp; pepper'));
  assert.ok(out.includes('&lt;1&gt; egg'));
  assert.doesNotMatch(out.replace(/<\/?b>/g, ''), /<|>(?![^&]*;)/);
});

test('recipes.buildCaption fits escaped ingredients within the 1024 caption limit', () => {
  const s = proto(RecipesStrategy);
  const ingredients = Array.from({ length: 200 }, (_, i) => `item ${i} & <more>`).join('\n');
  const out: string = s.buildCaption('T', null, ingredients, '');
  assert.ok(out.length <= 1024, `caption is ${out.length} chars`);
  assert.doesNotMatch(out, /&[a-z]*$/);
});

test('recipes.buildReply escapes instructions and never cuts an entity in half', () => {
  const s = proto(RecipesStrategy);
  assert.ok(s.buildReply('Mix <a> & <b>').includes('Mix &lt;a&gt; &amp; &lt;b&gt;'));
  const long: string = s.buildReply('&'.repeat(5000)); // one huge line, no newline to cut at
  assert.ok(long.length <= 4096);
  assert.doesNotMatch(long.replace(/…$/, ''), /&[a-z]{0,3}$/);
});

test('recipes.buildLinkCaption escapes `"` in the Telegraph href', () => {
  const s = proto(RecipesStrategy);
  assertSafeHrefs(s.buildLinkCaption('T', null, EVIL_URL, ''));
});

test('quotes: text and author are escaped', async () => {
  let published = '';
  const s = new QuotesStrategy(
    { register() {} } as any,
    {
      getRandom: async () => ({ id: 'q1', text: 'Less <is> more & better', author: 'A <b>Bold</b> & Co', category: null, url: null }),
      isBirthdayToday: async () => false,
      markPosted: async () => {},
    } as any,
    { publish: async (p: any) => { published = p.text; return '1'; } } as any,
    { notifyPublished: async () => {} } as any,
    { insert: async () => {} } as any,
    { afterPublish: async () => {} } as any,
  );
  await s.execute('@q', {});
  assert.equal(published, '«Less &lt;is&gt; more &amp; better»\n\n— <i>A &lt;b&gt;Bold&lt;/b&gt; &amp; Co</i>');
});

test('game-channel.appendLink escapes the href', () => {
  const s = proto(GameChannelStrategy);
  const out: string = s.appendLink('Body', { source: EVIL_URL });
  assert.ok(out.includes(`<a href="${EVIL_URL_ATTR}">`));
  assertSafeHrefs(out);
});

const claude = (text: string) => ({ available: true, chat: async () => text });
const validator = { check: () => true, validate: () => ({ valid: true }) };
const AI = 'Нормальний опис фільму з достатньою кількістю символів для валідатора.';

test('movies: title is escaped and the TMDB href escapes `"`', async () => {
  const s = new MoviesStrategy(claude(AI) as any, validator as any, { register() {} } as any, {} as any, {} as any);
  const post: any = await s.generate({
    sourceUrl: EVIL_URL, title: 't', contentType: 'movie',
    data: { title: 'Tom & <Jerry>', source: EVIL_URL, releaseDate: '2024-01-01', voteAverage: 7, voteCount: 10, genreNames: [], imageUrl: null },
  }, {});
  assert.ok(post.text.includes('<b>Tom &amp; &lt;Jerry&gt;</b>'));
  assertSafeHrefs(post.text);
});

test('space: source href escapes `"`', async () => {
  const s = new SpaceStrategy(claude(AI) as any, validator as any, { register() {} } as any, {} as any, {} as any);
  const post: any = await s.generate({
    sourceUrl: EVIL_URL, title: 't', contentType: 'news', data: { source: EVIL_URL, imageUrl: null },
  }, {});
  assertSafeHrefs(post.text);
});

test('daily-photo: APOD title and copyright are escaped', async () => {
  const s = new DailyPhotoStrategy(claude(AI) as any, validator as any, { register() {} } as any, {} as any);
  const post: any = await s.generate({
    sourceUrl: 'https://apod', title: 't', contentType: 'apod',
    data: { title: 'M31 & <Andromeda>', copyright: 'J. <Doe> & Co', imageUrl: 'https://i', date: '2026-01-01' },
  }, {});
  assert.ok(post.text.startsWith('<b>M31 &amp; &lt;Andromeda&gt;</b>'));
  assert.ok(post.text.includes('© J. &lt;Doe&gt; &amp; Co'));
});

test('ai0-news / ua-news buildMessage escape `"` in the source href', () => {
  for (const cls of [Ai0NewsStrategy, UaNewsStrategy] as any[]) {
    const s = proto(cls);
    const out: string = s.buildMessage('Текст поста.', { title: 't', content: null, image: null, source: EVIL_URL, tags: ['ai'], isoDate: '' });
    assert.ok(out.includes(`href="${EVIL_URL_ATTR}"`), `${cls.name}: ${out}`);
    assertSafeHrefs(out);
  }
});
