import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lintPost } from '../lint-post';
import { makeCard } from '../testing/fixtures';
import { PostSpecSchema } from '../post-spec';
import { REVIEW2_POSTS } from './testing/review2-regression';

/** Spec 041 FR-009 (T9): lint on the review-2 defects finds what the review found; the critic's cases are listed. */

for (const r of REVIEW2_POSTS) {
  test(`review 2 · ${r.id} ${r.channel}: ${r.defect}`, () => {
    const parsed = PostSpecSchema.safeParse(r.spec);
    assert.ok(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues));
    const res = lintPost(parsed.data!, makeCard({ channelKey: r.channel, ...r.card }));
    const found = new Set([...res.errors, ...res.warnings].map((x) => x.code));
    for (const code of r.expect) assert.ok(found.has(code), `${code} not found; got ${[...found].join(', ')}`);
    // A critic-only defect must not be blocked by a language error lint cannot justify.
    if (!r.expect.length) assert.ok(!res.errors.some((e) => e.code.startsWith('language_')), JSON.stringify(res.errors));
  });
}

test('review 2: every critic-only defect has an eval case for spec 051 (not run here: paid calls)', () => {
  const evals = JSON.parse(readFileSync(join(__dirname, '..', '..', 'critic', 'evals', 'review2-cases.json'), 'utf8')) as { cases: Array<{ id: string; post_id: number }> };
  const ids = new Set(evals.cases.map((c) => c.id));
  for (const r of REVIEW2_POSTS.filter((x) => x.critic_case)) assert.ok(ids.has(r.critic_case!), r.critic_case);
  assert.deepEqual(evals.cases.map((c) => c.post_id).sort(), [1713, 1717, 1719, 1724]);
  assert.equal(REVIEW2_POSTS.length, 10);
});
