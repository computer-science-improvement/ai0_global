import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jaccardSimilarity, scoreCandidate } from './recommendations.service';

test('jaccardSimilarity: returns 0 when either side is empty', () => {
  assert.equal(jaccardSimilarity([], ['a']), 0);
  assert.equal(jaccardSimilarity(['a'], []), 0);
  assert.equal(jaccardSimilarity([], []), 0);
});

test('jaccardSimilarity: returns 1 for identical sets', () => {
  assert.equal(jaccardSimilarity(['a', 'b'], ['a', 'b']), 1);
  assert.equal(jaccardSimilarity(['b', 'a'], ['a', 'b']), 1);
});

test('jaccardSimilarity: returns 0 for disjoint sets', () => {
  assert.equal(jaccardSimilarity(['a', 'b'], ['c', 'd']), 0);
});

test('jaccardSimilarity: returns 1/3 for half overlap', () => {
  // |∩|=1, |∪|=3 → 1/3
  const v = jaccardSimilarity(['a', 'b'], ['a', 'c']);
  assert.ok(Math.abs(v - 1 / 3) < 1e-9, `expected ≈ 0.333, got ${v}`);
});

test('jaccardSimilarity: deduplicates within each set before computing', () => {
  assert.equal(jaccardSimilarity(['a', 'a', 'b'], ['a', 'b']), 1);
});

test('jaccardSimilarity: is case-sensitive', () => {
  assert.equal(jaccardSimilarity(['A'], ['a']), 0);
});

test('scoreCandidate: returns the Jaccard score', () => {
  const v = scoreCandidate(
    { themes: ['a', 'b'] },
    { themes: ['a', 'c'] },
  );
  assert.ok(Math.abs(v - 1 / 3) < 1e-9, `expected ≈ 0.333, got ${v}`);
});

test('scoreCandidate: returns 0 when candidate themes empty', () => {
  assert.equal(
    scoreCandidate({ themes: ['a'] }, { themes: [] }),
    0,
  );
});

test('scoreCandidate: handles missing themes property defensively', () => {
  assert.equal(scoreCandidate({}, { themes: ['a'] }), 0);
  assert.equal(scoreCandidate({ themes: ['a'] }, {}), 0);
});
