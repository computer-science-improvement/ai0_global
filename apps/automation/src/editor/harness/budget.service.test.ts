import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BudgetService } from './budget.service';

function pool(globalUsd: number, channelUsd: number, day = '2026-10-01') {
  const calls: any[] = [];
  return {
    calls,
    pool: { query: async (sql: string, params: any[]) => { calls.push({ sql, params }); return { rows: [{ global_usd: String(globalUsd), channel_usd: String(channelUsd), day }] }; } } as any,
  };
}

const limits = { globalDailyUsd: 3, channelDailyUsd: 0.5 };

test('ok under both limits; query uses Kyiv day and channel param', async () => {
  const p = pool(1, 0.1);
  const v = await new BudgetService(p.pool, limits).check('ch');
  assert.deepEqual(v, { ok: true });
  assert.match(p.calls[0].sql, /Europe\/Kyiv/);
  assert.deepEqual(p.calls[0].params, ['ch']);
});

test('global limit wins and alerts once per day', async () => {
  const alerts: string[] = [];
  const svc = new BudgetService(pool(3.2, 0.1).pool, limits, (t) => { alerts.push(t); });
  const v1 = await svc.check('ch');
  const v2 = await svc.check('other');
  assert.equal(v1.ok, false);
  assert.equal((v1 as any).scope, 'global');
  assert.equal(v2.ok, false);
  assert.equal(alerts.length, 1);
});

test('channel limit, with per-channel override', async () => {
  const svc = new BudgetService(pool(1, 0.6).pool, limits);
  assert.equal((await svc.check('ch')).ok, false);
  assert.equal((await svc.check('ch', 1.0)).ok, true);
});

test('null channel only checks global', async () => {
  const svc = new BudgetService(pool(1, 99).pool, limits);
  assert.equal((await svc.check(null)).ok, true);
});

test('alert failure does not break check', async () => {
  const svc = new BudgetService(pool(5, 0).pool, limits, () => { throw new Error('tg down'); });
  assert.equal((await svc.check('ch')).ok, false);
});
