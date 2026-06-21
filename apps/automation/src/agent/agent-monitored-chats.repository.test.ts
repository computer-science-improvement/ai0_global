import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentMonitoredChatsRepository } from './agent-monitored-chats.repository';
function fakePool() { const calls: any[] = []; let rows: any[] = [];
  return { calls, setRows: (r: any[]) => { rows = r; }, pool: { query: async (sql: string, params: any[]) => { calls.push({ sql, params }); return { rows, rowCount: rows.length }; } } as any }; }

test('upsert inserts chat_id/title on conflict updates title', async () => {
  const { pool, calls } = fakePool(); const repo = new AgentMonitoredChatsRepository(pool);
  await repo.upsert('c1', 'Chat One');
  assert.match(calls[0].sql, /INSERT INTO agent_monitored_chats/);
  assert.match(calls[0].sql, /ON CONFLICT \(chat_id\) DO UPDATE/);
  assert.deepEqual(calls[0].params, ['c1', 'Chat One']);
});
test('setEnabled updates enabled', async () => {
  const { pool, calls } = fakePool(); const repo = new AgentMonitoredChatsRepository(pool);
  await repo.setEnabled('c1', true);
  assert.match(calls[0].sql, /SET enabled = \$2/); assert.deepEqual(calls[0].params, ['c1', true]);
});
test('enabled() selects only enabled chats', async () => {
  const { pool, calls } = fakePool(); const repo = new AgentMonitoredChatsRepository(pool);
  await repo.enabled();
  assert.match(calls[0].sql, /WHERE enabled/);
});
test('setLastMessageId advances cursor', async () => {
  const { pool, calls } = fakePool(); const repo = new AgentMonitoredChatsRepository(pool);
  await repo.setLastMessageId('c1', 42);
  assert.match(calls[0].sql, /SET last_message_id = \$2/); assert.match(calls[0].sql, /last_polled_at = now\(\)/);
  assert.deepEqual(calls[0].params, ['c1', 42]);
});
