/**
 * Spec 037 FR-013 on a throwaway Postgres with every migration applied: get_format_performance's SQL returns n,
 * median views and confidence per format, and set_format_weights reads the same numbers. Skipped unless
 * EDITOR_PG_TEST_URL is set. Never point this at a real database: it writes and deletes published_posts rows.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { buildRoleTools, loadFormatPerformance, RoleToolDeps } from './role-tools';
import { makeCard } from '../post/testing/fixtures';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@pgtest_kpi_sample';
let pool: Pool;

async function post(format: string, messageId: number, views: number | null, hoursAgo = 48) {
  const { rows } = await pool.query(
    `INSERT INTO published_posts (channel_id, message_id, title, format, posted_at)
     VALUES ($1, $2, 'test', $3, now() - ($4 || ' hours')::interval) RETURNING id`, [CH, messageId, format, String(hoursAgo)]);
  if (views != null) {
    await pool.query(`INSERT INTO post_stats_snapshots (post_id, captured_at, views, forwards) VALUES ($1, now(), $2, 1)`, [rows[0].id, views]);
  }
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await pool.query(`DELETE FROM published_posts WHERE channel_id = $1`, [CH]);
  let id = 1;
  for (const v of [40, 45, 50, 50, 55, 60, 70, 80, 90, 100]) await post('photo', id++, v); // n = 10, median 57.5 → ok
  for (const v of [1, 2, 3]) await post('album', id++, v);                                // n = 3, median 2 → insufficient
  await post('album', id++, null);                                                          // no snapshot: not in n
  for (const v of [20, 25, 30, 35]) await post('poll', id++, v);                           // n = 4, median 27.5 → low
  await post('photo', id++, 9999, 24 * 40);                                                 // outside the 30-day window
});

after(async () => {
  if (!url) return;
  await pool.query(`DELETE FROM published_posts WHERE channel_id = $1`, [CH]);
  await pool.end();
});

test('loadFormatPerformance: n counts posts with views, median views, confidence; the window and the filter seam apply', { skip }, async () => {
  const rows = await loadFormatPerformance(pool, CH, 30);
  const by = Object.fromEntries(rows.map((r) => [r.format, r]));
  assert.deepEqual([by.photo.posts, by.photo.n, by.photo.median_views, by.photo.confidence], [10, 10, 57.5, 'ok']);
  assert.deepEqual([by.album.posts, by.album.n, by.album.median_views, by.album.confidence], [4, 3, 2, 'insufficient']);
  assert.deepEqual([by.poll.n, by.poll.median_views, by.poll.confidence], [4, 27.5, 'low']);
  assert.equal(typeof by.photo.median_vph, 'number');
  const filtered = await loadFormatPerformance(pool, CH, 30, { sampleFilter: `format <> 'photo'` });
  assert.deepEqual(filtered.map((r) => r.format).sort(), ['album', 'poll']);
});

test('set_format_weights against the real view: album (n = 3, 2 views) refused, photo (n = 10) allowed', { skip }, async () => {
  const written: any[] = [];
  const d = {
    pool, plans: {} as any,
    memory: { listActive: async () => [], add: async () => 1, retireByReviewer: async () => false },
    channels: { setFormatWeights: async (_k: string, w: any) => { written.push(w); return w; } },
    publisher: { send: async () => ({ messageIds: [] }) }, recordPublish: () => {},
  } as unknown as RoleToolDeps;
  const tools = Object.fromEntries(buildRoleTools(d).map((t) => [t.name, t]));
  const c: any = { runId: 'r', role: 'reviewer', channelKey: CH, slotId: null, extras: { card: makeCard({ channelKey: CH }) } };
  const perf: any = await tools.get_format_performance.execute({ days: 30 }, c);
  assert.equal(perf.summary, undefined);
  const refused: any = await tools.set_format_weights.execute({ weights: { album: 0.7 } }, c);
  assert.equal(refused.error, 'insufficient_data');
  assert.deepEqual(refused.details, [{ format: 'album', n: 3, median_views: 2, confidence: 'insufficient' }]);
  assert.equal(((await tools.set_format_weights.execute({ weights: { photo: 0.8 } }, c)) as any).ok, true);
  assert.deepEqual(written, [{ photo: 0.8 }]);
});
