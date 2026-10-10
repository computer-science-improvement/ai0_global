// Spec 026 FR-004: the pulse's cache, stale-on-error, 503, timeout, claim gating and payload shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServiceUnavailableException } from '@nestjs/common';
import {
  LandingPulseService, PULSE_SQL, autonomyShare, gateClaims, publicMode, toPulseNumbers, type PulseNumbers,
} from './landing-pulse.service';
import { LandingController } from './api/landing.controller';

const ROW = {
  orchestrators_live: 3, orchestrators_shadow: 2, roles_active: ['reviewer', 'planner', 'executor', 'manager'],
  manager_mode: 'live', manager_status: 'active',
  agent_posts: 30, all_posts: 40,
  platforms: [{ platform: 'instagram', posts: 10, agentPosts: 10 }, { platform: 'telegram', posts: 30, agentPosts: 20 }, { platform: 'myspace', posts: 1, agentPosts: 1 }],
  agent_runs: 120, skipped_by_agents: 4, directives_filed: 3, manager_reviews: 7, ideas_reviewed: 12, owner_decisions: 5,
  last_agent_post_at: new Date('2026-10-08T09:41:37.123Z'),
};

/** A pool whose client answers the pulse statement with `row()` (or throws). */
function fakePool(row: () => Record<string, unknown>) {
  const log: string[] = [];
  let released = 0;
  const pool = {
    log,
    get released() { return released; },
    connect: async () => ({
      query: async (sql: string) => {
        log.push(sql.trim().split('\n')[0]);
        if (sql === PULSE_SQL) return { rows: [row()] };
        return { rows: [] };
      },
      release: () => { released++; },
    }),
  };
  return pool as typeof pool & any; // structurally enough for the service
}

test('row → numbers: ordering, unknown kinds dropped, minute rounding, share', () => {
  const n = toPulseNumbers(ROW);
  assert.deepEqual(n.agents, { orchestratorsLive: 3, orchestratorsShadow: 2, rolesActive: ['planner', 'executor', 'reviewer'], manager: 'live' });
  assert.deepEqual(n.last7d.platforms, [
    { platform: 'telegram', posts: 30, agentPosts: 20 },
    { platform: 'instagram', posts: 10, agentPosts: 10 },
  ]);
  assert.equal(n.last7d.autonomyShare, 75);
  assert.equal(n.lastAgentPostAt, '2026-10-08T09:41:00.000Z');
  const empty = toPulseNumbers({});
  assert.equal(empty.lastAgentPostAt, null);
  assert.equal(empty.agents.manager, 'off');
  assert.deepEqual(empty.last7d.platforms, []);
  assert.equal(empty.last7d.autonomyShare, 0);
});

test('autonomy share and public modes', () => {
  assert.equal(autonomyShare(0, 0), 0);
  assert.equal(autonomyShare(1, 3), 33);
  assert.equal(autonomyShare(2, 3), 67);
  assert.equal(autonomyShare(5, 5), 100);
  assert.equal(publicMode('approve', 'active'), 'live', 'approval mode publishes: it counts as live');
  assert.equal(publicMode('live', 'paused'), 'off');
  assert.equal(publicMode('shadow', 'active'), 'shadow');
  assert.equal(publicMode('off', 'active'), 'off');
  assert.equal(publicMode(null, null), 'off');
});

test('claim gating: the manager claim needs live mode and a review in the window', () => {
  const base = toPulseNumbers(ROW);
  const with_ = (manager: PulseNumbers['agents']['manager'], reviews: number): PulseNumbers =>
    ({ ...base, agents: { ...base.agents, manager }, last7d: { ...base.last7d, managerReviews: reviews } });
  assert.deepEqual(gateClaims(with_('live', 7)), { managerLive: true });
  assert.deepEqual(gateClaims(with_('live', 0)), { managerLive: false });
  assert.deepEqual(gateClaims(with_('shadow', 7)), { managerLive: false });
  assert.deepEqual(gateClaims(with_('off', 0)), { managerLive: false });
  assert.deepEqual(gateClaims(toPulseNumbers({})), { managerLive: false }, 'an empty DB makes no claims');
});

test('the payload has no ids, handles, names, costs or personal data', async () => {
  const svc = new LandingPulseService(fakePool(() => ROW));
  const p = await svc.get();
  const keys: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); }
  };
  walk(p);
  for (const k of keys) assert.doesNotMatch(k, /id$|Id$|handle|name|cost|usd|spend|email|phone|contact|username/i, k);
  const text = JSON.stringify(p);
  assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-/i, 'no uuid');
  assert.doesNotMatch(text, /@/, 'no handle');
  assert.deepEqual(Object.keys(p).sort(), ['agents', 'claims', 'generatedAt', 'last7d', 'lastAgentPostAt', 'stale']);
});

test('read-only transaction with a 2 s statement timeout, always rolled back and released', async () => {
  const pool = fakePool(() => ROW);
  await new LandingPulseService(pool).get();
  assert.deepEqual(pool.log.slice(0, 2), ['BEGIN READ ONLY', 'SET LOCAL statement_timeout = 2000']);
  assert.equal(pool.log.at(-1), 'ROLLBACK');
  assert.equal(pool.released, 1);
});

test('300 s cache, then stale-on-error for up to 1 h, then 503', async () => {
  let now = 10_000_000;
  let fail = false;
  let reads = 0;
  const pool = fakePool(() => { reads++; if (fail) throw new Error('db down'); return ROW; });
  const svc = new LandingPulseService(pool, { now: () => now });

  const first = await svc.get();
  assert.equal(first.stale, false);
  assert.equal(reads, 1);
  now += 299_000;
  await svc.get();
  assert.equal(reads, 1, 'served from the cache');

  fail = true;
  now += 2_000; // 301 s: expired, refresh fails → stale
  const stale = await svc.get();
  assert.equal(stale.stale, true);
  assert.equal(stale.last7d.agentPosts, 30);
  assert.equal(reads, 2);
  now += 10_000;
  await svc.get();
  assert.equal(reads, 2, 'no retry within 30 s of a failure');
  now += 25_000;
  await svc.get();
  assert.equal(reads, 3, 'retried after 30 s');

  now = 10_000_000 + 3_600_000 + 1; // more than 1 h after the last good value
  await assert.rejects(svc.get(), ServiceUnavailableException);

  fail = false;
  now += 31_000;
  const back = await svc.get();
  assert.equal(back.stale, false, 'recovers once the DB answers');
});

test('cold start with a failing DB: 503 at once', async () => {
  const svc = new LandingPulseService(fakePool(() => { throw new Error('db down'); }));
  await assert.rejects(svc.get(), ServiceUnavailableException);
});

test('a pool that never hands out a connection times out', async () => {
  const pool = { connect: () => new Promise<never>(() => undefined) };
  const svc = new LandingPulseService(pool as any, { statementTimeoutMs: 20 });
  const t0 = Date.now();
  // The service's guard timer is unref'd (it must not keep a server process alive); here nothing else holds the
  // event loop, and Node 20's test runner would cancel the test before the timer fires.
  const keepAlive = setInterval(() => undefined, 1_000);
  try {
    await assert.rejects(svc.get(), ServiceUnavailableException);
  } finally {
    clearInterval(keepAlive);
  }
  assert.ok(Date.now() - t0 < 2_000);
});

test('concurrent visitors share one query', async () => {
  let reads = 0;
  const svc = new LandingPulseService(fakePool(() => { reads++; return ROW; }));
  await Promise.all([svc.get(), svc.get(), svc.get()]);
  assert.equal(reads, 1);
});

test('controller: Cache-Control public 300 on success, no-store on a 503', async () => {
  const headers: Record<string, string> = {};
  const res = { setHeader: (k: string, v: string) => { headers[k] = v; } } as any;
  const ok = new LandingController({} as any, {} as any, new LandingPulseService(fakePool(() => ROW)));
  await ok.pulse(res);
  assert.equal(headers['Cache-Control'], 'public, max-age=300');

  const down = new LandingController({} as any, {} as any, new LandingPulseService(fakePool(() => { throw new Error('x'); })));
  await assert.rejects(down.pulse(res), ServiceUnavailableException);
  assert.equal(headers['Cache-Control'], 'no-store');
});
