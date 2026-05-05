import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertStrayMarkdown, cleanFinalText } from './post-generation.helpers';

test('convertStrayMarkdown: converts ** bold ** to <b>', () => {
  assert.equal(convertStrayMarkdown('Apple **launched** iOS 18.'), 'Apple <b>launched</b> iOS 18.');
});

test('convertStrayMarkdown: converts __bold__ to <b>', () => {
  assert.equal(convertStrayMarkdown('__Big__ release today.'), '<b>Big</b> release today.');
});

test('convertStrayMarkdown: converts single-asterisk italic when bracketed to <i>', () => {
  assert.equal(convertStrayMarkdown('A *small* update.'), 'A <i>small</i> update.');
});

test('convertStrayMarkdown: keeps mid-word asterisks (e.g. C*-style)', () => {
  // Should NOT match — no surrounding spaces/edges around the * pair.
  assert.equal(convertStrayMarkdown('a*b*c'), 'a*b*c');
});

test('convertStrayMarkdown: converts single-asterisk italic before period to <i>', () => {
  assert.equal(convertStrayMarkdown('Момент *важливий*.'), 'Момент <i>важливий</i>.');
});

test('convertStrayMarkdown: converts single-asterisk italic before comma to <i>', () => {
  assert.equal(convertStrayMarkdown('Це *важливо*, друже.'), 'Це <i>важливо</i>, друже.');
});

test('convertStrayMarkdown: converts adjacent single-asterisk italics to <i>', () => {
  assert.equal(convertStrayMarkdown('Go *fast* and *slow*.'), 'Go <i>fast</i> and <i>slow</i>.');
});

test('convertStrayMarkdown: removes --- horizontal rule lines', () => {
  assert.equal(convertStrayMarkdown('Para 1.\n---\nPara 2.'), 'Para 1.\n\nPara 2.');
});

test('convertStrayMarkdown: collapses 3+ newlines to 2', () => {
  assert.equal(convertStrayMarkdown('a\n\n\n\nb'), 'a\n\nb');
});

test('convertStrayMarkdown: keeps Telegram HTML tags intact', () => {
  const input = '<b>News</b> — <i>Apple</i> released <code>iOS 18</code>.';
  assert.equal(convertStrayMarkdown(input), input);
});

test('convertStrayMarkdown: keeps anchor tags intact', () => {
  const input = '<a href="https://x.com">link</a> here.';
  assert.equal(convertStrayMarkdown(input), input);
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
  assert.equal(cleanFinalText(input), '<b>Apple</b> released <b>iOS 18</b> — read more.');
});

test('cleanFinalText: keeps clean Telegram HTML untouched', () => {
  const input = '<b>Apple</b> випустила <i>iOS 18</i>.\n\n<a href="https://example.com">Деталі</a>.';
  assert.equal(cleanFinalText(input), input);
});

test('cleanFinalText: trims trailing whitespace', () => {
  assert.equal(cleanFinalText('  Apple announced.\n\n  '), 'Apple announced.');
});
