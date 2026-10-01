/**
 * Integration tests against a real (throwaway) Postgres with all migrations
 * applied. Skipped unless EDITOR_PG_TEST_URL is set, e.g.
 *   EDITOR_PG_TEST_URL=postgres://ai0@localhost:54329/ai0 npx tsx --test src/editor/repo/*.pg.test.ts
 * Never point this at a real database: it writes and deletes editor_* rows.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { EditorChannelsRepository } from './editor-channels.repository';
import { EditorPlansRepository } from './editor-plans.repository';
import { EditorMemoryRepository } from './editor-memory.repository';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
let pool: Pool;
const CH = '@pgtest_editor';

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM published_posts WHERE channel_id = $1`, [CH]);
  await pool.query(`INSERT INTO editor_channels (channel_key, mode, formats) VALUES ($1, 'shadow', '{"text":1,"photo":0.5}')`, [CH]);
});
after(async () => {
  if (!url) return;
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM published_posts WHERE channel_id = $1`, [CH]);
  await pool.end();
});

test('channels: get, listActive, bounded setFormatWeights', { skip }, async () => {
  const repo = new EditorChannelsRepository(pool);
  const card = await repo.get(CH);
  assert.equal(card!.mode, 'shadow');
  assert.ok((await repo.listActive()).some((c) => c.channelKey === CH));
  const w = await repo.setFormatWeights(CH, { photo: 5, poll: 0.5, text: 0 });
  assert.deepEqual(w, { text: 0.05, photo: 1 });
});

test('plans: create, supersede, claim, update, stale, sweep', { skip }, async () => {
  const repo = new EditorPlansRepository(pool);
  const now = new Date();
  const s = (minutes: number) => ({ scheduledAt: new Date(now.getTime() + minutes * 60_000), format: 'text', topic: `t${minutes}`, angle: null, sourceHints: ['rss:x'], isExperiment: false });
  const p1 = await repo.createPlan(CH, '2099-01-01', 'first', null, [s(-1), s(60)]);
  const p2 = await repo.createPlan(CH, '2099-01-01', 'second', null, [s(-2), s(120), s(-500)]);
  assert.notEqual(p1, p2);
  assert.equal((await repo.getActivePlan(CH, '2099-01-01'))!.id, p2);
  const old = await repo.listSlots(CH, p1);
  assert.ok(old.every((x) => x.status === 'skipped'));

  const stale = await repo.skipStale(now, 3 * 3600_000);
  assert.ok(stale >= 1);
  const claimed = await repo.claimDue(now, 10);
  assert.equal(claimed.filter((c) => c.channelKey === CH).length, 1);
  const c = claimed.find((x) => x.channelKey === CH)!;
  assert.equal(c.status, 'running');
  assert.equal(c.attempts, 1);
  assert.deepEqual(c.sourceHints, ['rss:x']);

  await repo.updateSlot(c.id, { status: 'shadowed', postSpec: { title: 'x', source: { url: 'https://e.example/a' } }, renderedPreview: 'hello world' });
  assert.equal(await repo.sourceAlreadyPosted(CH, 'https://e.example/a'), true);
  assert.deepEqual(await repo.recentTexts(CH), ['hello world']);

  const pubId = await repo.insertPublication({ channelKey: CH, messageId: 77, sourceUrl: 'library://recipes/1', title: 'T', tags: ['a'], format: 'text', slotId: c.id });
  assert.ok(pubId > 0);
  assert.equal(await repo.countPublishedSince(CH, new Date(now.getTime() - 60_000)), 1);
  assert.ok(await repo.lastPostAt(CH));
  assert.equal(await repo.sourceAlreadyPosted(CH, 'library://recipes/1'), true);

  const next = (await repo.listSlots(CH, p2)).find((x) => x.status === 'planned')!;
  await repo.updateSlot(next.id, { status: 'running' });
  await pool.query(`UPDATE editor_slots SET updated_at = now() - interval '1 hour' WHERE id = $1`, [next.id]);
  const swept = await repo.sweepStuck(new Date(), 15 * 60_000);
  assert.ok(swept.some((x) => x.id === next.id));
  assert.equal(await repo.consecutiveFailures(CH), 1);
});

test('memory: add, list owner-first, reviewer cannot retire owner entries', { skip }, async () => {
  const repo = new EditorMemoryRepository(pool);
  const a = await repo.add(CH, 'insight', 'reviewer note', { n: 3 }, 'reviewer');
  const b = await repo.add(CH, 'rule', 'owner rule', null, 'owner');
  const list = await repo.listActive(CH);
  assert.equal(list[0].id, b);
  assert.equal(await repo.retireByReviewer(CH, b), false);
  assert.equal(await repo.retireByReviewer(CH, a), true);
  assert.equal((await repo.listActive(CH)).length, 1);
});
