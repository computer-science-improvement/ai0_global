import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTier } from './tier-classifier';

test('classifyTier: returns "hot" when ≥ 3 posts/day', () => {
  assert.equal(classifyTier({ postsLast7d: 21 }), 'hot');
  assert.equal(classifyTier({ postsLast7d: 50 }), 'hot');
});

test('classifyTier: returns "warm" for 0.5–3 posts/day', () => {
  assert.equal(classifyTier({ postsLast7d: 4 }),  'warm');  // ~0.57/day
  assert.equal(classifyTier({ postsLast7d: 20 }), 'warm'); // ~2.86/day
});

test('classifyTier: returns "cold" for < 0.5 posts/day', () => {
  assert.equal(classifyTier({ postsLast7d: 3 }), 'cold'); // ~0.43/day
  assert.equal(classifyTier({ postsLast7d: 0 }), 'cold');
});

test('classifyTier: returns "warm" for brand-new channels (no history)', () => {
  assert.equal(classifyTier({ postsLast7d: 0, daysSinceAdded: 0 }), 'warm');
  assert.equal(classifyTier({ postsLast7d: 0, daysSinceAdded: 2 }), 'warm');
});
