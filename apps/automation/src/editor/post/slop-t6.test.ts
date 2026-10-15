/** Spec 037 T6: the slop phrases and clichés found in the DEV channels, the moral closer, abbreviations. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSlopPhrases } from './slop-phrases';
import { moralCloser, sentencesOf, slopCliches, slopWarnings } from './slop-lint';

test('new banned phrases: «зберігайте собі», «признавайся», «здогадаєтеся», «панікувати не варто»', () => {
  assert.deepEqual(findSlopPhrases('П’ять сервісів для бюджету. Зберігайте собі.'), ['зберігайте собі']);
  assert.deepEqual(findSlopPhrases('Признавайся, як у тебе з бекенгом?'), ['признавайся']);
  assert.deepEqual(findSlopPhrases('Здогадаєтеся, який?'), ['здогадаєтеся']);
  assert.deepEqual(findSlopPhrases('Панікувати не варто: дані не втрачено.'), ['панікувати не варто']);
  assert.deepEqual(findSlopPhrases('Збережіть посилання, щоб не загубити.'), []);
});

test('soft clichés: «це той випадок, коли» and a sentence-initial «Коротко —» are slop_cliche warnings', () => {
  assert.deepEqual(slopCliches('EmbeddingGemma — це той випадок, коли менша модель краща.'), ['той випадок коли']);
  assert.deepEqual(slopCliches('Microsoft провела презентацію. Коротко — що анонсували.'), ['коротко —']);
  assert.deepEqual(slopCliches('Пояснимо коротко — без деталей.'), [], 'not sentence-initial');
  const w = slopWarnings({ body: 'Коротко — що анонсували. Нові ноутбуки.' });
  assert.ok(w.some((x) => x.code === 'slop_cliche'));
});

test('moral closer: «мораль» counts, also in the second-to-last sentence; other openers only in the last', () => {
  assert.match(moralCloser('Репо зібрало 244 тис. завантажень. Мораль: перевіряйте ваги.')!, /^Мораль/);
  assert.match(moralCloser('Скан коду не пісочниця. Мораль для всіх, хто тягне open-ваги: навіть trending не гарантія. Репо зібрало ~244 тис. завантажень з інфостілером.')!, /^Мораль/);
  assert.equal(moralCloser('Це означає, що ціни зростуть. Реліз — 15 жовтня.'), null, '«Це означає» mid-text is an ordinary sentence');
  assert.equal(moralCloser('Моральний аспект обговорюють давно. Реліз — 15 жовтня.'), null, 'a word starting with мораль- is not «мораль»');
});

test('sentences: a period before a lowercase word is an abbreviation, not a sentence end', () => {
  assert.deepEqual(sentencesOf('Зібрало ~244 тис. завантажень. Далі буде.'), ['Зібрало ~244 тис. завантажень.', 'Далі буде.']);
  assert.deepEqual(sentencesOf('Що це? так, нова модель!'), ['Що це?', 'так, нова модель!'], 'after ? and ! a split stays');
});
