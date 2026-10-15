// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 037 T2: own vs repost counts on Analytics and the "Repost from @…" badge in the posts list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repostBadge, splitReposts } from './reposts';

test('own vs reposts: counted apart, the average views read own posts only', () => {
  const s = splitReposts([
    { views: 100 }, { views: 300, repostFrom: null }, { views: 5000, repostFrom: 'ai_tech' },
  ]);
  assert.deepEqual(s, { own: 2, reposts: 1, share: 1 / 3, avgOwnViews: 200 });
  assert.deepEqual(splitReposts([]), { own: 0, reposts: 0, share: null, avgOwnViews: null });
  assert.equal(splitReposts([{ views: 10, repostFrom: 'x' }]).avgOwnViews, null);
});

test('repost badge text is English and names the source channel', () => {
  assert.equal(repostBadge('ai_tech'), 'Repost from @ai_tech');
  assert.equal(repostBadge('@ai_tech'), 'Repost from @ai_tech');
  assert.equal(repostBadge(null), null);
});
