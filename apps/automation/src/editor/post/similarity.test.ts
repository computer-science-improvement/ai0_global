import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeForSimilarity, similarity, topMatches } from './similarity';

test('normalize strips html, urls, hashtags, punctuation', () => {
  assert.equal(normalizeForSimilarity('<b>Привіт</b>, світ! https://x.y/z #тег'), 'привіт світ');
});

test('identical text scores 1, unrelated scores low', () => {
  assert.equal(similarity('Борщ з пампушками', 'борщ з пампушками!'), 1);
  assert.ok(similarity('Борщ з пампушками', 'Запуск ракети SpaceX') < 0.2);
});

test('reworded text scores high', () => {
  const a = 'NASA запустила новий телескоп для пошуку екзопланет';
  const b = 'NASA запустило новий телескоп, щоб шукати екзопланети';
  assert.ok(similarity(a, b) > 0.6);
});

test('empty input scores 0', () => {
  assert.equal(similarity('', 'x'), 0);
});

test('topMatches sorts by score', () => {
  const res = topMatches('борщ український', [{ text: 'ракета' }, { text: 'український борщ' }], 1);
  assert.equal(res[0].text, 'український борщ');
});
