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
  assert.deepEqual(p.images, ['https://news.example/img/hero.jpg', 'https://news.example/a.jpg'], 'the main image first (T17), then the article\'s');
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

test('037 T4: an aggregator page lists its links to the primary source; other pages do not', () => {
  const body = '<article><p>Google <a href="https://blog.google/technology/ai/gemini-4-argon/">announced</a> Argon '
    + '(<a href="/2026/10/12/other/">our earlier story</a>, <a href="https://techcrunch.com/x">TechCrunch</a>, <a href="https://arxiv.org/abs/2510.01234">paper</a>).</p></article>';
  const agg = extractPage(`<html><body>${body}</body></html>`, 'https://www.marktechpost.com/2026/10/13/google-gemini-4-argon-api-release/');
  assert.deepEqual(agg.primary_links, ['https://blog.google/technology/ai/gemini-4-argon/', 'https://arxiv.org/abs/2510.01234']);
  assert.equal(extractPage(`<html><body>${body}</body></html>`, 'https://techcrunch.com/2026/10/13/a/').primary_links, undefined);
});

test('spec 037 T11: main image — og:image, else twitter:image, else the first article image; absolute; null when none', () => {
  const og = extractPage('<head><meta name="twitter:image" content="https://t.example/tw.jpg"><meta property="og:image" content="//cdn.example/og.jpg?w=1200"></head><body><article><img src="/first.jpg"><p>x</p></article></body>', 'https://news.example/a/b');
  assert.equal(og.image, 'https://cdn.example/og.jpg?w=1200', 'og:image first, protocol-relative made absolute');
  const tw = extractPage('<head><meta name="twitter:image" content="/tw.jpg"></head><body><article><img src="/first.jpg"><p>x</p></article></body>', 'https://news.example/a/b');
  assert.equal(tw.image, 'https://news.example/tw.jpg');
  const twProp = extractPage('<head><meta property="twitter:image:src" content="https://t.example/src.jpg"></head><body><p>x</p></body>', 'https://news.example/a');
  assert.equal(twProp.image, 'https://t.example/src.jpg');
  const first = extractPage('<body><nav><img src="/logo.png"></nav><article><img src="/icon.svg"><img data-src="img/first.jpg"><img src="/second.jpg"><p>x</p></article></body>', 'https://news.example/a/b');
  assert.equal(first.image, 'https://news.example/a/img/first.jpg', 'the first article image (not nav, not svg), resolved against the page URL');
  assert.equal(extractPage('<body><article><p>Текст без зображень.</p></article></body>', 'https://news.example/a').image, null);
  assert.equal(extractPage('<head><meta property="og:image" content="data:image/png;base64,AAA"></head><body><p>x</p></body>', 'https://news.example/a').image, null, 'a data: URI is not an image URL');
});

test('spec 037 T17: article images — main first, absolute, deduplicated, ≤ 10; icons, logos, avatars, pixels, sprites skipped', () => {
  const body = [
    '<img src="/photo-1.jpg">',                                        // kept
    '<img src="https://cdn.example/photo-1.jpg?w=800">',               // another host: kept
    '<img src="/photo-1.jpg?utm_source=x&w=1200">',                    // the same as the first (noise params): dropped
    '<img data-src="/lazy/photo-2.webp" src="data:image/gif;base64,R0lGOD">', // a lazy image: its data-src kept
    '<img src="data:image/png;base64,AAA">',                           // data: URI
    '<img src="/img/site-logo.png">', '<img src="/icons/share.png">', '<img src="/u/avatar_42.jpg">',
    '<img src="/assets/sprite.png">', '<img src="/b/badge-new.png">', '<img src="/t/pixel.png">', '<img src="/t/1x1.png">',
    '<img src="/diagram.svg">', '<img src="/anim.gif">',
    '<img src="/tiny.jpg" width="48" height="48">', '<img src="/thin.jpg" height="1">',
    '<img src="/author.jpg" class="author-avatar">', '<img src="/brand.jpg" id="header-logo">',
    '<img src="/photo-3.jpg" width="1200" height="630" alt="New logo of the company">', // a news photo of a logo: kept
    '<img src="javascript:alert(1)">',
  ].join('');
  const p = extractPage(`<head><meta property="og:image" content="https://news.example/og.jpg"></head><body><article><p>x</p>${body}</article></body>`, 'https://news.example/a/b');
  assert.equal(p.image, 'https://news.example/og.jpg');
  assert.deepEqual(p.images, [
    'https://news.example/og.jpg', 'https://news.example/photo-1.jpg', 'https://cdn.example/photo-1.jpg?w=800',
    'https://news.example/lazy/photo-2.webp', 'https://news.example/photo-3.jpg',
  ]);

  const many = Array.from({ length: 14 }, (_, i) => `<img src="/p/${i}.jpg">`).join('');
  const m = extractPage(`<body><article><p>x</p>${many}</article></body>`, 'https://news.example/a');
  assert.equal(m.images.length, 10);
  assert.equal(m.image, 'https://news.example/p/0.jpg', 'no social image: the first article image is the main one');
  assert.equal(m.images[0], m.image, 'and it is not listed twice');

  const og = extractPage('<head><meta property="og:image" content="/p/0.jpg?w=1200"></head><body><article><img src="/p/0.jpg"><img src="/p/1.jpg"></article></body>', 'https://news.example/a');
  assert.deepEqual(og.images, ['https://news.example/p/0.jpg?w=1200', 'https://news.example/p/1.jpg'], 'the main image and its resized copy are one');
  assert.deepEqual(extractPage('<body><nav><img src="/n.jpg"></nav><article><p>Без зображень.</p></article></body>', 'https://news.example/a').images, [], 'nav images are page chrome');
});
