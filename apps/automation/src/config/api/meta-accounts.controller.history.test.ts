import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetaAccountsController } from './meta-accounts.controller';

function make(over: any = {}) {
  const accounts = { findById: async (id: string) => (over.account === undefined ? { id, platform: 'instagram' } : over.account) };
  const graph = {};
  const env = { get: () => 'tok' };
  const history = {
    history: async () => over.points ?? [{ at: new Date('2026-06-01T00:00:00Z'), followers: 100 }],
    latestWithDelta: async () => over.summary ?? { followers: 100, delta24h: 5, delta7d: 20 },
  };
  // Constructor order: accounts, graph, env, history (history added as the 4th param)
  return new MetaAccountsController(accounts as any, graph as any, env as any, history as any);
}

test('follower-history returns current/delta/points shape', async () => {
  const c = make();
  const out = await c.followerHistory('acct-1');
  assert.equal(out.accountId, 'acct-1');
  assert.equal(out.current, 100);
  assert.equal(out.delta24h, 5);
  assert.equal(out.delta7d, 20);
  assert.deepEqual(out.points, [{ at: new Date('2026-06-01T00:00:00Z'), followers: 100 }]);
});

test('follower-history 404s for an unknown account', async () => {
  const c = make({ account: null });
  await assert.rejects(() => c.followerHistory('nope'), /not found/);
});
