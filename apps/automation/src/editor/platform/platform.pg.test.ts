/** platform_posts + network_posts view (051). Skipped unless EDITOR_PG_TEST_URL is set. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { PlatformPostsRepository } from './platform-posts.repository';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const REF = 'instagram:pg-test-ig';
const CH = '@platform_pg_test';
let pool: Pool;

async function cleanup() {
  await pool.query(`DELETE FROM platform_posts WHERE resource_ref = $1`, [REF]);
  await pool.query(`DELETE FROM resource_daily_stats WHERE resource_ref = $1`, [REF]);
  await pool.query(`DELETE FROM published_posts WHERE channel_id = $1`, [CH]);
  await pool.query(`DELETE FROM content_ledger WHERE resource_ref = ANY($1::text[])`, [[REF, `telegram:${CH}`]]);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
});
after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

test('platform posts: insert, dedup, caps, metrics; network_posts unions Telegram and platforms', { skip }, async () => {
  const repo = new PlatformPostsRepository(pool);
  const since = new Date(Date.now() - 7 * 86_400_000);
  const p = await repo.insert({ resourceRef: REF, platform: 'instagram', externalId: 'pg-m1', format: 'ig_carousel', caption: 'Марс', spec: {}, sourceRef: 'https://src/a', status: 'published' });
  await repo.insert({ resourceRef: REF, platform: 'instagram', format: 'ig_photo', caption: 'тінь', spec: {}, sourceRef: 'https://src/b', status: 'shadowed' });
  assert.equal(await repo.alreadyPosted(REF, { source: 'https://src/a' }, since), true);
  assert.equal(await repo.alreadyPosted(REF, { source: 'https://src/b' }, since), true, 'a shadow post holds its source on the resource for 7 days (023 FR-010)');
  await pool.query(`UPDATE content_ledger SET used_at = now() - interval '8 days' WHERE resource_ref = $1 AND status = 'shadowed'`, [REF]);
  assert.equal(await repo.alreadyPosted(REF, { source: 'https://src/b' }, since), false, '… and only for 7 days');
  assert.equal(await repo.alreadyPosted('instagram:pg-test-other', { source: 'https://src/a' }, since), false, 'other resources are not affected');
  assert.equal(await repo.countPublishedSince(REF, since), 1);
  assert.ok(await repo.lastPostAt(REF));
  assert.deepEqual((await repo.recentCaptions(REF)).sort(), ['Марс', 'тінь']);
  await repo.addMetrics(p.id, { reach: 900, likes: 10, comments: 2, saves: 7 });

  await pool.query(`INSERT INTO published_posts (channel_id, message_id, title, format) VALUES ($1, 77, 'Телеграм-пост', 'photo')`, [CH]);
  const { rows } = await pool.query(
    `SELECT resource_ref, platform, format, views, engagement FROM network_posts WHERE resource_ref IN ($1, $2) ORDER BY platform`, [REF, `telegram:${CH}`]);
  assert.deepEqual(rows.map((r) => [r.resource_ref, r.platform, r.format]), [[REF, 'instagram', 'ig_carousel'], [`telegram:${CH}`, 'telegram', 'photo']]);
  assert.equal(rows[0].views, 900, 'reach stands in for views');
  assert.equal(rows[0].engagement, 19);

  await repo.upsertDaily(REF, '2026-09-30', { followers: 1000 });
  await repo.upsertDaily(REF, '2026-10-01', { followers: 1040 });
  const { rows: d } = await pool.query(`SELECT followers_delta FROM resource_daily_stats WHERE resource_ref = $1 AND day = '2026-10-01'`, [REF]);
  assert.equal(d[0].followers_delta, 40);
});
