import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeAttr, escapeHtml, trimBrokenEntity } from './html';

test('escapeHtml escapes &, <, > (ampersand first) and is null-safe', () => {
  assert.equal(escapeHtml('a & b <c> &amp;'), 'a &amp; b &lt;c&gt; &amp;amp;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml('say "hi"'), 'say "hi"');
});

test('escapeAttr additionally escapes double quotes', () => {
  assert.equal(
    escapeAttr('https://x.com/?a=1&b="2"<'),
    'https://x.com/?a=1&amp;b=&quot;2&quot;&lt;',
  );
});

test('trimBrokenEntity drops a half-cut entity only', () => {
  assert.equal(trimBrokenEntity('fish &am'), 'fish ');
  assert.equal(trimBrokenEntity('fish &amp;'), 'fish &amp;');
  assert.equal(trimBrokenEntity('fish &'), 'fish ');
  assert.equal(trimBrokenEntity('plain'), 'plain');
});
