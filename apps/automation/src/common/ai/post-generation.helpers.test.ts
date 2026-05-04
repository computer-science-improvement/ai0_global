import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripStrayMarkdown, cleanFinalText } from './post-generation.helpers';

test('stripStrayMarkdown: removes ** bold **', () => {
  assert.equal(stripStrayMarkdown('Apple **launched** iOS 18.'), 'Apple launched iOS 18.');
});

test('stripStrayMarkdown: removes __bold__', () => {
  assert.equal(stripStrayMarkdown('__Big__ release today.'), 'Big release today.');
});

test('stripStrayMarkdown: removes single-asterisk italic when bracketed', () => {
  assert.equal(stripStrayMarkdown('A *small* update.'), 'A small update.');
});

test('stripStrayMarkdown: keeps mid-word asterisks (e.g. C*-style)', () => {
  // Should NOT match — no surrounding spaces/edges around the * pair.
  assert.equal(stripStrayMarkdown('a*b*c'), 'a*b*c');
});

test('stripStrayMarkdown: removes single-asterisk italic before period', () => {
  assert.equal(stripStrayMarkdown('Момент *важливий*.'), 'Момент важливий.');
});

test('stripStrayMarkdown: removes single-asterisk italic before comma', () => {
  assert.equal(stripStrayMarkdown('Це *важливо*, друже.'), 'Це важливо, друже.');
});

test('stripStrayMarkdown: removes adjacent single-asterisk italics', () => {
  assert.equal(stripStrayMarkdown('Go *fast* and *slow*.'), 'Go fast and slow.');
});

test('stripStrayMarkdown: removes --- horizontal rule lines', () => {
  assert.equal(stripStrayMarkdown('Para 1.\n---\nPara 2.'), 'Para 1.\n\nPara 2.');
});

test('stripStrayMarkdown: collapses 3+ newlines to 2', () => {
  assert.equal(stripStrayMarkdown('a\n\n\n\nb'), 'a\n\nb');
});

test('stripStrayMarkdown: keeps Telegram HTML tags intact', () => {
  const input = '<b>News</b> — <i>Apple</i> released <code>iOS 18</code>.';
  assert.equal(stripStrayMarkdown(input), input);
});

test('stripStrayMarkdown: keeps anchor tags intact', () => {
  const input = '<a href="https://x.com">link</a> here.';
  assert.equal(stripStrayMarkdown(input), input);
});

test('cleanFinalText: strips "Ось готовий пост:" preamble', () => {
  const input = 'Ось готовий пост:\n\nApple оголосила нову модель.';
  assert.equal(cleanFinalText(input), 'Apple оголосила нову модель.');
});

test('cleanFinalText: strips "**Готовий пост:**" markdown preamble', () => {
  const input = '**Готовий пост:**\n\n---\n\nApple оголосила.';
  assert.equal(cleanFinalText(input), 'Apple оголосила.');
});

test('cleanFinalText: strips "<b>Final post:</b>" HTML preamble', () => {
  const input = '<b>Final post:</b>\n\nApple announced.';
  assert.equal(cleanFinalText(input), 'Apple announced.');
});

test('cleanFinalText: strips json/markdown/html code fences', () => {
  const input = '```html\n<b>Apple</b> announced.\n```';
  assert.equal(cleanFinalText(input), '<b>Apple</b> announced.');
});

test('cleanFinalText: chains preamble+markdown+separator removal', () => {
  const input = '**Готовий пост:**\n\n---\n\n**Apple** released **iOS 18** — read more.';
  assert.equal(cleanFinalText(input), 'Apple released iOS 18 — read more.');
});

test('cleanFinalText: keeps clean Telegram HTML untouched', () => {
  const input = '<b>Apple</b> випустила <i>iOS 18</i>.\n\n<a href="https://example.com">Деталі</a>.';
  assert.equal(cleanFinalText(input), input);
});

test('cleanFinalText: trims trailing whitespace', () => {
  assert.equal(cleanFinalText('  Apple announced.\n\n  '), 'Apple announced.');
});
