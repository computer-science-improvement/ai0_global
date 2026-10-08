// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 033 FR-006: the rich-message preview renders every block the backend
// emits (server-rendered markup, no DOM needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { isNumberedList, RichBlocksView } from './RichMessageView';
import type { TgRichBlock } from '../../api/types';

const html = (blocks: TgRichBlock[], media?: (src: string, kind: 'photo' | 'video') => string) =>
  renderToStaticMarkup(createElement(RichBlocksView, { blocks, ...(media ? { media: (s: string, k: 'photo' | 'video') => media(s, k) } : {}) }));

/** The mock render the browser check uses (same shape as the backend's renderTelegram output). */
const SAMPLE_BLOCKS: TgRichBlock[] = [
  { type: 'paragraph', text: { type: 'bold', text: 'Three phones under $500' } },
  { type: 'heading', text: 'Comparison', size: 2 },
  { type: 'table', is_bordered: true, cells: [
    [{ text: 'Model', is_header: true }, { text: 'Price', is_header: true }, { text: 'Battery, mAh', is_header: true }, { text: 'Weight, g', is_header: true }],
    [{ text: 'Galaxy A55' }, { text: { type: 'bold', text: '$449' } }, { text: '5000' }, { text: '213' }],
    [{ text: 'Pixel 8a' }, { text: '$499' }, { text: '4492' }, { text: '188' }],
  ] },
  { type: 'list', items: [
    { blocks: [{ type: 'paragraph', text: 'Set a budget' }], type: '1', value: 1 },
    { blocks: [{ type: 'paragraph', text: 'Compare the cameras' }], type: '1', value: 2 },
  ] },
  { type: 'mathematical_expression', expression: 'E = mc^2' },
  { type: 'divider' },
  { type: 'details', summary: 'How we tested', blocks: [{ type: 'paragraph', text: 'One week of daily use.' }] },
  { type: 'footer', text: 'Prices as of 1 October' },
  { type: 'paragraph', text: ['→ ', { type: 'url', text: 'Source', url: 'https://example.com/review' }] },
];

test('headings, numbered list, table with header row, formula, divider, details, footer, link', () => {
  const out = html(SAMPLE_BLOCKS);
  assert.match(out, /<p class="tg-rich-p"><b>Three phones under \$500<\/b><\/p>/);
  assert.match(out, /<div class="tg-rich-h tg-rich-h2" role="heading" aria-level="3">Comparison<\/div>/);
  assert.match(out, /<div class="tg-rich-table-wrap" role="region" aria-label="Table" tabindex="0"><table class="tg-rich-table" data-bordered="true"><thead><tr><th>Model<\/th><th>Price<\/th>/);
  assert.match(out, /<tbody><tr><td>Galaxy A55<\/td><td><b>\$449<\/b><\/td><td>5000<\/td><td>213<\/td><\/tr>/);
  assert.match(out, /<ol class="tg-rich-list"><li value="1"><p class="tg-rich-p">Set a budget<\/p><\/li><li value="2">/);
  assert.match(out, /<div class="tg-rich-math" title="Formula \(LaTeX\)">E = mc\^2<\/div>/);
  assert.match(out, /<hr class="tg-rich-hr"\/>/);
  assert.match(out, /<details class="tg-rich-details"><summary>How we tested<\/summary><div class="tg-rich-details-body"><p class="tg-rich-p">One week of daily use.<\/p><\/div><\/details>/);
  assert.match(out, /<div class="tg-rich-footer">Prices as of 1 October<\/div>/);
  assert.match(out, /<a href="https:\/\/example.com\/review" target="_blank" rel="noopener noreferrer nofollow">Source<\/a>/);
});

test('a bulleted list is <ul>; numbered needs the ordered label style', () => {
  const items = [{ blocks: [{ type: 'paragraph' as const, text: 'a' }] }];
  assert.equal(isNumberedList(items), false);
  assert.equal(isNumberedList([{ ...items[0], type: '1' as const, value: 1 }]), true);
  assert.match(html([{ type: 'list', items }]), /^<ul class="tg-rich-list"><li>/);
});

test('code block, quote, spoiler, inline formula; unsafe links render as text', () => {
  const out = html([
    { type: 'pre', text: 'adb devices', language: 'bash' },
    { type: 'blockquote', blocks: [{ type: 'paragraph', text: 'Quoted' }] },
    { type: 'paragraph', text: [{ type: 'spoiler', text: 'secret' }, ' ', { type: 'mathematical_expression', expression: 'x^2' }, ' ', { type: 'url', text: 'bad', url: 'javascript:alert(1)' }] },
  ]);
  assert.match(out, /<pre class="tg-rich-pre" data-language="bash"><code>adb devices<\/code><\/pre>/);
  assert.match(out, /<blockquote class="tg-rich-quote"><p class="tg-rich-p">Quoted<\/p><\/blockquote>/);
  assert.match(out, /<span class="tg-rich-spoiler" title="spoiler">secret<\/span> <code class="tg-rich-math-inline">x\^2<\/code> bad<\/p>/);
  assert.doesNotMatch(out, /javascript:/);
});

test('photo and video blocks use the caller\'s media renderer; nothing without one', () => {
  const blocks: TgRichBlock[] = [
    { type: 'photo', photo: { type: 'photo', media: 'https://example.com/a.jpg' } },
    { type: 'video', video: { type: 'video', media: 'https://example.com/a.mp4', supports_streaming: true } },
  ];
  assert.equal(html(blocks), '');
  assert.equal(html(blocks, (s, k) => `${k}:${s}`), '<div class="tg-rich-media">photo:https://example.com/a.jpg</div><div class="tg-rich-media">video:https://example.com/a.mp4</div>');
});

test('a table without a header row renders every row in the body', () => {
  const out = html([{ type: 'table', cells: [[{ text: 'a' }, { text: 'b' }], [{ text: 'c' }, { text: 'd' }]] }]);
  assert.doesNotMatch(out, /<thead>/);
  assert.match(out, /<tbody><tr><td>a<\/td><td>b<\/td><\/tr><tr><td>c<\/td><td>d<\/td><\/tr><\/tbody>/);
});
