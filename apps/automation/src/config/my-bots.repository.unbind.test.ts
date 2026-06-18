import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MyBotsRepository } from './my-bots.repository';

/** Fake tx pool; DELETE FROM my_bots reports `deleteRowCount`, others 0. */
function fakeTxPool(deleteRowCount = 1) {
  const clientCalls: Array<{ sql: string; params?: any[] }> = [];
  const client = {
    query: async (sql: string, params?: any[]) => {
      clientCalls.push({ sql, params });
      return { rows: [], rowCount: /DELETE FROM my_bots/i.test(sql) ? deleteRowCount : 0 };
    },
    release: () => {},
  };
  const pool = { connect: async () => client };
  return { pool, clientCalls };
}
const flat = (c: { sql: string }[]) => c.map(x => x.sql.replace(/\s+/g, ' ').trim()).join(' || ');
const norm = (s: string) => s.replace(/\s+/g, ' ');

test('deleteWithUnbind nulls channel + scheduled bot_id then deletes, in a tx', async () => {
  const { pool, clientCalls } = fakeTxPool(1);
  const repo = new MyBotsRepository(pool as any);
  const ok = await repo.deleteWithUnbind('b1');
  assert.equal(ok, true);

  const sqls = clientCalls.map(c => norm(c.sql).trim());
  assert.equal(sqls[0], 'BEGIN');
  assert.equal(sqls[sqls.length - 1], 'COMMIT');

  const chIdx  = clientCalls.findIndex(c => /UPDATE tracked_channels SET bot_id = NULL WHERE bot_id = \$1/i.test(norm(c.sql)));
  const spIdx  = clientCalls.findIndex(c => /UPDATE scheduled_publications SET bot_id = NULL WHERE bot_id = \$1/i.test(norm(c.sql)));
  const delIdx = clientCalls.findIndex(c => /DELETE FROM my_bots WHERE id = \$1/i.test(norm(c.sql)));
  assert.ok(chIdx >= 0 && spIdx >= 0 && delIdx >= 0, `missing a query in: ${flat(clientCalls)}`);
  assert.ok(chIdx < delIdx && spIdx < delIdx, 'must unbind channels + scheduled posts before deleting the bot');
  assert.deepEqual(clientCalls[delIdx].params, ['b1']);
});

test('deleteWithUnbind returns false when the bot did not exist', async () => {
  const { pool } = fakeTxPool(0);
  const repo = new MyBotsRepository(pool as any);
  assert.equal(await repo.deleteWithUnbind('nope'), false);
});
