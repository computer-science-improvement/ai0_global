import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActivityRepository } from './activity.repository';

function fakePool(capture: { sql: string; params: any[] }[]) {
  return {
    query: async (sql: string, params: any[]) => {
      capture.push({ sql, params });
      return { rows: [{ count: 0 }] };
    },
  } as any;
}

test('list() with no extra filters → only platform condition + limit/offset', async () => {
  const cap: any[] = [];
  const repo = new ActivityRepository(fakePool(cap));
  await repo.list({ platforms: ['telegram'], limit: 50, offset: 0 });
  const { sql, params } = cap[0];
  assert.match(sql, /ev\.platform = ANY\(\$1::text\[\]\)/);
  assert.ok(!/ev\.at >=/.test(sql), 'no time bound when from/to absent');
  assert.ok(!/ev\.strategy =/.test(sql));
  // params: [platforms, limit+1, offset]
  assert.deepEqual(params, [['telegram'], 51, 0]);
});

test('list() applies from/to/strategy/channel as positional WHERE conditions', async () => {
  const cap: any[] = [];
  const repo = new ActivityRepository(fakePool(cap));
  await repo.list({
    platforms: ['instagram', 'facebook', 'threads'],
    type: 'error', from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z',
    strategy: 'recipes:FB', channelId: 'chan-uuid', limit: 50, offset: 100,
  });
  const { sql, params } = cap[0];
  assert.match(sql, /ev\.type = \$2/);
  assert.match(sql, /ev\.at >= \$3::timestamptz/);
  assert.match(sql, /ev\.at <= \$4::timestamptz/);
  assert.match(sql, /ev\.strategy = \$5/);
  assert.match(sql, /ev\.channel_id = \$6/);
  // trailing limit+1 / offset are $7 / $8
  assert.match(sql, /LIMIT \$7 OFFSET \$8/);
  assert.deepEqual(params, [
    ['instagram', 'facebook', 'threads'], 'error',
    '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', 'recipes:FB', 'chan-uuid',
    51, 100,
  ]);
});

test('count() runs the same WHERE without limit/offset', async () => {
  const cap: any[] = [];
  const repo = new ActivityRepository(fakePool(cap));
  const n = await repo.count({ platforms: ['telegram'], strategy: 'recipes:local' });
  assert.equal(n, 0);
  const { sql, params } = cap[0];
  assert.match(sql, /SELECT count\(\*\)/);
  assert.match(sql, /ev\.strategy = \$2/);
  assert.ok(!/LIMIT/.test(sql), 'count has no LIMIT');
  assert.deepEqual(params, [['telegram'], 'recipes:local']);
});
