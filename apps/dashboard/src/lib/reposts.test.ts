// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 037 T2: own vs repost counts on Analytics and the "Repost from @…" badge in the posts list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evergreenBadge, ownViewsSpark, repostBadge, splitReposts } from './reposts';

test('own vs reposts: counted apart, the average views read own posts only', () => {
  const s = splitReposts([
    { views: 100 }, { views: 300, repostFrom: null }, { views: 5000, repostFrom: 'ai_tech' },
  ]);
  assert.deepEqual(s, { own: 2, reposts: 1, share: 1 / 3, evergreen: 0, evergreenShare: 0, avgOwnViews: 200 });
  assert.deepEqual(splitReposts([]), { own: 0, reposts: 0, share: null, evergreen: 0, evergreenShare: null, avgOwnViews: null });
  assert.equal(splitReposts([{ views: 10, repostFrom: 'x' }]).avgOwnViews, null);
});

test('spec 037 T10: evergreen posts are their own category — not own fresh posts, not reposts', () => {
  const s = splitReposts([{ views: 100 }, { views: 40, evergreen: true }, { views: 5000, repostFrom: 'ai_tech' }, { views: 300 }]);
  assert.deepEqual([s.own, s.evergreen, s.reposts], [2, 1, 1]);
  assert.equal(s.evergreenShare, 0.25);
  assert.equal(s.avgOwnViews, 200, 'evergreen views stay out of the own average');
  assert.equal(evergreenBadge(true), 'Evergreen');
  assert.equal(evergreenBadge(undefined), null);
});

test('repost badge text is English and names the source channel', () => {
  assert.equal(repostBadge('ai_tech'), 'Repost from @ai_tech');
  assert.equal(repostBadge('@ai_tech'), 'Repost from @ai_tech');
  assert.equal(repostBadge(null), null);
});

test('ownViewsSpark: the last own fresh posts, oldest first; reposts and evergreen left out', () => {
  const posts = [
    { views: 50 }, { views: 900, repostFrom: '@sib' }, { views: 40, evergreen: true }, { views: 30 }, { views: null }, { views: 10 },
  ];
  assert.deepEqual(ownViewsSpark(posts), [10, 0, 30, 50]);
  assert.deepEqual(ownViewsSpark(posts, 2), [30, 50]);
  assert.deepEqual(ownViewsSpark([]), []);
});
