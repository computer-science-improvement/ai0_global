import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeAttr, inlineToHtml, inlineToPlain, visibleLength } from './inline-markup';

test('escapes raw HTML and entities', () => {
  assert.equal(inlineToHtml('a < b & <script>x</script>'), 'a &lt; b &amp; &lt;script&gt;x&lt;/script&gt;');
});

test('bold, italic, spoiler', () => {
  assert.equal(inlineToHtml('**Важливо:** _тихо_ ||сюрприз||'), '<b>Важливо:</b> <i>тихо</i> <tg-spoiler>сюрприз</tg-spoiler>');
});

test('links: http only, label escaped, quotes in URL escaped', () => {
  assert.equal(inlineToHtml('[NASA <x>](https://nasa.gov/a?b=1&c="2")'),
    '<a href="https://nasa.gov/a?b=1&amp;c=&quot;2&quot;">NASA &lt;x&gt;</a>');
  assert.equal(inlineToHtml('[x](javascript:alert(1))'), '[x](javascript:alert(1))');
});

test('markup inside URL is not interpreted', () => {
  assert.equal(inlineToHtml('[a](https://x.com/__init__/**b**)'), '<a href="https://x.com/__init__/**b**">a</a>');
});

test('snake_case words are not italicised', () => {
  assert.equal(inlineToHtml('use my_var_name here'), 'use my_var_name here');
});

test('plain and visible length', () => {
  assert.equal(inlineToPlain('**A** [b](https://x.y) ||c||'), 'A b c');
  assert.equal(visibleLength('<b>A&amp;B</b>'), 3);
  assert.equal(escapeAttr('"'), '&quot;');
});
