/**
 * Spec 073 FR-013 (A38): a new card asks for no hashtags (it has no vocabulary), an existing card keeps its own minimum, and a
 * library source takes a dataset key with digits (`pdr_questions_2025`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CARD_DEFAULTS, mergeCard } from './card-input';
import { makeCard } from '../post/testing/fixtures';

const issues = (r: ReturnType<typeof mergeCard>) => (r.ok ? [] : r.issues.map((i) => `${i.path.join('.')}: ${i.message}`));

test('CARD_DEFAULTS.hashtagMin is 0, and a new card made through the API starts with no hashtag minimum', () => {
  assert.equal(CARD_DEFAULTS.hashtagMin, 0);
  const r = mergeCard('@new', null, { brief: 'Питання ПДР' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual([r.card.hashtags, r.card.hashtagMin, r.card.hashtagMax], [[], 0, 3]);
});

test('mergeCard keeps hashtagMin 1 on an existing card with a vocabulary', () => {
  const existing = makeCard({ hashtags: ['ai', 'ml'], hashtagMin: 1, hashtagMax: 3 });
  const r = mergeCard(existing.channelKey, existing, { brief: 'Нове означення' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual([r.card.hashtags, r.card.hashtagMin], [['ai', 'ml'], 1]);
  // A patch of its own wins either way.
  const asked = mergeCard(existing.channelKey, existing, { hashtagMin: 2 });
  assert.equal(asked.ok && asked.card.hashtagMin, 2);
});

test('a library source takes a dataset key with digits; the shape of a schema key is still enforced', () => {
  const lib = (ref: string) => mergeCard('@chan', makeCard(), { sources: [{ id: 'lib', kind: 'library', ref }] });
  assert.equal(lib('pdr_questions_2025').ok, true, issues(lib('pdr_questions_2025')).join('; '));
  assert.equal(lib('facts').ok, true);
  assert.equal(lib('a1').ok, true);
  for (const bad of ['2025_questions', 'Facts', 'pdr-questions', 'pdr questions', 'x', '']) {
    assert.ok(issues(lib(bad)).some((m) => m.startsWith('sources.0.ref')), `${JSON.stringify(bad)} should be refused`);
  }
});
