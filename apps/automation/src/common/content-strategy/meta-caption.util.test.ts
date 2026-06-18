import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recipeHashtags, promptHashtags, telegramLink, composeMetaCaption,
} from './meta-caption.util';

test('recipeHashtags appends the category, deduped + lowercased', () => {
  const tags = recipeHashtags('Сніданки');
  assert.ok(tags.includes('cooking'));
  assert.ok(tags.includes('diet'));
  // category slugified (non-ascii stripped → '' → not added); ascii category added
  const withAscii = recipeHashtags('Breakfast');
  assert.ok(withAscii.includes('breakfast'));
  // no duplicate when category already present
  assert.equal(recipeHashtags('food').filter((t) => t === 'food').length, 1);
});

test('promptHashtags includes fashion + ai tags', () => {
  const tags = promptHashtags('fashion');
  assert.ok(tags.includes('aifashion'));
  assert.ok(tags.includes('fashion'));
});

test('telegramLink builds from username, strips @, null when empty', () => {
  assert.equal(telegramLink('@ai0recipes'), 'https://t.me/ai0recipes');
  assert.equal(telegramLink('ai0recipes'), 'https://t.me/ai0recipes');
  assert.equal(telegramLink(null), null);
  assert.equal(telegramLink(''), null);
});

test('composeMetaCaption: hashtags on every platform, link only on FB + Threads', () => {
  const opts = { base: 'Yummy soup', hashtags: ['recipe', 'food'], telegramLink: 'https://t.me/x', linkLabel: '📲 More:' };

  const ig = composeMetaCaption('instagram', opts);
  assert.ok(ig.includes('#recipe #food'));
  assert.ok(!ig.includes('t.me'), 'Instagram caption must NOT contain the link');

  const fb = composeMetaCaption('facebook', opts);
  assert.ok(fb.includes('#recipe #food'));
  assert.ok(fb.includes('📲 More: https://t.me/x'), 'Facebook caption must contain the labelled link');

  const th = composeMetaCaption('threads', opts);
  assert.ok(th.includes('https://t.me/x'), 'Threads caption must contain the link');
});

test('composeMetaCaption: no link section when telegramLink is null', () => {
  const fb = composeMetaCaption('facebook', { base: 'Hi', hashtags: ['a'], telegramLink: null });
  assert.equal(fb, 'Hi\n\n#a');
});

test('composeMetaCaption: bare URL when no linkLabel', () => {
  const fb = composeMetaCaption('facebook', { base: 'Hi', telegramLink: 'https://t.me/x' });
  assert.equal(fb, 'Hi\n\nhttps://t.me/x');
});
