import { test } from 'node:test';
import assert from 'node:assert/strict';
import { datesCheck, freshnessHoursOf } from './checks/dates';
import { lintPost } from '../lint-post';
import { makeCard, makeSpec } from '../testing/fixtures';
import type { AuditCard, AuditContext, AuditPost } from './types';

const post = (text: string, o: Partial<AuditPost> = {}): AuditPost => ({
  id: 't:1', channel: 'c', publishedAt: '2026-10-08T11:00:00Z', timezone: 'Europe/Kyiv',
  text, links: [], buttons: [], hashtags: [], media: null, ...o,
});
const news: AuditCard = { timezone: 'Europe/Kyiv', style: { content_kind: 'news' } };
const games: AuditCard = { timezone: 'Europe/Kyiv', style: { content_kind: 'games' } };
const run = (p: AuditPost, ctx: Partial<AuditContext> = {}) => datesCheck.run(p, { previous: [], ...ctx });
const codes = (p: AuditPost, ctx: Partial<AuditContext> = {}) => run(p, ctx).map((f) => `${f.code}:${f.level}`);

test('T5 date_relative_mismatch: «вже завтра, 12 жовтня» in a post of 10.10 (Fitbit); a matching pair is clean', () => {
  const fitbit = post('Google опублікував фото з підписом «Get an Edge on your health. 10.12.26». Реліз очікується вже завтра, 12 жовтня.', { publishedAt: '2026-10-10T10:00:18Z' });
  const f = run(fitbit);
  assert.deepEqual(f.map((x) => x.code), ['date_relative_mismatch']);
  assert.equal(f[0].level, 'error');
  assert.match(f[0].message, /11\.10.*12 жовтня/);
  assert.deepEqual(codes(post('Реліз уже завтра, 9 жовтня.')), []);
  assert.deepEqual(codes(post('Сьогодні (08.10) старт.')), []);
});

test('T5 weekday_mismatch: «у вівторок, 14 жовтня» (14.10.2026 is a Wednesday); «у вівторок, 13 жовтня» is right', () => {
  assert.deepEqual(codes(post('Apple у вівторок, 14 жовтня, представить хаб.')), ['weekday_mismatch:error']);
  assert.deepEqual(codes(post('Apple у вівторок, 13 жовтня, представить хаб.')), []);
  assert.deepEqual(codes(post('Фінал 14 жовтня (середа).')), []);
  assert.deepEqual(codes(post('Завтра, у середу, старт.')), ['weekday_mismatch:error'], 'завтра of 08.10 is a Friday');
  assert.deepEqual(codes(post('Анонс зробили у вівторок. 14 жовтня — реліз.')), [], 'a weekday in another sentence');
});

test('T5 relative_date_unanchored: «з завтра» in news without a date; anchored or non-news is silent', () => {
  const openai = post('Безкоштовні користувачі й тариф Go — з завтра (модель GPT-6 Luna).', { sourceUrl: 'https://www.theverge.com/ai/1007276/openai' });
  assert.deepEqual(codes(openai, { card: news }), ['relative_date_unanchored:warning']);
  assert.deepEqual(codes(openai), ['relative_date_unanchored:warning'], 'no kind: a post with a source line counts as news');
  assert.deepEqual(codes(post('Тариф Go — з завтра, 9 жовтня.'), { card: news }), []);
  assert.deepEqual(codes(post('Залиште тісто до завтра.')), [], 'no kind, no source: not news');
  assert.deepEqual(codes(openai, { card: { style: { content_kind: 'evergreen' } } }), []);
  assert.deepEqual(codes(post('Сьогодні вийшло оновлення.'), { card: news }), [], '«сьогодні» is read the same day');
});

test('T5 deal_expired / deal_expiring: a giveaway «до 8 жовтня» posted 08.10 19:00 is over; a time is exact', () => {
  const bridge = post('Дві безкоштовні роздачі. Spooky Cats — ключ безкоштовно до 9 жовтня. Bridge Constructor Studio безкоштовна до 8 жовтня: деталі', { publishedAt: '2026-10-08T16:00:15Z' });
  const f = run(bridge);
  assert.deepEqual(f.map((x) => [x.code, x.level]), [['deal_expired', 'error']], '«до 9 жовтня» (tomorrow, time unknown) is fine');
  assert.match(f[0].excerpt!, /8 жовтня/);

  const epic = 'Обидві гри можна додати в бібліотеку безкоштовно до 15 жовтня 17:00 за Києвом.';
  assert.deepEqual(codes(post(epic, { publishedAt: '2026-10-15T09:00:00Z' })), ['deal_expiring:warning'], '12:00 Kyiv: 5 h left');
  assert.deepEqual(codes(post(epic, { publishedAt: '2026-10-15T07:00:00Z' })), [], '10:00 Kyiv: 7 h left');
  assert.deepEqual(codes(post(epic, { publishedAt: '2026-10-15T14:30:00Z' })), ['deal_expired:error'], '17:30 Kyiv');
  assert.deepEqual(codes(post('Обидві безкоштовні до завтра, 8 жовтня, 15:00.', { publishedAt: '2026-10-07T12:30:35Z' })), []);
  assert.deepEqual(codes(post('Реєстрація на конференцію до 8 жовтня.', { publishedAt: '2026-10-08T16:00:00Z' })), [], 'not a deal');
  assert.deepEqual(codes(post('Знижка діяла до 8 жовтня 2024 року.', { publishedAt: '2026-10-08T16:00:00Z' })), [], 'history');
  assert.deepEqual(codes(post('Години до 15:00 — забирай безкоштовно, роздача сьогодні закривається.', { publishedAt: '2026-10-08T06:18:00Z' })), [],
    'a time without a day is not a deadline the check reads (the last-24-h reminder is allowed)');
});

test('T5 deal_expiring across the DST end: «до 26 жовтня 00:30» posted 25.10 21:00 Kyiv (UTC+2) has 3.5 h', () => {
  const f = run(post('Роздача гри безкоштовно до 26 жовтня 00:30.', { publishedAt: '2026-10-25T19:00:00Z' }));
  assert.deepEqual(f.map((x) => x.code), ['deal_expiring']);
  assert.match(f[0].message, /3\.5 год/);
});

test('T5 stale_now_word: «щойно» over a source or a first post older than 24 h', () => {
  const mistral = post('Mistral щойно показала Le Chonk.\n\nДеталі релізу — у огляді MarkTechPost.', {
    links: [{ text: 'огляді MarkTechPost', url: 'https://www.marktechpost.com/2026/10/06/mistral-ai-releases-mistral-large-4-le-chonk/' }],
    publishedAt: '2026-10-08T10:30:46Z',
  });
  const f = run(mistral);
  assert.deepEqual(f.map((x) => [x.code, x.level]), [['stale_now_word', 'warning']], 'the URL says 06.10');
  assert.match(f[0].message, /джерелу 47 год/);

  const page = post('OpenAI щойно випустила модель.', { sourceUrl: 'https://openai.com/index/introducing-new-model', publishedAt: '2026-10-08T11:00:00Z' });
  assert.deepEqual(codes(page), [], 'no date known: silent');
  assert.deepEqual(codes(page, { sources: [{ url: 'https://openai.com/index/introducing-new-model/', publishedAt: '2026-10-08T08:00:00Z' }] }), []);
  assert.deepEqual(codes(page, { sources: [{ url: 'https://openai.com/index/introducing-new-model', publishedAt: '2026-10-06T08:00:00Z' }] }), ['stale_now_word:warning']);

  const first = post('Огляд моделі.', { sourceUrl: 'https://openai.com/index/introducing-new-model', publishedAt: '2026-10-07T05:00:00Z' });
  const story = run(page, { previous: [first] });
  assert.deepEqual(story.map((x) => x.code), ['stale_now_word']);
  assert.match(story[0].message, /перший пост про це вийшов 30 год тому/);
  const home = post('Огляд.', { sourceUrl: 'https://openai.com/', publishedAt: '2026-10-05T05:00:00Z' });
  assert.deepEqual(codes(post('OpenAI щойно випустила модель.', { sourceUrl: 'https://openai.com/' }), { previous: [home] }), [], 'a site root is not one story');
});

test('T5 stale_source: news 36 h, games 72 h, page date over the URL date; exempt and unknown kinds are silent', () => {
  assert.equal(freshnessHoursOf(news), 36);
  assert.equal(freshnessHoursOf(games), 72);
  assert.equal(freshnessHoursOf({ style: { content_kind: 'news', freshness_hours: 12 } }), 12);
  assert.equal(freshnessHoursOf({ style: { content_kind: 'explainer', freshness_hours: 12 } }), null);
  assert.equal(freshnessHoursOf({}), null);

  const ps = post('DMZ — це extraction-шутер.', { sourceUrl: 'https://blog.playstation.com/2026/10/05/everything-you-need-to-know-about-dmz/', publishedAt: '2026-10-09T07:31:04Z' });
  const f = run(ps, { card: games });
  assert.deepEqual(f.map((x) => [x.code, x.level]), [['stale_source', 'warning']]);
  assert.match(f[0].message, /92 год.*72 год/);
  assert.deepEqual(codes(ps), [], 'no resource kind: no threshold');
  assert.deepEqual(codes(ps, { card: { style: { content_kind: 'evergreen' } } }), []);
  assert.deepEqual(codes(ps, { card: games, sources: [{ url: ps.sourceUrl!, publishedAt: '2026-10-08T15:00:00Z' }] }), [], 'the page says 08.10 (an update)');

  const verge = post('Новина.', { sourceUrl: 'https://www.theverge.com/tech/1008918/google-fitbit-edge', publishedAt: '2026-10-10T10:00:00Z' });
  assert.deepEqual(codes(verge, { card: news }), [], 'no date in the URL, nothing read');
  assert.deepEqual(codes(verge, { card: news, sources: [{ url: verge.sourceUrl!, publishedAt: '2026-10-08T20:00:00Z' }] }), ['stale_source:warning']);
  assert.deepEqual(codes(verge, { card: news, sources: [{ url: verge.sourceUrl!, publishedAt: '2026-10-09T20:00:00Z' }] }), []);
});

test('T5 through lintPost: the publish time and the run\'s sources decide; deal_expired blocks, staleness warns', () => {
  const card = makeCard({ formats: { text: 1 } });
  const deal = makeSpec({ format: 'text', media: [], body: [{ type: 'p', text: 'Гра безкоштовна в Epic до 8 жовтня, забирайте.' }] });
  const late = lintPost(deal, card, { publishedAt: '2026-10-08T16:00:00Z', timezone: 'Europe/Kyiv' });
  assert.equal(late.ok, false);
  assert.ok(late.errors.some((e) => e.code === 'deal_expired'));
  assert.ok(lintPost(deal, card, { publishedAt: '2026-10-07T09:00:00Z', timezone: 'Europe/Kyiv' }).ok);

  const stale = makeSpec({ format: 'text', media: [], body: [{ type: 'p', text: 'NASA щойно показала знімок.' }] });
  const r = lintPost(stale, card, {
    publishedAt: '2026-10-08T12:00:00Z', timezone: 'Europe/Kyiv',
    ctx: { sources: [{ url: 'https://nasa.gov/ring', publishedAt: '2026-10-05T12:00:00Z' }], card: { style: { content_kind: 'news' } } },
  });
  assert.ok(r.ok);
  assert.deepEqual(r.warnings.filter((w) => w.code.startsWith('stale_')).map((w) => w.code), ['stale_now_word', 'stale_source']);
});
