import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetaAccountsController } from './meta-accounts.controller';
import { SecretsService } from '../../common/crypto/secrets.service';

const secrets = () => new SecretsService({ get: () => undefined } as any);

function make(over: any = {}) {
  const accounts = {
    findById: async (id: string) => (over.account === undefined ? { id, platform: 'instagram' } : over.account),
    list: async () => over.accountsList ?? [],
  };
  const graph = {};
  const env = { get: () => 'tok' };
  const history = {
    history: async () => over.points ?? [{ at: new Date('2026-06-01T00:00:00Z'), followers: 100 }],
    latestWithDelta: async () => over.summary ?? { followers: 100, delta24h: 5, delta7d: 20 },
    delta24hByAccount: async () => over.deltas ?? new Map([['acc-1', 7]]),
  };
  const insights = { history: async () => over.insightPoints ?? [] };
  const collector = { runOnce: async () => ({ accounts: 0, snapshots: 0, insightDays: 0 }) };
  const bindings = { listByMetaAccount: async () => [], deleteByMetaAccount: async () => 0 };
  const publisher = { publish: async () => {} };
  // Constructor order: accounts, graph, env, history, insights, collector, bindings, publisher
  return new MetaAccountsController(accounts as any, graph as any, env as any, history as any, insights as any, collector as any, bindings as any, publisher as any, secrets());
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

test('list includes followers_delta_24h per account', async () => {
  const c = make({
    accountsList: [{ id: 'acc-1', platform: 'instagram', account_id: 'ig', token_env: 'IG_TOKEN',
      target_id: 't', username: 'u', display_name: 'U', followers: 100, picture_url: null,
      active: true, last_verified_at: null, verify_error: null, created_at: new Date() }],
    deltas: new Map([['acc-1', 7]]),
  });
  const out = await c.list() as any[];
  assert.equal(out[0].followers_delta_24h, 7);
});
