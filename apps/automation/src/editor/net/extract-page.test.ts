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

test('spec 037 T5: published_at from article:published_time, JSON-LD datePublished, <time datetime>; null when absent', () => {
  const meta = extractPage('<head><meta property="article:published_time" content="2026-10-07T09:12:00-04:00"></head><body><p>x</p></body>', 'https://a.example');
  assert.equal(meta.published_at, '2026-10-07T13:12:00.000Z');
  const ld = extractPage('<head><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},{"@type":"NewsArticle","datePublished":"2026-10-06T08:00:00Z"}]}</script></head><body><p>x</p></body>', 'https://a.example');
  assert.equal(ld.published_at, '2026-10-06T08:00:00.000Z');
  const time = extractPage('<body><article><time datetime="2026-10-05">5 жовтня</time><p>x</p></article></body>', 'https://a.example');
  assert.equal(time.published_at, '2026-10-05');
  assert.equal(extractPage('<script type="application/ld+json">{broken</script><p>x</p>', 'https://a.example').published_at, null);
  assert.equal(extractPage(html, 'https://news.example/x/y').published_at, null);
});

test('caps long text', () => {
  const p = extractPage(`<body><p>${'a'.repeat(20000)}</p></body>`, 'https://x.example');
  assert.ok(p.text.length <= 12_001);
});
