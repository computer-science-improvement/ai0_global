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
  assert.deepEqual(p.calls[0].params, ['ch', null]);
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

test('agent budget (spec 017): its own cap, checked after channel and global; alerts once', async () => {
  const alerts: string[] = [];
  const calls: any[] = [];
  const p = { query: async (sql: string, params: any[]) => { calls.push({ sql, params }); return { rows: [{ global_usd: '0.2', channel_usd: '0.1', agent_usd: '0.31', day: '2026-10-02' }] }; } } as any;
  const svc = new BudgetService(p, limits, (t) => { alerts.push(t); });
  const v = await svc.check('ch', null, { id: 'a1', handle: 'kira', limitUsd: 0.3 });
  assert.deepEqual(v, { ok: false, scope: 'agent', spentUsd: 0.31, limitUsd: 0.3 });
  assert.deepEqual(calls[0].params, ['ch', 'a1']);
  await svc.check('ch', null, { id: 'a1', handle: 'kira', limitUsd: 0.3 });
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /@kira/);
  assert.deepEqual(await svc.check('ch', null, { id: 'a1', limitUsd: null }), { ok: true }, 'no agent cap → only channel/global');
});
