/** Spec 037 T6: broken characters, mixed scripts and the attribution helpers. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attributionOf, findBrokenChars, findMixedScriptWords, fixHomoglyphWord, mixKind, sourceNames } from './text-hygiene';

test('broken chars: U+FFFD, control, zero-width inside a word, mojibake — each with the word it sits in', () => {
  assert.deepEqual(findBrokenChars('Постраждалі пе��еважно в Азії.'), [{ kind: 'replacement', excerpt: 'пе��еважно' }]);
  assert.deepEqual(findBrokenChars('ціна\u0007 впала').map((b) => b.kind), ['control']);
  assert.deepEqual(findBrokenChars('при​віт'), [{ kind: 'zero_width', excerpt: 'при[U+200B]віт' }]);
  assert.deepEqual(findBrokenChars('РџСЂРёРІС–С‚ світ').map((b) => b.kind), ['mojibake'], 'UTF-8 read as windows-1251');
  assert.deepEqual(findBrokenChars('ÐŸÑ€Ð¸Ð²Ñ–Ñ‚').map((b) => b.kind), ['mojibake'], 'UTF-8 read as windows-1252');
  assert.deepEqual(findBrokenChars('it’s â€œquotedâ€').map((b) => b.kind), ['mojibake']);
});

test('broken chars: clean Ukrainian, emoji ZWJ sequences, tabs and new lines are fine', () => {
  for (const t of [
    'Рівне, Сіль, Сім і Ріка — звичайні слова. Ціна 1,05 грн.',
    'Команда 👨‍👩‍👧 у відпустці 🏳️‍🌈',
    'рядок\tз табом\nі новий рядок\r\n',
    'São Paulo, España, AÑO, café, naïve',
  ]) assert.deepEqual(findBrokenChars(t), [], t);
});

test('mixed scripts: a real mix and a mixed hashtag are errors; a hyphen separates scripts legitimately', () => {
  const w = findMixedScriptWords('Кооперативний хорор про корпорацію Меркoff. #aiновини #ШІ #ainews iPhone-ом, AI-агент, Wi-Fi, ШІ-модель, GPT-5');
  assert.deepEqual(w, [
    { word: 'Меркoff', kind: 'mixed', hashtag: false },
    { word: '#aiновини', kind: 'mixed', hashtag: true },
  ]);
});

test('mixed scripts: homoglyph-only words are fixable; Latin words with a Cyrillic look-alike are not turned Cyrillic', () => {
  assert.equal(mixKind('пpивіт'), 'homoglyph');
  assert.equal(fixHomoglyphWord('пpивіт'), 'привіт');
  assert.equal(fixHomoglyphWord('Kиїв'), 'Київ');
  assert.equal(mixKind('Аpp'), 'mixed', 'Cyrillic А + Latin pp: more Latin than Cyrillic, not fixed');
  assert.equal(fixHomoglyphWord('aiновини'), 'aiновини', 'a Latin word glued to the edge is a real mix, not a typo');
  assert.equal(fixHomoglyphWord('Аpp'), 'Аpp');
  assert.equal(mixKind('Apple'), null);
  assert.equal(mixKind('яблуко'), null);
  assert.deepEqual(findMixedScriptWords('див. https://example.com/пpивіт і user@пошта.com'), [], 'URLs and e-mails are not words');
});

test('attribution: «Джерело: X» / «За даними X» naming the rendered source', () => {
  const names = sourceNames('https://techcrunch.com/2026/10/08/x/', 'TechCrunch');
  assert.deepEqual(names, ['techcrunch']);
  assert.ok(attributionOf('Джерело: Financial Times через TechCrunch', names));
  assert.ok(attributionOf('За даними TechCrunch.', names));
  assert.equal(attributionOf('Джерело: Reuters', names), null, 'another source');
  assert.equal(attributionOf('За даними розслідувань, імплант перехоплює екран.', names), null);
  assert.deepEqual(sourceNames('https://www.marktechpost.com/', null), ['marktechpost']);
});
