import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MtprotoSessionsRepository } from './mtproto-sessions.repository';

/** Fake pg pool that records every query and returns scripted rows. */
function fakePool(rowsByCall: any[][] = []) {
  const calls: Array<{ sql: string; params?: any[] }> = [];
  let i = 0;
  const pool = {
    query: async (sql: string, params?: any[]) => {
      calls.push({ sql, params });
      const rows = rowsByCall[i++] ?? [];
      return { rows, rowCount: rows.length };
    },
  };
  return { pool, calls };
}

const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();

test('list() selects all rows ordered by created_at', async () => {
  const { pool, calls } = fakePool([[{ id: 's1' }, { id: 's2' }]]);
  const repo = new MtprotoSessionsRepository(pool as any);
  const rows = await repo.list();
  assert.deepEqual(rows.map((r: any) => r.id), ['s1', 's2']);
  assert.match(norm(calls[0].sql), /SELECT \* FROM mtproto_sessions ORDER BY created_at/i);
});

test('findById() queries by id', async () => {
  const { pool, calls } = fakePool([[{ id: 's1' }]]);
  const repo = new MtprotoSessionsRepository(pool as any);
  const row = await repo.findById('s1');
  assert.equal(row?.id, 's1');
  assert.match(norm(calls[0].sql), /WHERE id = \$1/i);
  assert.deepEqual(calls[0].params, ['s1']);
});

test('findById() returns null when no row', async () => {
  const { pool } = fakePool([[]]);
  const repo = new MtprotoSessionsRepository(pool as any);
  assert.equal(await repo.findById('nope'), null);
});

test('insert() stores label + session_enc + api creds and returns the row', async () => {
  const { pool, calls } = fakePool([[{ id: 'new', label: 'L', session_enc: 'enc:v1:xyz' }]]);
  const repo = new MtprotoSessionsRepository(pool as any);
  const row = await repo.insert({ label: 'L', session_enc: 'enc:v1:xyz', api_id: '123', api_hash_enc: 'enc:v1:hash' });
  assert.equal(row.id, 'new');
  assert.match(norm(calls[0].sql), /INSERT INTO mtproto_sessions \(label, session_enc, api_id, api_hash_enc\)/i);
  assert.deepEqual(calls[0].params, ['L', 'enc:v1:xyz', '123', 'enc:v1:hash']);
});

test('insert() defaults missing api creds to null (env fallback)', async () => {
  const { pool, calls } = fakePool([[{ id: 'new' }]]);
  const repo = new MtprotoSessionsRepository(pool as any);
  await repo.insert({ label: 'L', session_enc: 'enc:v1:xyz' });
  assert.deepEqual(calls[0].params, ['L', 'enc:v1:xyz', null, null]);
});

test('delete() returns true when a row was deleted', async () => {
  const { pool, calls } = fakePool([[{}]]); // rowCount 1
  const repo = new MtprotoSessionsRepository(pool as any);
  assert.equal(await repo.delete('s1'), true);
  assert.match(norm(calls[0].sql), /DELETE FROM mtproto_sessions WHERE id = \$1/i);
  assert.deepEqual(calls[0].params, ['s1']);
});

test('delete() returns false when no row matched', async () => {
  const { pool } = fakePool([[]]); // rowCount 0
  const repo = new MtprotoSessionsRepository(pool as any);
  assert.equal(await repo.delete('s1'), false);
});

test('setActive() updates the active flag', async () => {
  const { pool, calls } = fakePool([[]]);
  const repo = new MtprotoSessionsRepository(pool as any);
  await repo.setActive('s1', false);
  assert.match(norm(calls[0].sql), /UPDATE mtproto_sessions SET active = \$2 WHERE id = \$1/i);
  assert.deepEqual(calls[0].params, ['s1', false]);
});

test('markVerified() stores username/phone/tg_user_id and clears verify_error', async () => {
  const { pool, calls } = fakePool([[]]);
  const repo = new MtprotoSessionsRepository(pool as any);
  await repo.markVerified('s1', { username: 'u', phone: '+380', tgUserId: '42' });
  const sql = norm(calls[0].sql);
  assert.match(sql, /UPDATE mtproto_sessions/i);
  assert.match(sql, /verify_error\s*=\s*NULL/i);
  assert.match(sql, /last_verified_at\s*=\s*now\(\)/i);
  assert.deepEqual(calls[0].params, ['s1', 'u', '+380', '42']);
});

test('markVerifyError() stores the error message', async () => {
  const { pool, calls } = fakePool([[]]);
  const repo = new MtprotoSessionsRepository(pool as any);
  await repo.markVerifyError('s1', 'AUTH_KEY_UNREGISTERED');
  assert.match(norm(calls[0].sql), /UPDATE mtproto_sessions SET verify_error = \$2/i);
  assert.deepEqual(calls[0].params, ['s1', 'AUTH_KEY_UNREGISTERED']);
});

// ── activeSession: the bridge the tracker/stats clients use ───────────────────

test('activeSession() decrypts the session + api_hash and parses api_id', async () => {
  const { pool, calls } = fakePool([[{ id: 's1', session_enc: 'enc:v1:blob', api_id: '42', api_hash_enc: 'enc:v1:hash' }]]);
  const repo = new MtprotoSessionsRepository(pool as any);
  const secrets = { maybeDecrypt: (v: string) => (v === 'enc:v1:blob' ? 'PLAIN_SESSION' : v === 'enc:v1:hash' ? 'PLAIN_HASH' : 'WRONG') };
  const out = await repo.activeSession(secrets as any);
  assert.deepEqual(out, { session: 'PLAIN_SESSION', apiId: 42, apiHash: 'PLAIN_HASH' });
  // Must filter to active rows.
  assert.match(norm(calls[0].sql), /WHERE active/i);
});

test('activeSession() leaves api creds null when the row has none (env fallback)', async () => {
  const { pool } = fakePool([[{ id: 's1', session_enc: 'enc:v1:blob', api_id: null, api_hash_enc: null }]]);
  const repo = new MtprotoSessionsRepository(pool as any);
  const secrets = { maybeDecrypt: (v: string) => (v === 'enc:v1:blob' ? 'PLAIN_SESSION' : 'WRONG') };
  const out = await repo.activeSession(secrets as any);
  assert.deepEqual(out, { session: 'PLAIN_SESSION', apiId: null, apiHash: null });
});

test('activeSession() returns null when there is no active row', async () => {
  const { pool } = fakePool([[]]);
  const repo = new MtprotoSessionsRepository(pool as any);
  const secrets = { maybeDecrypt: () => 'should-not-be-called' };
  assert.equal(await repo.activeSession(secrets as any), null);
});

test('activeSessionString() shim returns just the decrypted session', async () => {
  const { pool } = fakePool([[{ id: 's1', session_enc: 'enc:v1:blob', api_id: null, api_hash_enc: null }]]);
  const repo = new MtprotoSessionsRepository(pool as any);
  const secrets = { maybeDecrypt: (v: string) => (v === 'enc:v1:blob' ? 'PLAIN_SESSION' : 'WRONG') };
  assert.equal(await repo.activeSessionString(secrets as any), 'PLAIN_SESSION');
});

test('activeSession filters by role (default tracker)', async () => {
  const calls: any[] = [];
  const pool = { query: async (sql: string, params: any[]) => { calls.push({ sql, params }); return { rows: [] }; } } as any;
  const secrets = { maybeDecrypt: (v: string) => v } as any;
  const repo = new MtprotoSessionsRepository(pool);
  await repo.activeSession(secrets);
  assert.match(calls[0].sql, /role = \$1/);
  assert.deepEqual(calls[0].params, ['tracker']);
  await repo.activeSession(secrets, 'agent');
  assert.deepEqual(calls[1].params, ['agent']);
});
