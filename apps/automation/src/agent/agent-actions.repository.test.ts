import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentActionsRepository } from './agent-actions.repository';

function fakePool() {
  const calls: Array<{ sql: string; params: any[] }> = [];
  let rows: any[] = [];
  return { calls, setRows: (r: any[]) => { rows = r; },
    pool: { query: async (sql: string, params: any[]) => { calls.push({ sql, params }); return { rows, rowCount: rows.length }; } } as any };
}

test('create inserts type/thread/payload and returns the row', async () => {
  const { pool, calls, setRows } = fakePool();
  setRows([{ id: 'x', type: 'reply' }]);
  const repo = new AgentActionsRepository(pool);
  const row = await repo.create({ type: 'reply', threadId: 't1', payload: { text: 'hi' } });
  assert.match(calls[0].sql, /INSERT INTO agent_actions/);
  assert.equal(calls[0].params[0], 'reply');
  assert.equal(calls[0].params[1], 't1');
  assert.equal(row.id, 'x');
});

test('list filters by status when given', async () => {
  const { pool, calls } = fakePool();
  const repo = new AgentActionsRepository(pool);
  await repo.list('pending');
  assert.match(calls[0].sql, /status = \$1/);
  assert.deepEqual(calls[0].params, ['pending']);
});

test('setStatus updates status + executed_at/error patch', async () => {
  const { pool, calls } = fakePool();
  const repo = new AgentActionsRepository(pool);
  await repo.setStatus('id1', 'done', { executedAt: true });
  assert.match(calls[0].sql, /UPDATE agent_actions SET status = \$2/);
  assert.match(calls[0].sql, /executed_at = now\(\)/);
  assert.equal(calls[0].params[0], 'id1');
  assert.equal(calls[0].params[1], 'done');
});

test('countRepliesSince counts done replies in window', async () => {
  const { pool, calls, setRows } = fakePool();
  setRows([{ n: '3' }]);
  const repo = new AgentActionsRepository(pool);
  const n = await repo.countRepliesSince(24);
  assert.match(calls[0].sql, /type = 'reply'/);
  assert.match(calls[0].sql, /status = 'done'/);
  assert.equal(n, 3);
});
