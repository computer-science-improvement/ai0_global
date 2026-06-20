import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RetentionService, RETENTION_POLICIES } from './retention.service';

function makeSvc(env: Record<string, string | undefined>) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const pool = {
    query: async (sql: string, params: any[]) => { calls.push({ sql, params }); return { rowCount: 1 }; },
  } as any;
  const config = { get: (k: string) => env[k] } as any;
  return { svc: new RetentionService(pool, config), calls };
}

test('does nothing when RETENTION_ENABLED is not true', async () => {
  const { svc, calls } = makeSvc({});
  const res = await svc.pruneOnce();
  assert.deepEqual(res, []);
  assert.equal(calls.length, 0);
});

test('prunes every policy table when enabled, parameterizing the day window', async () => {
  const { svc, calls } = makeSvc({ RETENTION_ENABLED: 'true' });
  const res = await svc.pruneOnce();
  assert.equal(calls.length, RETENTION_POLICIES.length);
  // Each call targets its table + column and binds the default day window.
  for (let i = 0; i < RETENTION_POLICIES.length; i++) {
    const p = RETENTION_POLICIES[i];
    assert.match(calls[i].sql, new RegExp(`DELETE FROM ${p.table} WHERE ${p.col} <`));
    assert.deepEqual(calls[i].params, [p.defaultDays]);
  }
  assert.equal(res.length, RETENTION_POLICIES.length);
});

test('a per-table window of 0 disables that table only', async () => {
  const { svc, calls } = makeSvc({ RETENTION_ENABLED: 'true', AI_LOGS_RETENTION_DAYS: '0' });
  await svc.pruneOnce();
  assert.ok(!calls.some(c => /DELETE FROM ai_logs/.test(c.sql)), 'ai_logs should be skipped');
  assert.equal(calls.length, RETENTION_POLICIES.length - 1);
});

test('env override changes the day window', async () => {
  const { svc, calls } = makeSvc({ RETENTION_ENABLED: 'true', AI_LOGS_RETENTION_DAYS: '7' });
  await svc.pruneOnce();
  const aiCall = calls.find(c => /DELETE FROM ai_logs/.test(c.sql));
  assert.deepEqual(aiCall!.params, [7]);
});
