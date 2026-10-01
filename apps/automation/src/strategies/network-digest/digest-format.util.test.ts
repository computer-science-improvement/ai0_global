import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIGEST_CHAR_BUDGET, escapeHtml, kyivDate, linkUsername, renderDigest,
  truncate, viewsPerHour, type DigestItem,
} from './digest-format.util';

const item = (over: Partial<DigestItem> = {}): DigestItem => ({
  channelKey: '@chan', username: null, messageId: 42,
  title: 'Заголовок поста', views: 100,
  postedAt: new Date('2026-07-03T08:00:00Z'),
  ...over,
});

test('escapeHtml escapes &, <, >', () => {
  assert.equal(escapeHtml('a & <b> "c"'), 'a &amp; &lt;b&gt; "c"');
});

test('truncate keeps short strings, ellipsizes long ones at max', () => {
  assert.equal(truncate('short', 90), 'short');
  const long = 'x'.repeat(120);
  assert.equal(truncate(long, 90).length, 90);
  assert.ok(truncate(long, 90).endsWith('…'));
});

test('linkUsername: explicit username wins; @key strips @; non-@ keys unlinkable', () => {
  assert.equal(linkUsername('@chan', 'realname'), 'realname');
  assert.equal(linkUsername('@chan', null), 'chan');
  assert.equal(linkUsername('invite:abc', null), null);
  assert.equal(linkUsername('-1001234', null), null);
});

test('viewsPerHour: 3h floor prevents fresh-post infinite boost; null views rank 0', () => {
  const now = new Date('2026-07-03T12:00:00Z');
  const fresh = viewsPerHour(300, new Date('2026-07-03T11:30:00Z'), now); // 0.5h old → /3
  assert.equal(fresh, 100);
  const old = viewsPerHour(300, new Date('2026-07-03T02:00:00Z'), now);   // 10h → /10
  assert.equal(old, 30);
  assert.equal(viewsPerHour(null, new Date(), now), 0);
});

test('renderDigest: header, linked items with view counts, stats, cta, sponsor with #реклама', () => {
  const { text, itemsUsed } = renderDigest({
    header: 'Мережа: головне',
    items: [item({ title: 'A & B', views: 1500 })],
    statsLine: '+12 підписників · 9 постів',
    ctaText: '🔥 поділись',
    sponsor: { text: 'Курс з ШІ', url: 'https://example.com' },
  });
  assert.equal(itemsUsed, 1);
  assert.match(text, /^📑 <b>Мережа: головне<\/b>/);
  assert.match(text, /<a href="https:\/\/t\.me\/chan\/42">A &amp; B<\/a>/);
  assert.match(text, /👁 1[\s .,]?500/);
  assert.match(text, /📈 \+12 підписників · 9 постів/);
  assert.match(text, /Партнер дайджесту:<\/b> <a href="https:\/\/example\.com">Курс з ШІ<\/a>/);
  assert.match(text, /#реклама/);
});

test('renderDigest: unlinkable items are dropped, not rendered', () => {
  const { itemsUsed, text } = renderDigest({
    header: 'H',
    items: [item({ channelKey: 'invite:xyz' }), item({ channelKey: '@ok', messageId: 7 })],
  });
  assert.equal(itemsUsed, 1);
  assert.match(text, /t\.me\/ok\/7/);
  assert.doesNotMatch(text, /invite/);
});

test('renderDigest: stays under budget with many long items (fits, never splits)', () => {
  const many = Array.from({ length: 40 }, (_, i) =>
    item({ messageId: i + 1, title: 'Дуже довгий заголовок '.repeat(6), views: i }));
  const { text } = renderDigest({ header: 'H', items: many, sponsor: { text: 'S', url: 'https://s.ua' } });
  assert.ok(text.length <= DIGEST_CHAR_BUDGET, `len=${text.length}`);
  assert.ok(text.length <= 4096);
  assert.match(text, /#реклама/, 'footer must survive even when items overflow');
});

test('renderDigest: sponsor url with quotes cannot break out of the href; #реклама is the last line', () => {
  const { text } = renderDigest({ header: 'H', items: [item()], sponsor: { text: '<b>x</b>', url: 'https://s.ua/?a="1"&b=2' } });
  assert.match(text, /<a href="https:\/\/s\.ua\/\?a=&quot;1&quot;&amp;b=2">&lt;b&gt;x&lt;\/b&gt;<\/a>/);
  assert.match(text.split('\n').at(-1)!, /#реклама<\/i>$/);
});

test('renderDigest: no sponsor → no #реклама', () => {
  const { text } = renderDigest({ header: 'H', items: [item()] });
  assert.doesNotMatch(text, /#реклама/);
});

test('kyivDate formats YYYY-MM-DD', () => {
  assert.match(kyivDate(new Date('2026-07-03T10:00:00Z')), /^2026-07-03$/);
});
