// Spec 027 FR-010: badge counts — one statement, 10 s cache, single flight,
// null for a missing table, per-key isolation when the statement fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BADGE_KEYS, NavBadgesService } from './nav-badges.service';

function fakePool(o: { missing?: string[]; failCombined?: boolean; failKey?: string } = {}) {
  const calls: string[] = [];
  const pool = {
    query: async (sql: string, params: any[] = []) => {
      calls.push(sql);
      if (sql.includes('to_regclass')) {
        return { rows: [Object.fromEntries(params.map((t: string) => [t, !(o.missing ?? []).includes(t)]))] };
      }
      if (sql.includes('SELECT\n')) {
        if (o.failCombined) throw new Error('column "severity" does not exist');
        const row: Record<string, number | null> = {};
        BADGE_KEYS.forEach((k, i) => { row[k] = new RegExp(`NULL::int AS "${k}"`).test(sql) ? null : i + 1; });
        return { rows: [row] };
      }
      // Per-key retry.
      if (o.failKey && sql.includes(o.failKey)) throw new Error('boom');
      return { rows: [{ n: '7' }] };
    },
  };
  return { pool, calls };
}

test('one statement for every count, then served from the 10 s cache', async () => {
  let now = Date.parse('2026-10-06T09:00:00Z');
  const { pool, calls } = fakePool();
  const svc = new NavBadgesService(pool as any, () => new Date(now));
  const a = await svc.get();
  assert.deepEqual(Object.keys(a.counts), [...BADGE_KEYS]);
  assert.equal(a.counts.agentInboxUnread, 1);
  assert.equal(a.counts.scheduledFailedToday, 8);
  assert.equal(calls.filter((s) => s.includes('SELECT\n')).length, 1);
  assert.equal(calls.length, 2, 'probe + one statement');
  now += 9_000;
  await svc.get();
  assert.equal(calls.length, 2, 'cached');
  now += 2_000;
  await svc.get();
  assert.equal(calls.length, 3, 'refreshed after 10 s; the table probe is cached for longer');
});

test('fresh skips the 10 s cache but not a result younger than 1 s', async () => {
  let now = Date.parse('2026-10-06T09:00:00Z');
  const { pool, calls } = fakePool();
  const svc = new NavBadgesService(pool as any, () => new Date(now));
  await svc.get();
  now += 500;
  await svc.get({ fresh: true });
  assert.equal(calls.length, 2, 'a 0.5 s old result is fresh enough');
  now += 1_000;
  await svc.get({ fresh: true });
  assert.equal(calls.length, 3);
});

test('concurrent requests share one query', async () => {
  const { pool, calls } = fakePool();
  const svc = new NavBadgesService(pool as any);
  await Promise.all([svc.get(), svc.get(), svc.get()]);
  assert.equal(calls.length, 2);
});

test('a missing table is null for its keys and is not queried', async () => {
  const { pool, calls } = fakePool({ missing: ['agent_actions', 'agent_directives'] });
  const { counts } = await new NavBadgesService(pool as any).get();
  assert.equal(counts.dmActionsPending, null);
  assert.equal(counts.directivesAwaitingOwner, null);
  assert.equal(counts.dmThreadsNew, 5);
  assert.ok(!calls.some((s) => s.includes('FROM agent_actions')));
});

test('a failing statement is retried per key; a failing key is null, never a 500', async () => {
  const { pool } = fakePool({ failCombined: true, failKey: 'FROM editor_slots' });
  const { counts } = await new NavBadgesService(pool as any).get();
  assert.equal(counts.slotsFailedToday, null);
  assert.equal(counts.agentInboxUnread, 7);
  const down = { query: async () => { throw new Error('db down'); } };
  const r = await new NavBadgesService(down as any).get();
  assert.ok(Object.values(r.counts).every((v) => v === null));
});
