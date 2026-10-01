import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAdReport, reportStage, shortCampaign, withUtm } from './ad-report';

const POSTED = new Date('2026-10-01T10:00:00Z');
const h = (n: number) => new Date(POSTED.getTime() + n * 3600_000);

test('withUtm adds ai0/telegram/<campaign>, keeps existing query, leaves bad urls alone', () => {
  assert.equal(withUtm('https://shop.ua/x', 'ab12cd34'), 'https://shop.ua/x?utm_source=ai0&utm_medium=telegram&utm_campaign=ab12cd34');
  assert.equal(withUtm('https://shop.ua/x?ref=1#top', 'c'), 'https://shop.ua/x?ref=1&utm_source=ai0&utm_medium=telegram&utm_campaign=c#top');
  assert.equal(withUtm('not a url', 'c'), 'not a url');
  assert.equal(shortCampaign('0f3a9c12-aaaa-bbbb-cccc-000000000000'), '0f3a9c12');
});

test('reportStage: 24h after 24 hours, final 72h after 72 hours', () => {
  assert.equal(reportStage(POSTED, h(23)), null);
  assert.equal(reportStage(POSTED, h(24)), '24h');
  assert.equal(reportStage(POSTED, h(71.9)), '24h');
  assert.equal(reportStage(POSTED, h(72)), '72h');
});

test('buildAdReport: latest metrics, hourly curve, reach rate, post url, link utm flag', () => {
  const r = buildAdReport({
    stage: '24h', now: h(25), advertiser: 'Школа',
    channel: { key: '@space_ua', title: 'Космос', username: null, subscribers: 4000 },
    post: { messageId: 321, postedAt: POSTED, format: 'photo' },
    snapshots: [
      { capturedAt: h(0.5), views: 300, forwards: 1, reactionsTotal: 2, replies: 0 },
      { capturedAt: h(0.9), views: 420, forwards: 1, reactionsTotal: 3, replies: 0 },
      { capturedAt: h(5), views: 1100, forwards: 4, reactionsTotal: 9, replies: 1 },
      { capturedAt: h(24.2), views: 2000, forwards: 7, reactionsTotal: 15, replies: 2 },
    ],
    linkUrl: 'https://shop.ua/?utm_source=x',
  });
  assert.equal(r.stage, '24h');
  assert.equal(r.post.url, 'https://t.me/space_ua/321');
  assert.equal(r.metrics.views, 2000);
  assert.equal(r.metrics.reactions, 15);
  assert.equal(r.reachRate, 0.5);
  assert.deepEqual(r.curve.map((p) => p.hours), [1, 5, 25], 'one point per hour bucket, latest wins');
  assert.deepEqual(r.curve.map((p) => p.views), [420, 1100, 2000]);
  assert.deepEqual(r.link, { url: 'https://shop.ua/?utm_source=x', utm: true });
  assert.equal(r.channel.url, 'https://t.me/space_ua');
});

test('buildAdReport: no snapshots yet → null metrics, empty curve, no reach rate', () => {
  const r = buildAdReport({
    stage: '72h', now: h(73), advertiser: 'A',
    channel: { key: '-100123', title: null, username: null, subscribers: null },
    post: { messageId: 5, postedAt: POSTED, format: null }, snapshots: [], linkUrl: null,
  });
  assert.equal(r.metrics.views, null);
  assert.equal(r.reachRate, null);
  assert.equal(r.post.url, null, 'private channels cannot be deep-linked');
  assert.deepEqual(r.curve, []);
  assert.equal(r.link, null);
});
