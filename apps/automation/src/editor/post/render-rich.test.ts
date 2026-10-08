import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlockSchema } from './post-spec';
import { blockToRich, inlineToRich, richStats, richToPlain } from './render-rich';
import { composeText, renderTelegram, wantsRich } from './render-telegram';
import { lintPost } from './lint-post';
import { makeCard, makeSpec } from './testing/fixtures';

// Spec 033 T2: PostSpec → Bot API 10.1 rich message (InputRichMessage.blocks) and its HTML fallback.

const rich = (b: unknown) => blockToRich(BlockSchema.parse(b));

test('inlineToRich: markdown-lite → RichText (bold, italic, url, spoiler, nesting, escaping)', () => {
  assert.equal(inlineToRich('просто текст'), 'просто текст');
  assert.equal(inlineToRich('a < b & c'), 'a < b & c');
  assert.deepEqual(inlineToRich('**жирний** і _курсив_'), [{ type: 'bold', text: 'жирний' }, ' і ', { type: 'italic', text: 'курсив' }]);
  assert.deepEqual(inlineToRich('див. [NASA](https://nasa.gov/a?b=1&c=2)'), ['див. ', { type: 'url', text: 'NASA', url: 'https://nasa.gov/a?b=1&c=2' }]);
  assert.deepEqual(inlineToRich('||відповідь||'), { type: 'spoiler', text: 'відповідь' });
  assert.deepEqual(inlineToRich('**[жирне посилання](https://x.example)**'), { type: 'bold', text: { type: 'url', text: 'жирне посилання', url: 'https://x.example' } });
});

test('blockToRich: every block in the exact Bot API shape (snapshot)', () => {
  assert.deepEqual(rich({ type: 'lead', text: 'Гачок' }), [{ type: 'paragraph', text: { type: 'bold', text: 'Гачок' } }]);
  assert.deepEqual(rich({ type: 'p', text: 'Абзац' }), [{ type: 'paragraph', text: 'Абзац' }]);
  assert.deepEqual(rich({ type: 'quote', text: 'Цитата' }), [{ type: 'blockquote', blocks: [{ type: 'paragraph', text: 'Цитата' }] }]);
  assert.deepEqual(rich({ type: 'heading', level: 1, text: 'Розділ' }), [{ type: 'heading', text: 'Розділ', size: 1 }]);
  assert.deepEqual(rich({ type: 'list', items: ['а', 'б'] }), [{ type: 'list', items: [
    { blocks: [{ type: 'paragraph', text: 'а' }] }, { blocks: [{ type: 'paragraph', text: 'б' }] },
  ] }]);
  assert.deepEqual(rich({ type: 'olist', items: ['перше', 'друге'] }), [{ type: 'list', items: [
    { blocks: [{ type: 'paragraph', text: 'перше' }], type: '1', value: 1 },
    { blocks: [{ type: 'paragraph', text: 'друге' }], type: '1', value: 2 },
  ] }]);
  assert.deepEqual(rich({ type: 'table', header: ['Модель', 'Ціна'], rows: [['A55', '**15 999**'], ['Pixel']] }), [{
    type: 'table', is_bordered: true,
    cells: [
      [{ text: 'Модель', is_header: true }, { text: 'Ціна', is_header: true }],
      [{ text: 'A55' }, { text: { type: 'bold', text: '15 999' } }],
      [{ text: 'Pixel' }, { text: '' }],
    ],
  }]);
  assert.deepEqual(rich({ type: 'math', expression: '\\frac{a}{b}' }), [{ type: 'mathematical_expression', expression: '\\frac{a}{b}' }]);
  assert.deepEqual(rich({ type: 'divider' }), [{ type: 'divider' }]);
  assert.deepEqual(rich({ type: 'footer', text: 'Дрібно' }), [{ type: 'footer', text: 'Дрібно' }]);
  assert.deepEqual(rich({ type: 'code', text: 'ls -la', language: 'bash' }), [{ type: 'pre', text: 'ls -la', language: 'bash' }]);
  assert.deepEqual(rich({ type: 'code', text: 'ls' }), [{ type: 'pre', text: 'ls' }]);
  assert.deepEqual(rich({ type: 'details', title: 'Більше', body: [{ type: 'p', text: 'Текст' }] }),
    [{ type: 'details', summary: 'Більше', blocks: [{ type: 'paragraph', text: 'Текст' }] }]);
});

const BODY = [
  { type: 'lead', text: 'Три смартфони до 20 000 грн' },
  { type: 'heading', level: 2, text: 'Порівняння' },
  { type: 'table', header: ['Модель', 'Ціна'], rows: [['A55', '15 999'], ['Pixel 8a', '19 999']] },
  { type: 'olist', items: ['Визначте бюджет', 'Порівняйте камери'] },
];

test('wantsRich: auto → only with rich blocks; prefer → any text post; never / unsupported / album → HTML', () => {
  const plain = makeSpec({ format: 'text', media: [] });
  const withRich = makeSpec({ format: 'text', media: [], body: BODY });
  assert.equal(wantsRich(plain, makeCard()), false);
  assert.equal(wantsRich(withRich, makeCard()), true);
  assert.equal(wantsRich(plain, makeCard({ richPref: 'prefer' })), true);
  assert.equal(wantsRich(withRich, makeCard({ richPref: 'never' })), false);
  assert.equal(wantsRich(withRich, makeCard({ richUnsupported: true })), false);
  assert.equal(wantsRich(makeSpec({ format: 'album', body: BODY, media: [{ url: 'https://i.example/1.jpg' }, { url: 'https://i.example/2.jpg' }] }), makeCard()), false);
  assert.equal(wantsRich(makeSpec({ format: 'quiz', body: [], media: [], poll: { question: 'Q?', options: ['a', 'b'], correct_index: 0 } }), makeCard({ richPref: 'prefer' })), false);
});

test('text post with rich blocks → one sendRichMessage; the fallback is today\'s HTML render; preview stays HTML', () => {
  const spec = makeSpec({ format: 'text', media: [], body: BODY });
  const card = makeCard({ footer: 'Підписуйся: @chan' });
  const r = renderTelegram(spec, card);
  assert.equal(r.messages.length, 1);
  const m = r.messages[0] as any;
  assert.equal(m.method, 'sendRichMessage');
  assert.deepEqual(m.blocks, [
    { type: 'paragraph', text: { type: 'bold', text: 'Три смартфони до 20 000 грн' } },
    { type: 'heading', text: 'Порівняння', size: 2 },
    { type: 'table', is_bordered: true, cells: [
      [{ text: 'Модель', is_header: true }, { text: 'Ціна', is_header: true }],
      [{ text: 'A55' }, { text: '15 999' }],
      [{ text: 'Pixel 8a' }, { text: '19 999' }],
    ] },
    { type: 'list', items: [
      { blocks: [{ type: 'paragraph', text: 'Визначте бюджет' }], type: '1', value: 1 },
      { blocks: [{ type: 'paragraph', text: 'Порівняйте камери' }], type: '1', value: 2 },
    ] },
    { type: 'paragraph', text: ['→ ', { type: 'url', text: 'NASA', url: 'https://nasa.gov/ring' }] },
    { type: 'paragraph', text: 'Підписуйся: @chan' },
    { type: 'paragraph', text: '#космос' },
  ]);
  assert.deepEqual(m.fallback, { method: 'sendMessage', text: composeText(spec, card), preview: null, buttons: [] });
  assert.equal(r.preview, composeText(spec, card));
  assert.match(m.fallback.text, /<pre>Модель   \| Ціна\n/);
});

test('photo post: the image is a photo block above or below; the fallback is the sendPhoto', () => {
  const above = renderTelegram(makeSpec({ body: BODY }), makeCard()).messages[0] as any;
  assert.equal(above.method, 'sendRichMessage');
  assert.deepEqual(above.blocks[0], { type: 'photo', photo: { type: 'photo', media: 'https://images.nasa.gov/ring.jpg' } });
  assert.equal(above.fallback.method, 'sendPhoto');
  const below = renderTelegram(makeSpec({ body: BODY, placement: 'below' }), makeCard()).messages[0] as any;
  assert.deepEqual(below.blocks.at(-1), { type: 'photo', photo: { type: 'photo', media: 'https://images.nasa.gov/ring.jpg' } });
});

test('video post: a video block; buttons travel with the rich message', () => {
  const spec = makeSpec({ format: 'video', body: BODY, media: [{ url: 'https://v.example/a.mp4', kind: 'video' }], cta: { url: 'https://x.example', label: 'Більше' } });
  const m = renderTelegram(spec, makeCard()).messages[0] as any;
  assert.deepEqual(m.blocks[0], { type: 'video', video: { type: 'video', media: 'https://v.example/a.mp4', supports_streaming: true } });
  assert.deepEqual(m.buttons, [[{ text: 'Більше', url: 'https://x.example' }]]);
  assert.equal(m.fallback.method, 'sendVideo');
});

test('poll / quiz: the intro becomes rich, the poll stays a poll; longread keeps the Read button', () => {
  const quiz = makeSpec({ format: 'quiz', media: [], body: BODY, poll: { question: 'Котрий дешевший?', options: ['A55', 'Pixel 8a'], correct_index: 0 } });
  const r = renderTelegram(quiz, makeCard());
  assert.deepEqual(r.messages.map((m) => m.method), ['sendRichMessage', 'sendPoll']);
  assert.equal(r.primary, 1);

  const lr = makeSpec({ format: 'longread', media: [], body: BODY, longread: { title: 'Стаття', blocks: [{ type: 'p', text: 'Текст' }] } });
  const m = renderTelegram(lr, makeCard(), { longreadUrl: 'https://telegra.ph/x' }).messages[0] as any;
  assert.equal(m.method, 'sendRichMessage');
  assert.deepEqual(m.buttons[0], [{ text: 'Читати', url: 'https://telegra.ph/x' }]);
});

test('album keeps an HTML caption (rich blocks degrade) and lint says so', () => {
  const spec = makeSpec({ format: 'album', body: BODY, media: [{ url: 'https://i.example/1.jpg' }, { url: 'https://i.example/2.jpg' }] });
  const r = renderTelegram(spec, makeCard());
  assert.equal(r.messages[0].method, 'sendMediaGroup');
  assert.match((r.messages[0] as any).caption, /<b>Порівняння<\/b>/);
  assert.ok(lintPost(spec, makeCard({ formats: { album: 1 } })).warnings.some((w) => w.code === 'rich_in_caption'));
});

test('lint checks the HTML fallback length and the rich limits; never → rich_off warning', () => {
  const long = makeSpec({ format: 'text', media: [], body: [
    { type: 'lead', text: 'Довгий огляд смартфонів' },
    ...Array(4).fill({ type: 'p', text: 'Текст українською для перевірки довжини резервного повідомлення. '.repeat(18) }),
    { type: 'heading', text: 'Підсумок' },
  ] });
  const l = lintPost(long, makeCard());
  assert.ok(l.errors.some((e) => e.code === 'too_long' && /HTML-резерв/.test(e.message)), JSON.stringify(l.errors));

  const spec = makeSpec({ format: 'text', media: [], body: BODY });
  assert.ok(lintPost(spec, makeCard({ richPref: 'never' })).warnings.some((w) => w.code === 'rich_off'));
});

test('richStats counts characters (formulas included), nested blocks, list items, table rows and depth', () => {
  const blocks = renderTelegram(makeSpec({ format: 'text', media: [], hashtags: [], source: undefined, origin: 'original', body: [
    { type: 'p', text: 'абв' },
    { type: 'math', expression: 'x^2' },
    { type: 'olist', items: ['а', 'б'] },
    { type: 'table', header: ['к', 'л'], rows: [['1', '2']] },
    { type: 'details', title: 'Д', body: [{ type: 'p', text: 'е' }] },
  ] }), makeCard()).messages[0] as any;
  assert.deepEqual(richStats(blocks.blocks), { chars: 3 + 3 + 2 + 4 + 2, blocks: 5 + 2 + 2 + 2 + 1, depth: 2 });
  assert.equal(richToPlain(blocks.blocks), 'абв\n\nx^2\n\n1. а\n2. б\n\nк — л\n1 — 2\n\nД\nе');
});
