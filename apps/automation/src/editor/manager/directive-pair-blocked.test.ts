/** Spec 058: a cross_promo / repost directive for a pair the owner broke on the map is refused at filing (pair_blocked). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileDirective } from './directive-tools';
import { PAIR_BLOCKED_DETAILS, promoRefsOf } from '../promo/promo-links';

const ORCH = { id: 'o1', handle: 'kira', kind: 'orchestrator', parentId: null, mode: 'live' } as any;

function setup(blocked: Array<[string, string]>) {
  const asked: Array<[string, string]> = [];
  const inserted: any[] = [];
  const deps = {
    repo: {
      openFor: async () => null, appliedFor: async () => null, lastRejected: async () => null, countForRun: async () => 0, countOpenBinding: async () => 0,
      lastDeclinedAdvice: async () => null, update: async () => ({}),
      insert: async (d: any) => { const x = { id: `d${inserted.length + 1}`, ...d, createdAt: new Date() }; inserted.push(x); return x; },
    } as any,
    agents: { getByHandle: async (h: string) => (h.replace('@', '') === 'kira' ? ORCH : null), findTop: async () => null } as any,
    digest: { build: async () => ({ resources: [] }) as any, render: () => '{}' }, inbox: { post: async () => 1 },
    memory: { listActive: async () => [] as any }, actions: { propose: async () => ({}) as any }, channelKeyOf: async () => '@space',
    pairBlocked: async (a: string, b: string) => { asked.push([a, b]); return blocked.some(([x, y]) => (x === a && y === b) || (x === b && y === a)); },
  };
  return { deps, asked, inserted };
}

const input = (kind: string, params: Record<string, unknown>) => ({
  to: '@kira', kind, binding: 'directive' as const, body: 'Промо між каналами мережі', params,
  rationale: 'Аудиторії перетинаються, переходів з промо було 12 за тиждень', evidence: { transitions: 12 },
  expected: { metric: 'transitions', direction: 'up', min_change_pct: 10, resource_ref: 'telegram:@b' }, review_in_days: 7,
} as any);

test('promoRefsOf: the source and the target of a cross_promo and of a repost; other kinds have none', () => {
  assert.deepEqual(promoRefsOf('cross_promo', { source_ref: 'telegram:@a', target_ref: 'instagram:1' }), { sourceRef: 'telegram:@a', targetRef: 'instagram:1' });
  assert.deepEqual(promoRefsOf('repost', { to_ref: 'telegram:@a', post_ref: 'telegram:@b/123' }), { sourceRef: 'telegram:@a', targetRef: 'telegram:@b' });
  assert.equal(promoRefsOf('cross_promo', { source_ref: 'telegram:@a', target_ref: 'telegram:@a' }), null, 'the same resource');
  assert.equal(promoRefsOf('cross_promo', { source_ref: 'nonsense' }), null);
  assert.equal(promoRefsOf('format_shift', { source_ref: 'telegram:@a', target_ref: 'instagram:1' }), null);
});

test('a blocked pair is refused with pair_blocked, either way round, before anything is filed', async () => {
  const s = setup([['telegram:@a', 'instagram:1']]);
  const r: any = await fileDirective(s.deps, input('cross_promo', { source_ref: 'instagram:1', target_ref: 'telegram:@a' }), { from: null, runId: 'r', shadow: false, digest: { resources: [] } as any });
  assert.deepEqual([r.error, r.details], ['pair_blocked', PAIR_BLOCKED_DETAILS]);
  assert.equal(s.inserted.length, 0);
  const rp: any = await fileDirective(s.deps, input('repost', { to_ref: 'telegram:@a', post_ref: 'instagram:1' }), { from: null, runId: 'r', shadow: false, digest: { resources: [] } as any });
  assert.equal(rp.error, 'pair_blocked', 'a repost is about the pair too');
});

test('a pair that is not blocked goes through the other checks; other kinds never ask', async () => {
  const s = setup([]);
  const r: any = await fileDirective(s.deps, input('cross_promo', { source_ref: 'telegram:@a', target_ref: 'instagram:1' }), { from: null, runId: 'r', shadow: false, digest: { resources: [] } as any });
  assert.notEqual(r.error, 'pair_blocked');
  assert.equal(s.asked.length, 1);
  const o = setup([]);
  await fileDirective(o.deps, input('format_shift', { format: 'ig_carousel', weight_delta: 0.2 }), { from: null, runId: 'r', shadow: false, digest: { resources: [] } as any });
  assert.equal(o.asked.length, 0);
});
