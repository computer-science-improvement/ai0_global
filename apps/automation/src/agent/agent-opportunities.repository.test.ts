import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentOpportunitiesRepository } from './agent-opportunities.repository';
function fakePool() { const calls: any[] = []; let rows: any[] = [];
  return { calls, setRows: (r: any[]) => { rows = r; }, pool: { query: async (sql: string, params: any[]) => { calls.push({ sql, params }); return { rows, rowCount: rows.length }; } } as any }; }

test('upsert dedups by (chat_id,message_id)', async () => {
  const { pool, calls } = fakePool(); const repo = new AgentOpportunitiesRepository(pool);
  await repo.upsert({ chatId: 'c1', chatTitle: 'C', messageId: 5, text: 'ad' }, { kind: 'ad_offer', summary: 's', score: 80, suggestedAction: 'advertise' });
  assert.match(calls[0].sql, /INSERT INTO agent_opportunities/);
  assert.match(calls[0].sql, /ON CONFLICT \(chat_id, message_id\) DO NOTHING/);
  assert.equal(calls[0].params[0], 'c1'); assert.ok(calls[0].params.includes('ad_offer'));
});
test('list filters by status + kind', async () => {
  const { pool, calls } = fakePool(); const repo = new AgentOpportunitiesRepository(pool);
  await repo.list({ status: 'new', kind: 'ad_offer' });
  assert.match(calls[0].sql, /status = \$/); assert.match(calls[0].sql, /kind = \$/);
});
test('setStatus updates status', async () => {
  const { pool, calls } = fakePool(); const repo = new AgentOpportunitiesRepository(pool);
  await repo.setStatus('o1', 'archived');
  assert.match(calls[0].sql, /UPDATE agent_opportunities SET status/); assert.deepEqual(calls[0].params, ['o1', 'archived']);
});
