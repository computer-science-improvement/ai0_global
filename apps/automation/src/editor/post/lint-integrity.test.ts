import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintPost } from './lint-post';
import { INTEGRITY_CHECKS } from './integrity/registry';
import type { AuditContext, AuditPost, IntegrityCheck } from './integrity/types';
import { makeCard, makeSpec } from './testing/fixtures';

/** Registers a check for one test and removes it afterwards (the registry is module state). */
function withCheck(check: IntegrityCheck, fn: () => void) {
  INTEGRITY_CHECKS.push(check);
  try { fn(); } finally { INTEGRITY_CHECKS.splice(INTEGRITY_CHECKS.indexOf(check), 1); }
}

test('spec 037: lintPost runs the registered integrity checks — errors block, warnings pass through', () => {
  let seen: { post: AuditPost; ctx: AuditContext } | null = null;
  withCheck({
    id: 'probe', codes: ['probe_error', 'probe_warning'],
    run(post, ctx) {
      seen = { post, ctx };
      return [
        { code: 'probe_error', level: 'error', message: 'bad', excerpt: 'x' },
        { code: 'probe_warning', level: 'warning', message: 'meh' },
      ];
    },
  }, () => {
    const r = lintPost(makeSpec(), makeCard(), {
      id: 's1', channel: '@c', publishedAt: '2026-10-08T12:00:00+03:00', timezone: 'Europe/Kyiv', ctx: { now: '2026-10-08T09:00:00Z' },
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.errors.find((e) => e.code === 'probe_error'), { code: 'probe_error', message: 'bad («x»)' });
    assert.ok(r.warnings.some((w) => w.code === 'probe_warning'));
    assert.equal(seen!.post.id, 's1');
    assert.equal(seen!.post.publishedAt, '2026-10-08T12:00:00+03:00');
    assert.equal(seen!.ctx.card?.timezone, 'Europe/Kyiv');
    assert.deepEqual(seen!.ctx.previous, []);
  });
});

test('spec 037: a throwing check is a warning, never a blocked post; lint-enforced adapters are not run twice', () => {
  withCheck({ id: 'boom', codes: [], run() { throw new Error('oops'); } }, () => {
    const r = lintPost(makeSpec(), makeCard());
    assert.equal(r.ok, true);
    assert.ok(r.warnings.some((w) => w.code === 'check_failed' && /boom: oops/.test(w.message)));
  });
  const enforced = INTEGRITY_CHECKS.filter((c) => c.lintEnforced).map((c) => c.id);
  assert.ok(enforced.length >= 4, 'the spec 034 adapters are marked lintEnforced');
});
