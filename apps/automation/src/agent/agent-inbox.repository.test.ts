import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentInboxRepository } from './agent-inbox.repository';

function fakePool() {
  const calls: Array<{ sql: string; params: any[] }> = [];
  let rows: any[] = [];
  return {
    calls,
    setRows: (r: any[]) => { rows = r; },
    pool: { query: async (sql: string, params: any[]) => { calls.push({ sql, params }); return { rows, rowCount: rows.length }; } } as any,
  };
}

const dm = { peerId: '42', peerUsername: 'bob', peerName: 'Bob', messageId: 100, text: 'hi', date: new Date('2026-01-01T00:00:00Z'), out: false };
const triage = { category: 'ad' as const, summary: 's', fields: { budget: '500' }, draftReply: 'd', score: 70 };

test('upsertThread upserts by peer_id with triage payload', async () => {
  const { pool, calls } = fakePool();
  const repo = new AgentInboxRepository(pool);
  await repo.upsertThread(dm, triage);
  assert.match(calls[0].sql, /INSERT INTO agent_dm_threads/);
  assert.match(calls[0].sql, /ON CONFLICT \(peer_id\) DO UPDATE/);
  assert.equal(calls[0].params[0], '42');           // peer_id
  assert.ok(calls[0].params.includes('ad'));        // category
});

test('list filters by status and category when provided', async () => {
  const { pool, calls } = fakePool();
  const repo = new AgentInboxRepository(pool);
  await repo.list({ status: 'new', category: 'ad' });
  assert.match(calls[0].sql, /status = \$/);
  assert.match(calls[0].sql, /category = \$/);
});

test('setStatus updates status', async () => {
  const { pool, calls } = fakePool();
  const repo = new AgentInboxRepository(pool);
  await repo.setStatus('id1', 'archived');
  assert.match(calls[0].sql, /UPDATE agent_dm_threads SET status/);
  assert.deepEqual(calls[0].params, ['id1', 'archived']);
});

test('lastMessageIdFor returns 0 when no row', async () => {
  const { pool } = fakePool();
  const repo = new AgentInboxRepository(pool);
  assert.equal(await repo.lastMessageIdFor('42'), 0);
});

test('threadPeer queries peer_id + peer_username by thread id', async () => {
  const { pool, calls, setRows } = fakePool();
  setRows([{ peer_id: '99', peer_username: 'alice' }]);
  const repo = new AgentInboxRepository(pool);
  const peer = await repo.threadPeer('thread-1');
  assert.match(calls[0].sql, /SELECT peer_id, peer_username FROM agent_dm_threads/);
  assert.equal(calls[0].params[0], 'thread-1');
  assert.equal(peer?.peer_id, '99');
  assert.equal(peer?.peer_username, 'alice');
});

test('stampReplied updates replied_at, sent_reply, status', async () => {
  const { pool, calls } = fakePool();
  const repo = new AgentInboxRepository(pool);
  await repo.stampReplied('thread-2', 'Hello');
  assert.match(calls[0].sql, /replied_at = now\(\)/);
  assert.match(calls[0].sql, /status = 'reviewed'/);
  assert.deepEqual(calls[0].params, ['thread-2', 'Hello']);
});
