import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadonlyQueryService } from './readonly-query.service';

function fakePool(opts: { failOn?: RegExp } = {}) {
  const sqls: string[] = [];
  let released = 0;
  const client = {
    query: async (sql: string) => {
      sqls.push(sql);
      if (opts.failOn?.test(sql)) throw new Error('permission denied for table my_bots');
      if (sql.startsWith('SELECT * FROM')) return { fields: [{ name: 'title' }], rows: [{ title: 'x'.repeat(600) }], rowCount: 1 };
      return { rows: [] };
    },
    release: () => { released++; },
  };
  return { sqls, released: () => released, pool: { connect: async () => client } as any };
}

test('runs inside READ ONLY tx under editor_ro with timeout, then rolls back', async () => {
  const p = fakePool();
  const res: any = await new ReadonlyQueryService(p.pool).run('SELECT title FROM recipes', 10);
  assert.deepEqual(p.sqls.slice(0, 3), ['BEGIN READ ONLY', 'SET LOCAL ROLE editor_ro', 'SET LOCAL statement_timeout = 3000']);
  assert.equal(p.sqls[3], 'SELECT * FROM (SELECT title FROM recipes) AS _q LIMIT 10');
  assert.equal(p.sqls[4], 'ROLLBACK');
  assert.equal(p.released(), 1);
  assert.deepEqual(res.columns, ['title']);
  assert.ok((res.rows[0].title as string).length < 520);
});

test('classifier rejection never touches the DB', async () => {
  const p = fakePool();
  const res: any = await new ReadonlyQueryService(p.pool).run('DELETE FROM recipes');
  assert.equal(res.error, 'sql_rejected');
  assert.equal(p.sqls.length, 0);
});

test('DB errors are returned as data and connection released', async () => {
  const p = fakePool({ failOn: /^SELECT \* FROM/ });
  const res: any = await new ReadonlyQueryService(p.pool).run('SELECT * FROM my_bots');
  assert.equal(res.error, 'sql_failed');
  assert.match(res.details, /permission denied/);
  assert.equal(p.released(), 1);
  assert.equal(p.sqls.at(-1), 'ROLLBACK');
});
