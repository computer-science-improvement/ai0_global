import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventText, healthView, MapService, mergeSlotFacts } from './map.service';
import type { SlotFacts } from './map.queries';

const T0 = new Date('2026-10-20T12:00:00Z');

function service(over: Partial<ConstructorParameters<typeof MapService>[0]> = {}, calls = { agents: 0, health: 0 }) {
  let now = T0;
  const svc = new MapService({
    pool: { query: async () => ({ rows: [] }) } as any,
    agents: { list: async () => { calls.agents++; return []; }, activity: async () => new Map() },
    catalog: { list: async () => [] },
    budgets: async () => ({ rows: [], agentCaps: [], blocking: [] }),
    pausedRefs: async () => new Set(),
    health: async () => { calls.health++; return { stuck: [] } as any; },
    now: () => now,
    ...over,
  });
  return { svc, calls, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

test('an empty network gives an empty snapshot, not an error', async () => {
  const { svc } = service();
  const s = await svc.snapshot();
  assert.deepEqual([s.units, s.resources, s.roads, s.alerts, s.events, s.networks], [[], [], [], [], [], []]);
  assert.deepEqual(s.budget, { spentUsd: 0, capUsd: null, pct: null, blocking: false });
  assert.equal(s.generatedAt, T0.toISOString());
});

test('callers share one snapshot for 5 seconds; concurrent callers share one build', async () => {
  const { svc, calls, advance } = service();
  const [a, b] = await Promise.all([svc.snapshot(), svc.snapshot()]);
  assert.equal(a, b);
  assert.equal(calls.agents, 1);
  advance(4_900);
  assert.equal(await svc.snapshot(), a);
  assert.equal(calls.agents, 1);
  advance(200);
  assert.notEqual(await svc.snapshot(), a);
  assert.equal(calls.agents, 2);
});

test('the stuck-work health is read at most once a minute and its failure leaves it out', async () => {
  const { svc, calls, advance } = service({ cacheMs: 0 });
  await svc.snapshot(); advance(1_000); await svc.snapshot();
  assert.equal(calls.health, 1);
  advance(60_000);
  await svc.snapshot();
  assert.equal(calls.health, 2);
  const failing = service({ cacheMs: 0, health: async () => { throw new Error('down'); } });
  assert.deepEqual((await failing.svc.snapshot()).alerts, []);
});

test('a blocking cap is an alert and the global cap fills the top bar', async () => {
  const global = { scopeKind: 'global', dailyUsd: 3, spentTodayUsd: 1.5, label: 'Total AI spend' } as any;
  const { svc } = service({ budgets: async () => ({ rows: [global], agentCaps: [], blocking: [{ kind: 'agent', id: 'a', label: 'Agent @nova', spentUsd: 1, capUsd: 1 }] }) });
  const s = await svc.snapshot();
  assert.deepEqual(s.budget, { spentUsd: 1.5, capUsd: 3, pct: 50, blocking: true });
  assert.equal(s.alerts.length, 1);
  assert.equal(s.alerts[0].kind, 'budget');
  assert.equal(s.alerts[0].path, '/app/spend');
});

test('event texts name a post by its topic only', () => {
  const titleOf = (r?: string | null) => (r === 'instagram:1' ? 'Shop IG' : 'x');
  assert.equal(eventText({ id: 'a', at: T0, kind: 'run_started', extra: 'executor', topic: 'Bridge opens' }, titleOf), 'started writing "Bridge opens"');
  assert.equal(eventText({ id: 'a', at: T0, kind: 'run_finished', extra: 'reviewer' }, titleOf), 'finished reviewing');
  assert.equal(eventText({ id: 'a', at: T0, kind: 'run_failed', extra: 'planner|budget_exceeded' }, titleOf), 'run failed while planning: hit its budget');
  assert.equal(eventText({ id: 'a', at: T0, kind: 'post_published', topic: 'T' }, titleOf), 'published "T"');
  assert.equal(eventText({ id: 'a', at: T0, kind: 'post_failed', topic: 'T', extra: 'publish_failed: the post text said secrets' }, titleOf), 'could not publish "T" (publish_failed)');
  assert.equal(eventText({ id: 'a', at: T0, kind: 'promo', toRef: 'instagram:1', extra: 'cross_promo' }, titleOf), 'promoted Shop IG');
  assert.equal(eventText({ id: 'a', at: T0, kind: 'promo', toRef: 'instagram:1', extra: 'repost' }, titleOf), 'reposted Shop IG');
  assert.equal(eventText({ id: 'a', at: T0, kind: 'directive', extra: 'cross_promo' }, titleOf), 'received a cross promo directive');
  assert.equal(eventText({ id: 'a', at: T0, kind: 'post_published', topic: 'x'.repeat(200) }, titleOf).length < 100, true, 'a long topic is clipped');
});

test('connection states map to the building ring', () => {
  assert.deepEqual(['ok', 'token_expiring', 'rate_limited', 'no_access', 'token_invalid', 'unknown', undefined].map(healthView),
    ['ok', 'warning', 'warning', 'broken', 'broken', 'unknown', 'unknown']);
});

test('slot facts of the resources of a network orchestrator are merged', () => {
  const row = (o: Partial<SlotFacts>): SlotFacts => ({
    ref: 'r', awaiting: 0, awaitingSince: null, postsToday: 0, runningAt: null, runningTopic: null, dueAt: null, dueTopic: null, failedAt: null, failedError: null, ...o,
  });
  const m = mergeSlotFacts([
    row({ awaiting: 2, awaitingSince: new Date('2026-10-20T10:00:00Z'), failedAt: new Date('2026-10-20T11:00:00Z'), failedError: 'a' }),
    row({ awaiting: 1, awaitingSince: new Date('2026-10-20T09:00:00Z'), failedAt: new Date('2026-10-20T11:30:00Z'), failedError: 'b', dueAt: T0, dueTopic: 'D' }),
  ]);
  assert.equal(m.awaiting, 3);
  assert.equal(m.awaitingSince?.toISOString(), '2026-10-20T09:00:00.000Z');
  assert.equal(m.failed?.error, 'b', 'the newest failure');
  assert.equal(m.approvedDue?.topic, 'D');
  assert.equal(m.running, null);
});
