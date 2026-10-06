import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, UPSERT_BATCH } from './data-store';

const schema = {
  id: 's1', key: 'books', version: 1, dedup_key: ['isbn'], roles: {},
  fields: [
    { name: 'isbn', type: 'text', description: '', required: true },
    { name: 'pages', type: 'int', description: '' },
  ],
};

function fakePool(perBatch: (rows: any[]) => any = () => ({ inserted: 0, updated: 0, skipped: 0, invalid: [], invalid_rows: 0 })) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  return {
    calls,
    pool: {
      query: async (sql: string, params: any[] = []) => {
        calls.push({ sql, params });
        if (/FROM data_schemas WHERE key/.test(sql)) return { rows: params[0] === 'books' ? [schema] : [] };
        if (/data_items_upsert/.test(sql)) return { rows: [{ r: perBatch(JSON.parse(params[1])) }] };
        if (/SELECT 1 FROM data_items WHERE legacy_ref/.test(sql)) return { rows: [{ '?column?': 1 }] };
        return { rows: [] };
      },
    },
  };
}

test('upsert validates with zod, sends batches of 1000 and maps SQL row numbers back to the input', async () => {
  const rows = Array.from({ length: UPSERT_BATCH + 5 }, (_, i) => ({ isbn: `k${i}`, pages: String(i) }));
  rows[3] = { isbn: 'k3', pages: 'x' } as any;          // rejected by zod
  const f = fakePool((batch) => ({ inserted: batch.length - 1, updated: 0, skipped: 0, invalid: [{ row: 0, field: 'isbn', error: 'boom' }], invalid_rows: 1 }));
  const r = await new DataStore(f.pool as any).upsert('books', rows);
  const upserts = f.calls.filter((c) => /data_items_upsert/.test(c.sql));
  assert.equal(upserts.length, 2);
  const first = JSON.parse(upserts[0].params[1]);
  assert.equal(first.length, UPSERT_BATCH);
  assert.equal(first[0].pages, 0, 'values are coerced before SQL');
  assert.deepEqual(r.rejected.map((e) => [e.row, e.field]), [[3, 'pages']]);
  // SQL invalid row 0 of batch 2 is input row 1001 (row 3 was dropped from batch 1).
  assert.deepEqual(r.invalid.map((e) => e.row), [0, 1001]);
  assert.equal(r.invalid_rows, 3);
});

test('patchByLegacyRef sends a partial row with _legacy_ref and update_fields = the given keys', async () => {
  const f = fakePool((batch) => ({ inserted: 0, updated: batch.length, skipped: 0, invalid: [], invalid_rows: 0 }));
  assert.equal(await new DataStore(f.pool as any).patchByLegacyRef('books', 'library://books/1', { pages: '9' }), true);
  const call = f.calls.find((c) => /data_items_upsert/.test(c.sql))!;
  assert.deepEqual(JSON.parse(call.params[1]), [{ pages: 9, _legacy_ref: 'library://books/1' }]);
  assert.deepEqual(call.params[3], ['pages']);
});

test('patchByLegacyRef throws on invalid values instead of silently skipping', async () => {
  const f = fakePool();
  await assert.rejects(new DataStore(f.pool as any).patchByLegacyRef('books', 'library://books/1', { pages: 'many' }), /pages/);
});
