import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPage } from './extract-page';

const html = `<html><head><title>T</title>
<meta property="og:title" content="OG Title"><meta name="description" content="Desc">
<meta property="og:image" content="/img/hero.jpg"></head>
<body><nav>menu</nav><article><h1>Head</h1><p>First  para.</p><img src="/a.jpg"><img src="/b.svg"><script>evil()</script><p>Second.</p></article><footer>f</footer></body></html>`;

test('extracts metadata, absolute images and article text', () => {
  const p = extractPage(html, 'https://news.example/x/y');
  assert.equal(p.title, 'OG Title');
  assert.equal(p.description, 'Desc');
  assert.equal(p.image, 'https://news.example/img/hero.jpg');
  assert.deepEqual(p.images, ['https://news.example/a.jpg']);
  assert.equal(p.text, 'Head\nFirst para.\nSecond.');
});

test('caps long text', () => {
  const p = extractPage(`<body><p>${'a'.repeat(20000)}</p></body>`, 'https://x.example');
  assert.ok(p.text.length <= 12_001);
});
