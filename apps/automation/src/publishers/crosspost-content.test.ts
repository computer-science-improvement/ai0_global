// crosspost-content.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tgPostLink, buildMirrorCaption, buildTeaserCaption } from './crosspost-content';

test('tgPostLink builds public link, null for private', () => {
  assert.equal(tgPostLink('ai0_global', 42), 'https://t.me/ai0_global/42');
  assert.equal(tgPostLink(null, 42), null);
});

test('mirror appends link-back for facebook/threads', () => {
  const c = buildMirrorCaption('facebook', 'Hello <b>world</b>', [], 'https://t.me/ai0_global/7');
  assert.ok(c.startsWith('Hello world'));
  assert.ok(c.endsWith('↗ https://t.me/ai0_global/7'));
});

test('mirror drops link for instagram (no clickable links)', () => {
  const c = buildMirrorCaption('instagram', 'Hi', ['news'], 'https://t.me/ai0_global/7');
  assert.ok(!c.includes('t.me'));
  assert.ok(c.includes('#news'));
});

test('teaser joins lines + appends link', () => {
  const c = buildTeaserCaption('threads', ['🍲 Дієтична каша', 'БЖВ: 12/8/40'], 'https://t.me/ai0_global/9');
  assert.equal(c, '🍲 Дієтична каша\nБЖВ: 12/8/40\n\nhttps://t.me/ai0_global/9');
});

test('threads teaser caps at 500 keeping the link intact', () => {
  const link = 'https://t.me/ai0_global/9';
  const c = buildTeaserCaption('threads', ['x'.repeat(600)], link);
  assert.ok(c.length <= 500);
  assert.ok(c.endsWith(link));
});

test('teaser without link just joins lines', () => {
  assert.equal(buildTeaserCaption('facebook', ['A', '', 'B'], null), 'A\nB');
});
