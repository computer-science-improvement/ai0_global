/**
 * Spec 042 against a throwaway Postgres: migration 080 (idempotent), one open proposal per channel, the claim / retry / stuck
 * queue, the post top-up into tracked_posts and the overview query. Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { ChannelSetupRepository } from './setup.repository';
import { collectPosts, type HistoryMessage } from './setup-posts';
import { ChannelSetupService } from './setup.service';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const MIGRATION = readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'database', 'migrations', '080_channel_setup.sql'), 'utf8');
const CH = '@pgtest_setup_042';
const OTHER = '@pgtest_setup_042_other';
let pool: Pool;
let repo: ChannelSetupRepository;

async function cleanup() {
  await pool.query(`DELETE FROM channel_setup_proposals WHERE channel_key = ANY($1)`, [[CH, OTHER]]);
  await pool.query(`DELETE FROM tracked_channels WHERE channel_key = ANY($1)`, [[CH, OTHER]]);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await pool.query(MIGRATION);
  await cleanup();
  repo = new ChannelSetupRepository(pool);
  await pool.query(
    `INSERT INTO tracked_channels (channel_key, username, title, is_mine, tracking_status, subs_count)
     VALUES ($1, 'pgtest_setup_042', 'PG 042', true, 'ok', 1500), ($2, 'pgtest_setup_042_other', 'Not mine', false, 'ok', 10)`, [CH, OTHER]);
});
after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

test('080 applies again; an unknown status is refused', { skip }, async () => {
  await pool.query(MIGRATION);
  await assert.rejects(
    pool.query(`INSERT INTO channel_setup_proposals (channel_key, resource_ref, status) VALUES ($1, 'telegram:x', 'maybe')`, [OTHER]),
    /channel_setup_proposals_status_check/);
});

test('queue: a re-run supersedes the open proposal; the index allows one open row per channel', { skip }, async () => {
  const a = await repo.enqueue(CH);
  const b = await repo.enqueue(CH, 'builder');
  assert.equal((await repo.get(a.id))?.status, 'superseded');
  assert.equal(b.status, 'queued');
  assert.equal(b.createdBy, 'builder');
  assert.equal(b.resourceRef, `telegram:${CH}`);
  await assert.rejects(
    pool.query(`INSERT INTO channel_setup_proposals (channel_key, resource_ref) VALUES ($1, $2)`, [CH, `telegram:${CH}`]),
    /uq_channel_setup_proposals_open/);
  const [x, y] = await Promise.all([repo.enqueue(CH), repo.enqueue(CH)]);
  const open = await pool.query(`SELECT id FROM channel_setup_proposals WHERE channel_key = $1 AND status = 'queued'`, [CH]);
  assert.equal(open.rows.length, 1, 'two concurrent runs leave one open proposal');
  assert.ok([x.id, y.id].includes(open.rows[0].id));
});

test('queue: claim honours the retry time, a stuck run goes back, JSON columns round-trip', { skip }, async () => {
  const p = await repo.enqueue(CH);
  const later = new Date(Date.now() + 60_000);
  await repo.update(p.id, { retryAt: later });
  const claimNow = await repo.claimNext(new Date());
  assert.ok(!claimNow || claimNow.channelKey !== CH, 'not before its retry time');
  const claimed = await repo.claimNext(new Date(later.getTime() + 1000));
  assert.equal(claimed?.id, p.id);
  assert.equal(claimed?.status, 'collecting');

  await pool.query(`UPDATE channel_setup_proposals SET updated_at = now() - interval '1 hour' WHERE id = $1`, [p.id]);
  assert.ok(await repo.requeueStuck(new Date(Date.now() - 15 * 60_000)) >= 1);
  assert.equal((await repo.get(p.id))?.status, 'queued');

  const u = await repo.update(p.id, {
    status: 'ready', sectionStatus: { brief_profile: 'pending', schedule: 'skipped' }, metrics: { posts: 8 }, baseline: { brief_profile: 'x' },
    sections: { summary: 's' }, costUsd: 0.0123, postIds: ['00000000-0000-4000-8000-000000000001'],
  });
  assert.deepEqual(u?.sectionStatus, { brief_profile: 'pending', schedule: 'skipped' });
  assert.deepEqual(u?.metrics, { posts: 8 });
  assert.equal(u?.costUsd, 0.0123);
  assert.deepEqual(u?.postIds, ['00000000-0000-4000-8000-000000000001']);
  assert.equal((await repo.latestByChannel()).get(CH)?.id, p.id);
});

const msg = (id: number, hoursAgo: number, text: string, o: Partial<HistoryMessage> = {}): HistoryMessage => ({
  id, date: new Date(Date.now() - hoursAgo * 3_600_000), text, hasMedia: false, mediaType: null, views: 100 + id, forwards: 1,
  replies: 2, reactionsTotal: 3, reactions: { '👍': 3 }, ...o,
});

test('posts: the live read tops tracked_posts up once, a second run reads them back without duplicates', { skip }, async () => {
  const { rows } = await pool.query(`SELECT id FROM tracked_channels WHERE channel_key = $1`, [CH]);
  await pool.query(
    `INSERT INTO tracked_posts (channel_id, tg_message_id, text, posted_at, views) VALUES ($1, 10, 'Старий пост', now() - interval '3 days', 50)`, [rows[0].id]);
  const history = [
    msg(10, 72, 'Старий пост, оновлені метрики'), msg(11, 48, 'Другий пост'), msg(12, 24, '', { hasMedia: true, mediaType: 'photo' }),
    msg(13, 12, 'Третій пост'), msg(14, 6, 'Четвертий'), msg(15, 1, 'Найновіший'), msg(16, 0.5, '   '),
  ];
  let reads = 0;
  const deps = { pool, readHistory: async (target: string, limit: number) => { reads++; assert.equal(target, 'pgtest_setup_042'); assert.equal(limit, 50); return { access: 'ok' as const, messages: history }; } };
  const first = await collectPosts(deps, CH);
  assert.equal(first.status, 'ok');
  assert.equal(reads, 1);
  assert.deepEqual(first.posts.map((p) => p.msgId), [15, 14, 13, 12, 11, 10], 'newest first; the empty post is left out');
  assert.equal(first.posts[0].key, 'p1');
  assert.equal(first.posts.find((p) => p.msgId === 10)?.text, 'Старий пост, оновлені метрики');
  assert.equal(first.posts.find((p) => p.msgId === 12)?.mediaType, 'photo');
  const count = await pool.query(`SELECT count(*)::int AS n FROM tracked_posts WHERE channel_id = $1`, [rows[0].id]);
  assert.equal(count.rows[0].n, 7);

  await collectPosts(deps, CH);
  const again = await pool.query(`SELECT count(*)::int AS n FROM tracked_posts WHERE channel_id = $1`, [rows[0].id]);
  assert.equal(again.rows[0].n, 7, 'no duplicates on a second read');

  const other = await collectPosts({ pool, readHistory: async () => ({ access: 'not_subscribed' as const, messages: [] }) }, '@pgtest_setup_042_missing');
  assert.equal(other.status, 'not_tracked');
});

test('overview: own channels only, with stored posts and the latest proposal', { skip }, async () => {
  const svc = new ChannelSetupService({
    pool, repo, loop: { run: async () => { throw new Error('no model in this test'); } },
    collect: async () => { throw new Error('unused'); }, model: async () => { throw new Error('unused'); },
    state: async () => { throw new Error('unused'); },
    writers: {} as never,
  });
  const { channels, estimateUsd } = await svc.overview();
  const mine = channels.find((c) => c.channelKey === CH);
  assert.ok(mine);
  assert.ok(!channels.some((c) => c.channelKey === OTHER), 'channels that are not own stay out');
  assert.equal(mine.postsStored, 7);
  assert.equal(mine.hasCard, false);
  assert.equal(mine.latest?.status, 'ready');
  assert.ok(estimateUsd === null || typeof estimateUsd === 'number');

  const { refused } = await svc.analyze({ channelKeys: [OTHER] });
  assert.deepEqual(refused, [{ channelKey: OTHER, error: 'not_own_channel' }]);
});
