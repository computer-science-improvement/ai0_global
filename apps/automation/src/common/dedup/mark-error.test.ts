// 002 T004 — the poisoned-item mechanism of posted_news, at the SQL level.
//
// A permanent failure inserts a posted_news row with content_type = 'error' (title prefixed with the reason).
// The pool-table half (`error:<postedKey>` in the `posted` JSONB of the legacy strategy repositories) went away
// with the strategy runtime (spec 023 phase B).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DedupService } from './dedup.service';

function fakePool(rows: any[] = []) {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      return { rows, rowCount: rows.length };
    },
  };
  return { pool, queries };
}

const norm = (s: string) => s.replace(/\s+/g, ' ');

test('dedup.markError inserts a posted_news row with content_type error', async () => {
  const { pool, queries } = fakePool();
  const d = new DedupService(pool as any, { db() {} } as any);
  await d.markError('https://src/1', 'Title', '@c', 'refusal: unable');
  const q = queries[0];
  assert.match(norm(q.sql), /INSERT INTO posted_news/);
  assert.match(norm(q.sql), /ON CONFLICT \(source_url, channel_id\) DO NOTHING/);
  assert.deepEqual(q.params, ['https://src/1', '[error: refusal: unable] Title', '@c', 'error']);
});

test('dedup.getLastPostedType ignores error rows', async () => {
  const { pool, queries } = fakePool([]);
  await new DedupService(pool as any, { db() {} } as any).getLastPostedType('@c');
  assert.match(norm(queries[0].sql), /content_type <> 'error'/);
});
