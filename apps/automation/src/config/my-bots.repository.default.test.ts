import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MyBotsRepository } from './my-bots.repository';

/** Fake pool whose connect() yields a client recording every query. */
function fakeTxPool() {
  const clientCalls: Array<{ sql: string; params?: any[] }> = [];
  const client = {
    query: async (sql: string, params?: any[]) => { clientCalls.push({ sql, params }); return { rows: [], rowCount: 0 }; },
    release: () => {},
  };
  const poolCalls: Array<{ sql: string; params?: any[] }> = [];
  const pool = {
    connect: async () => client,
    query: async (sql: string, params?: any[]) => { poolCalls.push({ sql, params }); return { rows: [], rowCount: 0 }; },
  };
  return { pool, clientCalls, poolCalls };
}

function flatten(calls: Array<{ sql: string }>): string {
  return calls.map(c => c.sql.replace(/\s+/g, ' ').trim()).join(' || ');
}

test('setDefault(id, true) clears any existing default then sets the target — in a transaction', async () => {
  const { pool, clientCalls } = fakeTxPool();
  const repo = new MyBotsRepository(pool as any);
  await repo.setDefault('b1', true);

  const sqls = clientCalls.map(c => c.sql.replace(/\s+/g, ' ').trim());
  assert.equal(sqls[0], 'BEGIN');
  assert.equal(sqls[sqls.length - 1], 'COMMIT');

  const flat = flatten(clientCalls);
  // Clear-then-set ordering: the "clear all" UPDATE must come before the "set one".
  const clearIdx = clientCalls.findIndex(c => /UPDATE my_bots SET is_default = false WHERE is_default/i.test(c.sql.replace(/\s+/g, ' ')));
  const setIdx   = clientCalls.findIndex(c => /UPDATE my_bots SET is_default = true WHERE id = \$1/i.test(c.sql.replace(/\s+/g, ' ')));
  assert.ok(clearIdx >= 0, `expected clear UPDATE in: ${flat}`);
  assert.ok(setIdx >= 0, `expected set UPDATE in: ${flat}`);
  assert.ok(clearIdx < setIdx, 'clear must run before set');
  assert.deepEqual(clientCalls[setIdx].params, ['b1']);
});

test('setDefault(id, false) issues a single UPDATE clearing that id', async () => {
  const { pool, clientCalls, poolCalls } = fakeTxPool();
  const repo = new MyBotsRepository(pool as any);
  await repo.setDefault('b1', false);

  // Whether it runs in a tx or a single query, exactly one UPDATE that clears the target id.
  const all = [...clientCalls, ...poolCalls];
  const updates = all.filter(c => /UPDATE my_bots SET is_default = false WHERE id = \$1/i.test(c.sql.replace(/\s+/g, ' ')));
  assert.equal(updates.length, 1, `expected one clear-target UPDATE, got: ${flatten(all)}`);
  assert.deepEqual(updates[0].params, ['b1']);
  // Must NOT clear-all or set-true when toggling off.
  assert.ok(!all.some(c => /SET is_default = true/i.test(c.sql)));
});

test('findDefault selects the default bot', async () => {
  const calls: Array<{ sql: string; params?: any[] }> = [];
  const pool = {
    query: async (sql: string, params?: any[]) => { calls.push({ sql, params }); return { rows: [{ id: 'd1', is_default: true }] }; },
  };
  const repo = new MyBotsRepository(pool as any);
  const row = await repo.findDefault();
  assert.equal(row?.id, 'd1');
  assert.match(calls[0].sql.replace(/\s+/g, ' '), /SELECT \* FROM my_bots WHERE is_default LIMIT 1/i);
});

test('findDefault returns null when no default exists', async () => {
  const pool = { query: async () => ({ rows: [] }) };
  const repo = new MyBotsRepository(pool as any);
  assert.equal(await repo.findDefault(), null);
});
