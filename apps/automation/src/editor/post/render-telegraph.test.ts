import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inlineToTelegraph, longreadToTelegraph } from './render-telegraph';

test('inline markup → nodes: bold, italic, link, spoiler flattened, text unescaped', () => {
  assert.deepEqual(inlineToTelegraph('Це **дуже** _важливо_: [NASA](https://nasa.gov/a?b=1&c="2") ||таємниця|| x < y & z'), [
    'Це ', { tag: 'b', children: ['дуже'] }, ' ', { tag: 'i', children: ['важливо'] }, ': ',
    { tag: 'a', attrs: { href: 'https://nasa.gov/a?b=1&c="2"' }, children: ['NASA'] }, ' ',
    'таємниця', ' x < y & z',
  ]);
});

test('hostile HTML in text stays text', () => {
  assert.deepEqual(inlineToTelegraph('<script>alert(1)</script>'), ['<script>alert(1)</script>']);
});

test('longread → cover figure, h3 for lead, p, ul, blockquote, source line', () => {
  const nodes = longreadToTelegraph({
    title: 'Тест',
    blocks: [
      { type: 'lead', text: 'Розділ 1' },
      { type: 'p', text: 'Абзац **жирний**' },
      { type: 'list', items: ['один', 'два'] },
      { type: 'quote', text: 'Цитата' },
    ],
  }, { coverUrl: 'https://img.example/c.jpg', source: { url: 'https://nasa.gov', label: 'NASA' } });
  assert.deepEqual(nodes, [
    { tag: 'figure', children: [{ tag: 'img', attrs: { src: 'https://img.example/c.jpg' } }] },
    { tag: 'h3', children: ['Розділ 1'] },
    { tag: 'p', children: ['Абзац ', { tag: 'b', children: ['жирний'] }] },
    { tag: 'ul', children: [{ tag: 'li', children: ['один'] }, { tag: 'li', children: ['два'] }] },
    { tag: 'blockquote', children: ['Цитата'] },
    { tag: 'p', children: ['Джерело: ', { tag: 'a', attrs: { href: 'https://nasa.gov' }, children: ['NASA'] }] },
  ]);
});
