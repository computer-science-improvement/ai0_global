// Spec 009 T002: carousel, longread and video formats (render + lint).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTelegram } from './render-telegram';
import { lintPost } from './lint-post';
import { POST_FORMATS, SUPPORTED_FORMATS } from './post-spec';
import { makeCard, makeSpec } from './testing/fixtures';

const card = (over = {}) => makeCard({ formats: { text: 1, photo: 1, carousel: 1, longread: 1, video: 1 }, ...over });
const codes = (spec: any, c = card()) => lintPost(spec, c).errors.map((e) => e.code);

const SLIDES = [
  { title: 'Крок 1', text: 'Розігрійте духовку до 180 градусів і змастіть форму.' },
  { title: 'Крок 2', text: 'Змішайте борошно з яйцями до однорідності.', image: 'https://img.example/2.jpg' },
];
const carousel = (over: Record<string, unknown> = {}) => makeSpec({ format: 'carousel', media: [], slides: SLIDES, ...over });

const LONG_BLOCKS = [
  { type: 'lead', text: 'Як працює телескоп Вебба' },
  { type: 'p', text: 'Дзеркало **6,5 метра** складається з 18 сегментів. Детальніше — [NASA](https://nasa.gov/webb).' },
  { type: 'list', items: ['Інфрачервоний діапазон', 'Орбіта навколо L2'] },
  { type: 'quote', text: 'Ми побачили перші галактики.' },
];
const longread = (over: Record<string, unknown> = {}) => makeSpec({
  format: 'longread', media: [],
  body: [{ type: 'lead', text: 'Телескоп Вебба: що всередині' }, { type: 'p', text: 'Розбираємо головні вузли обсерваторії простими словами.' }],
  longread: { title: 'Як влаштований телескоп Вебба', blocks: LONG_BLOCKS },
  ...over,
});

const video = (over: Record<string, unknown> = {}) => makeSpec({ format: 'video', media: [{ url: 'https://cdn.example/clip.mp4', kind: 'video' }], ...over });

test('every PostSpec format is supported now', () => {
  assert.deepEqual([...SUPPORTED_FORMATS], [...POST_FORMATS]);
  for (const s of [carousel(), longread(), video()]) assert.ok(!codes(s).includes('format_not_supported_yet'));
});

// ── carousel ────────────────────────────────────────────────────────────────

test('carousel: green lint; preview describes the slides; unprepared render has no photos', () => {
  const r = lintPost(carousel(), card());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const out = renderTelegram(carousel(), card());
  const m = out.messages[0] as any;
  assert.equal(m.method, 'sendMediaGroup');
  assert.deepEqual(m.photos, []);
  assert.match(out.preview, /Карусель: 2 слайди/);
  assert.match(out.preview, /1\. <b>Крок 1<\/b> — Розігрійте духовку/);
  assert.match(out.preview, /🖼 https:\/\/img\.example\/2\.jpg/);
});

test('carousel: prepared slide URLs become the media group, caption on the first', () => {
  const out = renderTelegram(carousel(), card(), { slideUrls: ['https://cdn.example/s1.png', 'https://cdn.example/s2.png'] });
  const m = out.messages[0] as any;
  assert.deepEqual(m.photos, ['https://cdn.example/s1.png', 'https://cdn.example/s2.png']);
  assert.match(m.caption, /<b>Телескоп Вебб/);
});

test('carousel lint: slide count, no media, no buttons, body, language, banned terms', () => {
  assert.ok(codes(carousel({ slides: [SLIDES[0]] })).includes('slides_count'));
  assert.ok(codes(carousel({ slides: undefined })).includes('slides_count'));
  assert.ok(codes(carousel({ media: [{ url: 'https://a.example/1.jpg' }] })).includes('media_count'));
  assert.ok(codes(carousel({ cta: { url: 'https://x.example', label: 'Go' } })).includes('album_with_buttons'));
  assert.ok(codes(carousel({ body: [] })).includes('empty_body'));
  assert.ok(codes(carousel({ slides: [{ title: 'Step one', text: 'Preheat the oven and grease the baking form well.' }, { title: 'Step two', text: 'Mix the flour with the eggs until it is smooth and even.' }], body: [] })).includes('not_ukrainian'));
  assert.ok(codes(carousel({ slides: [SLIDES[0], { title: 'Підсумок', text: 'Варто зазначити, що тісто має відпочити.' }] })).includes('banned_term'));
});

test('slides on a non-carousel post are ignored with a warning', () => {
  const r = lintPost(makeSpec({ slides: SLIDES }), card());
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.code === 'slides_ignored'));
});

// ── longread ────────────────────────────────────────────────────────────────

test('longread: green lint; preview shows teaser and outline; no page URL yet', () => {
  const r = lintPost(longread(), card());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const out = renderTelegram(longread(), card());
  const m = out.messages[0] as any;
  assert.equal(m.method, 'sendMessage');
  assert.equal(m.preview, null);
  assert.match(out.preview, /📖 Лонгрід «Як влаштований телескоп Вебба»: 4 блоки/);
  assert.match(out.preview, /Як працює телескоп Вебба/);
});

test('longread: the prepared Telegraph URL gives a large preview and a "Читати" button first', () => {
  const out = renderTelegram(longread({ cta: { url: 'https://x.example', label: 'Сайт' } }), card(), { longreadUrl: 'https://telegra.ph/Webb-10-01' });
  const m = out.messages[0] as any;
  assert.deepEqual(m.preview, { url: 'https://telegra.ph/Webb-10-01', showAboveText: true });
  assert.deepEqual(m.buttons[0], [{ text: 'Читати', url: 'https://telegra.ph/Webb-10-01' }]);
  assert.deepEqual(m.buttons[1], [{ text: 'Сайт', url: 'https://x.example' }]);
});

test('longread lint: missing longread, teaser too long, empty body, longread text checked', () => {
  assert.ok(codes(longread({ longread: undefined })).includes('longread_missing'));
  assert.ok(codes(longread({ body: [{ type: 'p', text: 'а'.repeat(700) }] })).includes('teaser_too_long'));
  assert.ok(codes(longread({ body: [] })).includes('empty_body'));
  assert.ok(codes(longread({ longread: { title: 'Лонгрід', blocks: [{ type: 'p', text: 'Підсумовуючи, телескоп дуже важливий для науки.' }] } })).includes('banned_term'));
  assert.ok(codes(longread({ media: [{ url: 'https://a.example/1.jpg' }, { url: 'https://a.example/2.jpg' }] })).includes('media_count'));
});

// ── video ───────────────────────────────────────────────────────────────────

test('video → sendVideo with caption; placement controls the caption position', () => {
  const r = lintPost(video(), card());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const m = renderTelegram(video({ placement: 'below' }), card()).messages[0] as any;
  assert.equal(m.method, 'sendVideo');
  assert.equal(m.video, 'https://cdn.example/clip.mp4');
  assert.equal(m.captionAboveMedia, true);
});

test('video lint: one media, direct video URL, caption ≤ 1024', () => {
  assert.ok(codes(video({ media: [] })).includes('media_count'));
  assert.ok(codes(video({ media: [{ url: 'https://youtube.com/watch?v=1' }] })).includes('video_url'));
  assert.ok(!codes(video({ media: [{ url: 'https://cdn.example/clip.MP4?sig=1' }] })).includes('video_url'));
  assert.ok(!codes(video({ media: [{ url: 'https://cdn.example/stream', kind: 'video' }] })).includes('video_url'));
  assert.ok(codes(video({ body: [{ type: 'p', text: 'а'.repeat(1100) }] })).includes('too_long'));
});

test('a video media item is rejected outside the video format', () => {
  assert.ok(codes(makeSpec({ media: [{ url: 'https://cdn.example/clip.mp4', kind: 'video' }] })).includes('media_kind'));
});
