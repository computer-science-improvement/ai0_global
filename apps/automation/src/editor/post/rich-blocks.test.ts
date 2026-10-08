import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlockSchema, PostSpecSchema } from './post-spec';
import { blockPlain, countBlocks, usesRichBlocks } from './blocks';
import { lintPost } from './lint-post';
import { renderMeta } from './render-meta';
import { longreadToTelegraph } from './render-telegraph';
import { composeText, renderBlock, tableToHtml } from './render-telegram';
import { duplicateSpec } from './duplicate';
import { postPlainText } from './verbatim-guard';
import { inlineToPlain } from './inline-markup';
import { makeCard, makeSpec } from './testing/fixtures';

// Spec 033 T1: rich PostSpec blocks, their limits and the plain / HTML mappings.

const RICH_BODY = [
  { type: 'lead', text: 'Три смартфони до 20 000 грн' },
  { type: 'heading', level: 2, text: 'Порівняння' },
  { type: 'table', header: ['Модель', 'Ціна', 'Батарея'], rows: [['A55', '15 999', '5000'], ['Pixel 8a', '19 999', '4492']] },
  { type: 'olist', items: ['Визначте бюджет', 'Порівняйте камери'] },
  { type: 'math', expression: 'E = mc^2' },
  { type: 'divider' },
  { type: 'details', title: 'Методика', body: [{ type: 'p', text: 'Тестували **тиждень**.' }, { type: 'quote', text: 'Цитата' }] },
  { type: 'footer', text: 'Ціни на 1 жовтня' },
  { type: 'code', text: 'adb devices', language: 'bash' },
];

const richSpec = (over: Record<string, unknown> = {}) => makeSpec({ format: 'text', media: [], body: RICH_BODY, ...over });

test('schema: every rich block parses; old specs still parse unchanged', () => {
  const spec = richSpec();
  assert.equal(spec.body.length, RICH_BODY.length);
  assert.equal((spec.body[1] as any).level, 2);
  assert.equal(BlockSchema.parse({ type: 'heading', text: 'Без рівня' }).type, 'heading');
  assert.equal((BlockSchema.parse({ type: 'heading', text: 'Без рівня' }) as any).level, 2, 'heading level defaults to 2');
  const old = makeSpec();
  assert.deepEqual(old.body.map((b) => b.type), ['lead', 'p']);
  assert.equal(usesRichBlocks(old.body), false);
  assert.equal(usesRichBlocks(spec.body), true);
});

test('schema limits: table ≤ 6 columns × 20 rows, cell ≤ 200, math ≤ 500, heading level 1–3, no nested details', () => {
  const ok = (b: unknown) => BlockSchema.safeParse(b).success;
  assert.equal(ok({ type: 'table', header: Array(6).fill('h'), rows: Array(20).fill(Array(6).fill('c')) }), true);
  assert.equal(ok({ type: 'table', header: Array(7).fill('h'), rows: [['c']] }), false);
  assert.equal(ok({ type: 'table', header: ['h'], rows: Array(21).fill(['c']) }), false);
  assert.equal(ok({ type: 'table', header: ['h'], rows: [['x'.repeat(201)]] }), false);
  assert.equal(ok({ type: 'table', header: ['h'], rows: [Array(7).fill('c')] }), false);
  assert.equal(ok({ type: 'math', expression: 'x'.repeat(500) }), true);
  assert.equal(ok({ type: 'math', expression: 'x'.repeat(501) }), false);
  assert.equal(ok({ type: 'heading', level: 4, text: 'h' }), false);
  assert.equal(ok({ type: 'details', title: 't', body: [{ type: 'details', title: 'u', body: [{ type: 'p', text: 'x' }] }] }), false);
  assert.equal(ok({ type: 'code', text: 'x', language: 'bash; rm' }), false);
  assert.equal(PostSpecSchema.safeParse({ ...richSpec(), body: Array(61).fill({ type: 'p', text: 'x' }) }).success, false);
  assert.equal(PostSpecSchema.safeParse({ ...richSpec(), body: Array(60).fill({ type: 'p', text: 'x' }) }).success, true);
});

test('lint: nested blocks count toward the 60-block limit; a row wider than the header is an error', () => {
  const details = { type: 'details', title: 'Деталі', body: Array(20).fill({ type: 'p', text: 'Рядок тексту українською.' }) };
  const spec = richSpec({ body: [{ type: 'lead', text: 'Заголовок поста' }, details, details, details] });
  assert.equal(countBlocks(spec.body), 64);
  const l = lintPost(spec, makeCard());
  assert.ok(l.errors.some((e) => e.code === 'too_many_blocks'), JSON.stringify(l.errors));

  const wide = richSpec({ body: [{ type: 'lead', text: 'Порівняння цін' }, { type: 'table', header: ['А', 'Б'], rows: [['1', '2', '3']] }] });
  assert.ok(lintPost(wide, makeCard()).errors.some((e) => e.code === 'table_shape'));
});

test('lint warns on a table in a short post and on > 2 headings in a short post (FR-005)', () => {
  const short = richSpec({ body: [{ type: 'lead', text: 'Ціни на каву' }, { type: 'table', header: ['Кава', 'Ціна'], rows: [['Еспресо', '45']] }] });
  const l = lintPost(short, makeCard());
  assert.ok(l.warnings.some((w) => w.code === 'table_in_short_post'), JSON.stringify(l.warnings));

  const heads = richSpec({ body: [
    { type: 'lead', text: 'Новини тижня коротко' },
    { type: 'heading', text: 'Космос' }, { type: 'p', text: 'Старт ракети перенесли.' },
    { type: 'heading', text: 'Наука' }, { type: 'p', text: 'Нове дослідження сну.' },
    { type: 'heading', text: 'Техніка' }, { type: 'p', text: 'Вийшов новий смартфон.' },
  ] });
  assert.ok(lintPost(heads, makeCard()).warnings.some((w) => w.code === 'too_many_headings'));

  const long = 'Довгий абзац українською про порівняння моделей і їхні сильні сторони. '.repeat(8);
  const fine = richSpec({ body: [{ type: 'lead', text: 'Огляд' }, { type: 'p', text: long }, { type: 'table', header: ['А', 'Б'], rows: [['1', '2']] }] });
  assert.equal(lintPost(fine, makeCard()).warnings.some((w) => w.code === 'table_in_short_post'), false);
});

test('HTML degrade: headings bold, olist numbered, math <code>, footer italic, code <pre>, details expandable', () => {
  assert.equal(renderBlock({ type: 'heading', level: 1, text: 'Розділ **1**' }), '<b>Розділ <b>1</b></b>');
  assert.equal(renderBlock({ type: 'olist', items: ['Перше', 'Друге'] }), '1. Перше\n2. Друге');
  assert.equal(renderBlock({ type: 'math', expression: 'a < b' }), '<code>a &lt; b</code>');
  assert.equal(renderBlock({ type: 'footer', text: 'Дрібно' }), '<i>Дрібно</i>');
  assert.equal(renderBlock({ type: 'code', text: 'x<1', language: 'js' }), '<pre><code class="language-js">x&lt;1</code></pre>');
  assert.equal(renderBlock({ type: 'divider' }), '');
  assert.equal(renderBlock({ type: 'details', title: 'Більше', body: [{ type: 'p', text: 'Текст' }, { type: 'quote', text: 'Ц' }] }),
    '<b>Більше</b>\n<blockquote expandable>Текст\n\n«Ц»</blockquote>');
});

test('HTML degrade: a narrow table is a <pre> grid, a wide one is bullet rows', () => {
  assert.equal(tableToHtml(['Кава', 'Ціна'], [['Еспресо', '45'], ['Лате', '60']]),
    '<pre>Кава    | Ціна\n--------+-----\nЕспресо | 45\nЛате    | 60</pre>');
  assert.equal(tableToHtml(['Модель', 'Ціна, грн', 'Батарея, мА·год'], [['Galaxy A55', '15 999', '5000'], ['Pixel 8a', '**19 999**']]),
    '• <b>Galaxy A55</b> — Ціна, грн: 15 999; Батарея, мА·год: 5000\n• <b>Pixel 8a</b> — Ціна, грн: <b>19 999</b>; Батарея, мА·год: —');
  assert.equal(tableToHtml(['Місто', 'Опис дуже довгої колонки для телефону'], [['Київ', 'столиця']]), '• <b>Київ</b> — столиця');
});

test('composeText of a rich spec is the full HTML fallback (snapshot)', () => {
  const t = composeText(richSpec(), makeCard());
  assert.equal(t, [
    '<b>Три смартфони до 20 000 грн</b>',
    '<b>Порівняння</b>',
    '<pre>Модель   | Ціна   | Батарея\n---------+--------+--------\nA55      | 15 999 | 5000\nPixel 8a | 19 999 | 4492</pre>',
    '1. Визначте бюджет\n2. Порівняйте камери',
    '<code>E = mc^2</code>',
    '<b>Методика</b>\n<blockquote expandable>Тестували <b>тиждень</b>.\n\n«Цитата»</blockquote>',
    '<i>Ціни на 1 жовтня</i>',
    '<pre><code class="language-bash">adb devices</code></pre>',
    '→ <a href="https://nasa.gov/ring">NASA</a>',
    '#космос',
  ].join('\n\n'));
});

test('plain mapping (FR-004): headings lines, olist "1.", table "a — b — c", math inline, details title + body', () => {
  const lines = RICH_BODY.map((b) => blockPlain(BlockSchema.parse(b), inlineToPlain));
  assert.deepEqual(lines, [
    'Три смартфони до 20 000 грн',
    'Порівняння',
    'Модель — Ціна — Батарея\nA55 — 15 999 — 5000\nPixel 8a — 19 999 — 4492',
    '1. Визначте бюджет\n2. Порівняйте камери',
    'E = mc^2',
    '',
    'Методика\nТестували тиждень.\n«Цитата»',
    'Ціни на 1 жовтня',
    'adb devices',
  ]);
});

test('renderMeta: rich blocks reach Facebook/Threads as plain text', () => {
  const r = renderMeta(richSpec({ media: [{ url: 'https://images.nasa.gov/ring.jpg' }] }), makeCard());
  const fb = r.posts.facebook!.caption;
  assert.match(fb, /Порівняння\n\nМодель — Ціна — Батарея\nA55 — 15 999 — 5000/);
  assert.match(fb, /1\. Визначте бюджет\n2\. Порівняйте камери/);
  assert.match(fb, /E = mc\^2\n\nМетодика\nТестували тиждень\./);
  assert.doesNotMatch(fb, /<|\*\*/);
});

test('Telegraph: h3/h4, ol, table rows, code formula, hr, details as h4 + body, aside, pre', () => {
  const nodes = longreadToTelegraph({ title: 'Стаття', blocks: richSpec().body });
  const tags = nodes.map((n) => (typeof n === 'string' ? 'text' : n.tag));
  assert.deepEqual(tags, ['h3', 'h3', 'p', 'p', 'p', 'ol', 'p', 'hr', 'h4', 'p', 'blockquote', 'aside', 'pre']);
  assert.deepEqual(nodes[2], { tag: 'p', children: [{ tag: 'strong', children: ['Модель — Ціна — Батарея'] }] });
  assert.deepEqual(nodes[3], { tag: 'p', children: ['A55 — 15 999 — 5000'] });
  assert.deepEqual(nodes[6], { tag: 'p', children: [{ tag: 'code', children: ['E = mc^2'] }] });
  assert.equal(JSON.stringify(nodes).includes('table'), false);
});

test('duplicate to a platform and the verbatim guard read rich blocks as text', () => {
  const draft = duplicateSpec({ platform: 'telegram', spec: richSpec() }, { platform: 'facebook', format: 'fb_text' }) as any;
  assert.match(draft.caption, /^\*\*Три смартфони до 20 000 грн\*\*\n\nПорівняння\n\nМодель — Ціна — Батарея/);
  assert.match(draft.caption, /1\. Визначте бюджет/);
  const plain = postPlainText(richSpec());
  assert.match(plain, /Модель Ціна Батарея\nA55 15 999 5000/);
  assert.match(plain, /Методика\nТестували тиждень\.\nЦитата/);
});
