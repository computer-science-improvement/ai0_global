/**
 * Spec 073 FR-013 (A46): a stored `hashtags: 'vocabulary'` with a known empty vocabulary reads as `off`, so a card with no
 * hashtags (the @pdr case: a vocabulary style written when the resource had tags, or by an old default) asks the writer for none.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveStyle, styleOfRow } from './resource-style';
import { rowToCard } from '../../repo/editor-channels.repository';
import { cardSummary } from '../../card';
import { lintPost } from '../lint-post';
import { makeCard, makeSpec } from '../testing/fixtures';

test('effectiveStyle: a known empty vocabulary turns a stored vocabulary style off; an unknown one and a filled one do not', () => {
  assert.equal(effectiveStyle({ hashtags: 'vocabulary' }, { vocabulary: [] }).hashtags, 'off');
  assert.equal(effectiveStyle({ hashtags: 'vocabulary' }, { vocabulary: null }).hashtags, 'vocabulary', 'a platform ref has no card: not judged');
  assert.equal(effectiveStyle({ hashtags: 'vocabulary' }, {}).hashtags, 'vocabulary', 'absent is unknown, not empty');
  assert.equal(effectiveStyle({ hashtags: 'vocabulary' }, { vocabulary: ['ai'] }).hashtags, 'vocabulary');
  assert.equal(effectiveStyle({ hashtags: 'off' }, { vocabulary: ['ai'] }).hashtags, 'off', 'an explicit off stays off');
  // Nothing else moves with it.
  const e = effectiveStyle({ hashtags: 'vocabulary', address: 'ty' }, { vocabulary: [] });
  assert.equal(e.address, 'ty');
});

test('the @pdr row: an old card with no hashtags, a minimum of 1 and a stored vocabulary style reads as off in the card the writer sees', () => {
  const row = {
    channel_key: '@pdr', hashtags: [], hashtag_min: 1, hashtag_max: 3,
    format_prefs_json: { style: { hashtags: 'vocabulary' } }, profile_topic: 'Правила дорожнього руху', owner_rules: [],
  };
  assert.equal(styleOfRow(row).style?.hashtags, 'off');
  const card = rowToCard(row);
  assert.equal(card.style?.hashtags, 'off');
  assert.match(String(cardSummary(card).hashtags), /хештегів не став/, 'the card the writer reads says no hashtags');
  // And the lint asks for none: a post with no hashtags passes, a post with one is refused.
  const none = lintPost(makeSpec({ hashtags: [] }), makeCard({ hashtags: [], hashtagMin: 1, hashtagMax: 3, style: card.style }));
  assert.ok(!none.errors.some((x) => x.code === 'hashtag_count' || x.code === 'hashtag_while_off'), JSON.stringify(none.errors));
  const one = lintPost(makeSpec({ hashtags: ['пдр'] }), makeCard({ hashtags: [], hashtagMin: 1, hashtagMax: 3, style: card.style }));
  assert.ok(one.errors.some((x) => x.code === 'hashtag_while_off'), JSON.stringify(one.errors));
});

test('a card with a vocabulary keeps its vocabulary style, and a row without the profile join stays as it was', () => {
  const row = { channel_key: '@loko', hashtags: ['ai'], hashtag_min: 1, hashtag_max: 3, format_prefs_json: { style: { hashtags: 'vocabulary' } }, profile_topic: 'ШІ', owner_rules: [] };
  assert.equal(rowToCard(row).style?.hashtags, 'vocabulary');
  assert.deepEqual(styleOfRow({ channel_key: '@x' }), {});
});
