// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Chat answers: the markdown subset the agents are told they may use (server-rendered markup, no DOM needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownLite, splitRow } from './markdown-lite';

const html = (text: string) => renderToStaticMarkup(createElement(MarkdownLite, { text }));

test('a table: header, aligned columns, escaped pipes in a cell, missing cells filled', () => {
  const out = html([
    'Available channels:',
    '',
    '| Channel | Name | Mode |',
    '|---|:---:|--:|',
    '| @ai0_prompts_dev | AI Pics \\| DEV | **live** |',
    '| @recipes_dev | Recipes |',
    '',
    'Which channel?',
  ].join('\n'));
  assert.match(out, /<p[^>]*>Available channels:<\/p><div class="md-table-wrap"/);
  assert.match(out, /<th style="text-align:center">Name<\/th>/);
  assert.match(out, /<td style="text-align:right"><strong>live<\/strong><\/td>/);
  assert.match(out, /<td style="text-align:center">AI Pics \| DEV<\/td>/, 'an escaped pipe is a literal pipe, not a column');
  assert.equal((out.match(/<tr>/g) ?? []).length, 3);
  assert.match(out, /<td style="text-align:right"><\/td><\/tr><\/tbody>/, 'a short row gets empty cells');
  assert.match(out, /<\/div><p[^>]*>Which channel\?<\/p>$/);
  assert.ok(!out.includes('|---'));
});

test('a pipe in a plain sentence is not a table', () => {
  const out = html('a | b\nnext line');
  assert.ok(!out.includes('<table'));
  assert.match(out, /a \| b<br\/>next line/);
});

test('headings, code blocks, quotes, dividers, strike and escapes', () => {
  const out = html([
    '## Summary',
    '```ts',
    'const a = 1 < 2; // **not bold**',
    '```',
    '> a quote with _italic_',
    '> second line',
    '---',
    '~~old~~ and \\*not italic\\*',
  ].join('\n'));
  assert.match(out, /<div role="heading" aria-level="4" class="md-h md-h2">Summary<\/div>/);
  assert.match(out, /<pre class="md-pre" data-language="ts"><code>const a = 1 &lt; 2; \/\/ \*\*not bold\*\*<\/code><\/pre>/);
  assert.match(out, /<blockquote class="md-quote">a quote with <em>italic<\/em><br\/>second line<\/blockquote>/);
  assert.match(out, /<hr class="md-hr"\/>/);
  assert.match(out, /<del>old<\/del> and \*not italic\*/);
});

test('the old subset still renders: lists, bold, links; no raw HTML gets through', () => {
  const out = html('- **one** [site](https://ai0.example)\n- two\n\n1. first\n\n<script>alert(1)</script>');
  assert.match(out, /<ul[^>]*><li><strong>one<\/strong> <a href="https:\/\/ai0.example"[^>]*>site<\/a><\/li><li>two<\/li><\/ul>/);
  assert.match(out, /<ol[^>]*><li>first<\/li><\/ol>/);
  assert.match(out, /&lt;script&gt;/);
});

test('splitRow: outer pipes optional, escapes kept for the inline pass', () => {
  assert.deepEqual(splitRow('| a | b \\| c |'), ['a', 'b \\| c']);
  assert.deepEqual(splitRow('a|b'), ['a', 'b']);
});
