import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetaStatsCollectorService } from './meta-stats-collector.service';

function build(over: any = {}) {
  const inserted: any[] = [];
  const verifyErrors: any[] = [];
  const accounts = {
    list: async () => over.accounts ?? [
      { id: 'a1', platform: 'instagram', target_id: 'ig1', token_env: 'IG_TOKEN', active: true },
    ],
    markVerified: async () => {},
    markVerifyError: async (id: string, msg: string) => { verifyErrors.push([id, msg]); },
  };
  const graph = {
    verify: over.verify ?? (async () => ({ username: 'u', displayName: 'd', followers: 500, pictureUrl: null })),
    fetchInsights: over.fetchInsights ?? (async () => []),
  };
  const history = { insert: async (id: string, f: number) => { inserted.push([id, f]); } };
  const insights = { upsertDay: async () => {} };
  const config = { get: (k: string) => (over.env ?? { IG_TOKEN: 'tok' })[k] };
  const svc = new MetaStatsCollectorService(accounts as any, graph as any, history as any, insights as any, config as any);
  return { svc, inserted, verifyErrors };
}

test('inserts a snapshot when followers is a number', async () => {
  const { svc, inserted } = build();
  const r = await svc.runOnce();
  assert.deepEqual(inserted, [['a1', 500]]);
  assert.deepEqual(r, { accounts: 1, snapshots: 1, insightDays: 0 });
});

test('inserts nothing when followers is null (e.g. Threads)', async () => {
  const { svc, inserted } = build({ verify: async () => ({ username: 'u', displayName: 'd', followers: null, pictureUrl: null }) });
  const r = await svc.runOnce();
  assert.deepEqual(inserted, []);
  assert.equal(r.snapshots, 0);
});

test('skips accounts whose token env is unset', async () => {
  const { svc, inserted } = build({ env: {} });
  const r = await svc.runOnce();
  assert.deepEqual(inserted, []);
  assert.equal(r.snapshots, 0);
  assert.equal(r.accounts, 0); // a no-token skip is not counted as attempted
});

test('a failing account does not abort the loop; error is recorded', async () => {
  const accounts = [
    { id: 'a1', platform: 'instagram', target_id: 'ig1', token_env: 'IG_TOKEN', active: true },
    { id: 'a2', platform: 'facebook',  target_id: 'fb1', token_env: 'IG_TOKEN', active: true },
  ];
  let n = 0;
  const verify = async () => { n++; if (n === 1) throw new Error('boom'); return { username: 'u', displayName: 'd', followers: 42, pictureUrl: null }; };
  const { svc, inserted, verifyErrors } = build({ accounts, verify });
  const r = await svc.runOnce();
  assert.deepEqual(inserted, [['a2', 42]]);
  assert.equal(verifyErrors[0][0], 'a1');
  assert.deepEqual(r, { accounts: 2, snapshots: 1, insightDays: 0 });
});

test('collects insights per active account and isolates insights failures', async () => {
  const calls = { upserts: [] as any[], followerInserts: [] as any[] };
  const accounts = {
    list: async () => [{ id: 'a1', platform: 'instagram', target_id: 'IG1', token_env: 'IG_TOKEN', active: true }],
    markVerified: async () => {}, markVerifyError: async () => {},
  };
  const graph = {
    verify: async () => ({ username: 'u', displayName: 'U', followers: 10, pictureUrl: null }),
    fetchInsights: async () => [{ day: '2026-06-10', reach: 100, impressions: null, profileViews: 5 }],
  };
  const history = { insert: async (id: string, f: number) => { calls.followerInserts.push([id, f]); } };
  const insights = { upsertDay: async (id: string, day: string, m: any) => { calls.upserts.push([id, day, m]); } };
  const config = { get: () => 'token-value' };
  const c = new MetaStatsCollectorService(accounts as any, graph as any, history as any, insights as any, config as any);
  const res = await c.runOnce();
  assert.deepEqual(calls.followerInserts, [['a1', 10]]);
  assert.deepEqual(calls.upserts, [['a1', '2026-06-10', { reach: 100, impressions: null, profileViews: 5 }]]);
  assert.equal(res.insightDays, 1);
});

test('insights failure is isolated — follower snapshot still happens', async () => {
  const calls = { upserts: [] as any[], followerInserts: [] as any[] };
  const accounts = {
    list: async () => [{ id: 'a1', platform: 'instagram', target_id: 'IG1', token_env: 'IG_TOKEN', active: true }],
    markVerified: async () => {}, markVerifyError: async () => {},
  };
  const graph = {
    verify: async () => ({ username: 'u', displayName: 'U', followers: 10, pictureUrl: null }),
    fetchInsights: async () => { throw new Error('insights boom'); },
  };
  const history = { insert: async (id: string, f: number) => { calls.followerInserts.push([id, f]); } };
  const insights = { upsertDay: async () => { calls.upserts.push('x'); } };
  const config = { get: () => 'token-value' };
  const c = new MetaStatsCollectorService(accounts as any, graph as any, history as any, insights as any, config as any);
  const res = await c.runOnce();
  assert.deepEqual(calls.followerInserts, [['a1', 10]]);   // follower snapshot survived
  assert.deepEqual(calls.upserts, []);                      // no insight upserts
  assert.equal(res.insightDays, 0);
});
