import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict } from './semantic-dedup.service';

test('parseVerdict: exact verdict words', () => {
  assert.equal(parseVerdict('DUPLICATE'), 'DUPLICATE');
  assert.equal(parseVerdict('UPDATE'), 'UPDATE');
  assert.equal(parseVerdict('NEW'), 'NEW');
});

test('parseVerdict: tolerates case, whitespace, quotes, markdown and trailing punctuation', () => {
  assert.equal(parseVerdict('  duplicate\n'), 'DUPLICATE');
  assert.equal(parseVerdict('**DUPLICATE**'), 'DUPLICATE');
  assert.equal(parseVerdict('"UPDATE".'), 'UPDATE');
  assert.equal(parseVerdict('`New`'), 'NEW');
});

test('parseVerdict: negations are NOT duplicates (the substring bug)', () => {
  assert.equal(parseVerdict('NOT A DUPLICATE'), 'NEW');
  assert.equal(parseVerdict('not duplicate'), 'NEW');
  assert.equal(parseVerdict('NOT_DUPLICATE'), 'NEW');
  assert.equal(parseVerdict('Not an update'), 'NEW');
  assert.equal(parseVerdict('UNIQUE'), 'NEW');
  assert.equal(parseVerdict('NEW — not a duplicate of the earlier post'), 'NEW');
});

test('parseVerdict: verdict must be the leading whole word', () => {
  assert.equal(parseVerdict('DUPLICATES'), 'NEW');
  assert.equal(parseVerdict('UPDATED'), 'NEW');
  assert.equal(parseVerdict('NEWS about a duplicate'), 'NEW');
  assert.equal(parseVerdict('This could be a DUPLICATE'), 'NEW'); // fail-open on prose
});

test('parseVerdict: empty / null fails open to NEW', () => {
  assert.equal(parseVerdict(null), 'NEW');
  assert.equal(parseVerdict(''), 'NEW');
  assert.equal(parseVerdict('   '), 'NEW');
});
