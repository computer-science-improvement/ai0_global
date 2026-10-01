// 002 T004 — the poisoned-item mechanism, at the SQL level.
//
// Pool-backed content tables (prompts, assets, birthdays) record a permanent
// failure in their existing `posted` JSONB under the key `error:<postedKey>`
// with {at, reason}; every getNext/countEligible excludes that key, so an
// errored row is skipped for that destination exactly like a posted one.
// posted_news-backed strategies (generic runner path, game-channel) insert a
// posted_news row with content_type = 'error' (title prefixed with the reason).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PromptsRepository } from '../../strategies/ai0-prompts/prompts.repository';
import { AssetsRepository } from '../../strategies/assets/assets.repository';
import { MotivationBiographyRepository } from '../../strategies/motivation-biography/motivation-biography.repository';
import { DedupService } from './dedup.service';
import { postedErrorKey } from './posted-error';

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

test('postedErrorKey prefixes the destination key', () => {
  assert.equal(postedErrorKey('TELEGRAM'), 'error:TELEGRAM');
  assert.equal(postedErrorKey('@chan'), 'error:@chan');
});

for (const [name, make, call] of [
  ['prompts', (p: any) => new PromptsRepository(p), (r: any) => r.markError('img', 'TELEGRAM', 'dead image (404)')],
  ['assets', (p: any) => new AssetsRepository(p), (r: any) => r.markError('a1', '@c', 'SKIP_POST')],
  ['birthdays', (p: any) => new MotivationBiographyRepository(p), (r: any) => r.markError('b1', '@c', 'empty draft')],
] as const) {
  test(`${name}.markError writes error:<key> {at, reason} into posted`, async () => {
    const { pool, queries } = fakePool();
    await call(make(pool));
    const q = queries[0];
    assert.match(norm(q.sql), /SET posted = posted \|\| jsonb_build_object\(\$2::text, jsonb_build_object\('at', now\(\), 'reason', \$3::text\)\)/);
    assert.match(q.params![1] as string, /^error:/);
    assert.equal(typeof q.params![2], 'string');
  });
}

test('prompts.getNext excludes errored rows and has a deterministic ORDER BY', async () => {
  const { pool, queries } = fakePool();
  await new PromptsRepository(pool as any).getNext('art', 'IG:x');
  const sql = norm(queries[0].sql);
  assert.match(sql, /NOT \(posted \? \$2\)/);
  assert.match(sql, /NOT \(posted \? \$3\)/);
  assert.equal(queries[0].params![2], 'error:IG:x');
  assert.match(sql, /ORDER BY created_at, id/);
});

test('prompts.countEligibleAll excludes error:TELEGRAM', async () => {
  const { pool, queries } = fakePool([{ count: '3' }]);
  await new PromptsRepository(pool as any).countEligibleAll();
  assert.match(norm(queries[0].sql), /NOT \(posted \? 'error:TELEGRAM'\)/);
});

test('assets.getNext / countEligible exclude error:<channel>', async () => {
  const { pool, queries } = fakePool([{ count: '1' }]);
  const r = new AssetsRepository(pool as any);
  await r.getNext('mcpservers', '@c');
  await r.countEligible('mcpservers', '@c');
  for (const q of queries) {
    assert.match(norm(q.sql), /NOT \(posted \? \$3\)/);
    assert.equal(q.params![2], 'error:@c');
  }
});

test('birthdays.getToday / countEligible exclude error:<channel>', async () => {
  const { pool, queries } = fakePool([{ count: '1' }]);
  const r = new MotivationBiographyRepository(pool as any);
  await r.getToday('@c');
  await r.countEligible('@c');
  for (const q of queries) {
    assert.match(norm(q.sql), /NOT \(posted \? \$2\)/);
    assert.equal(q.params![1], 'error:@c');
  }
});

test('dedup.markError inserts a posted_news row with content_type error', async () => {
  const { pool, queries } = fakePool();
  const d = new DedupService(pool as any, { db() {} } as any);
  await d.markError('https://src/1', 'Title', '@c', 'refusal: unable');
  const q = queries[0];
  assert.match(norm(q.sql), /INSERT INTO posted_news/);
  assert.match(norm(q.sql), /ON CONFLICT \(source_url, channel_id\) DO NOTHING/);
  assert.deepEqual(q.params, ['https://src/1', '[error: refusal: unable] Title', '@c', 'error']);
});

test('dedup.getLastPostedType ignores error rows (game-channel fair-mix)', async () => {
  const { pool, queries } = fakePool([]);
  await new DedupService(pool as any, { db() {} } as any).getLastPostedType('@c');
  assert.match(norm(queries[0].sql), /content_type <> 'error'/);
});
