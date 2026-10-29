// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 078 C1: the names and the glyph letter of the channel pages.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRACKING_META, channelInitial, channelName } from './channel-view';

test('channelInitial: first letter, upper case, without a leading # @ or -', () => {
  assert.equal(channelInitial('Motivation | LOCAL'), 'M');
  assert.equal(channelInitial('@ai0_global'), 'A');
  assert.equal(channelInitial('#news'), 'N');
  assert.equal(channelInitial('-1003984251759'), '1');
  assert.equal(channelInitial('  space'), 'S');
});

test('channelInitial: nothing to show gives a question mark', () => {
  assert.equal(channelInitial(null), '?');
  assert.equal(channelInitial(undefined), '?');
  assert.equal(channelInitial(''), '?');
  assert.equal(channelInitial('@'), '?');
});

test('channelName: title, then channel key, then @username, then the fallback', () => {
  assert.equal(channelName({ title: 'AI news', channelKey: '@ai', username: 'ai' }), 'AI news');
  assert.equal(channelName({ title: null, channelKey: '@ai', username: 'ai' }), '@ai');
  assert.equal(channelName({ title: null, channelKey: null, username: 'ai' }), '@ai');
  assert.equal(channelName({ title: null, channelKey: null, username: null }), '(no title)');
  assert.equal(channelName({}, 'abc-123'), 'abc-123');
});

test('TRACKING_META: every tracking state has a label, a tone and a help line', () => {
  for (const s of ['ok', 'not_subscribed', 'unknown'] as const) {
    assert.ok(TRACKING_META[s].label.length > 0);
    assert.ok(TRACKING_META[s].help.length > 0);
  }
  assert.equal(TRACKING_META.ok.tone, 'success');
  assert.equal(TRACKING_META.not_subscribed.tone, 'warning');
  assert.equal(TRACKING_META.unknown.tone, 'neutral');
});
