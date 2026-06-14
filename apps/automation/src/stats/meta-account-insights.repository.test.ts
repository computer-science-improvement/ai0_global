import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetaAccountInsightsRepository } from './meta-account-insights.repository';

function repo(queryImpl: (sql: string, params: any[]) => any) {
  const pool = { query: async (sql: string, params: any[]) => queryImpl(sql, params) };
  return new MetaAccountInsightsRepository(pool as any);
}

test('upsertDay inserts with ON CONFLICT update and binds metrics in order', async () => {
  let captured: { sql: string; params: any[] } | null = null;
  const r = repo((sql, params) => { captured = { sql, params }; return { rows: [] }; });
  await r.upsertDay('acc-1', '2026-06-10', { reach: 100, impressions: 300, profileViews: 5 });
  assert.match(captured!.sql, /INSERT INTO meta_account_insights/);
  assert.match(captured!.sql, /ON CONFLICT \(account_id, day\) DO UPDATE/);
  assert.deepEqual(captured!.params, ['acc-1', '2026-06-10', 100, 300, 5]);
});

test('history returns normalized rows ordered by day', async () => {
  const r = repo((sql, params) => {
    assert.match(sql, /FROM meta_account_insights/);
    assert.equal(params[0], 'acc-1');
    return { rows: [
      { day: '2026-06-10', reach: 100, impressions: null, profile_views: 5 },
      { day: '2026-06-11', reach: 120, impressions: 300, profile_views: null },
    ] };
  });
  const out = await r.history('acc-1');
  assert.deepEqual(out, [
    { day: '2026-06-10', reach: 100, impressions: null, profileViews: 5 },
    { day: '2026-06-11', reach: 120, impressions: 300, profileViews: null },
  ]);
});
