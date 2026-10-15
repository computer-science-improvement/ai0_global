/**
 * Spec 037 FR-007 (T7) on a throwaway Postgres: `poll_cap_reached` before publishing counts the channel's actual poll
 * and quiz posts — published (agent slots and chat posts), waiting for approval and approved — and blocks a second
 * poll in the week with cap 1 through publish_post on a live slot, before anything is sent. Skipped unless
 * EDITOR_PG_TEST_URL is set. Never point this at a real database.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { buildRoleTools } from '../../tools/role-tools';
import { EditorChannelsRepository } from '../../repo/editor-channels.repository';
import { EditorPlansRepository } from '../../repo/editor-plans.repository';
import { EditorMemoryRepository } from '../../repo/editor-memory.repository';
import { makeDefaultCard } from '../../chat/default-card';
import { zonedToUtc } from '../../roles/time';
import { loadPollPosts, pollCapGuard } from './poll-cap-guard';
import { PostSpecSchema } from '../post-spec';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@pollcap037_pg';
const TZ = 'Europe/Kyiv';
const TODAY = '2030-05-10';
let pool: Pool;

async function cleanup() {
  await pool.query(`DELETE FROM content_ledger WHERE resource_ref = $1`, [CH]).catch(() => {});
  await pool.query(`DELETE FROM content_ledger WHERE resource_ref = $1`, [`telegram:${CH}`]).catch(() => {});
  await pool.query(`DELETE FROM published_posts WHERE channel_id = $1`, [CH]);
  await pool.query(`DELETE FROM editor_slots WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  await new EditorChannelsRepository(pool).insertIfMissing({
    ...makeDefaultCard(CH, 'Ігри'), mode: 'live', quietStartHour: 23, quietEndHour: 7, minGapMinutes: 0, postsPerDayMax: 10,
    formats: { text: 1, poll: 0.3, quiz: 0.3 }, hashtags: [], hashtagMin: 0, hashtagMax: 3,
  });
});
after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

async function plan(date: string): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO editor_plans (channel_key, plan_date, rationale, status) VALUES ($1, $2, 'test', 'superseded') RETURNING id`, [CH, date]);
  return rows[0].id;
}
async function slot(date: string, time: string, format: string, status: string, o: { live?: boolean } = {}): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, kind, format, topic, source_hints, status, topic_mode, live_spec)
     VALUES ($1, $2, $3, 'content', $4, 'Тема', '[]'::jsonb, $5, $6, $7) RETURNING id`,
    [await plan(date), CH, zonedToUtc(date, time, TZ), format, status, o.live ? 'live' : 'fixed',
      o.live ? JSON.stringify({ sources: ['feed1'], brief: 'Свіжа новина', origin: 'planner' }) : null]);
  return rows[0].id;
}
async function published(date: string, time: string, format: string, slotId: string | null, strategy = 'editor') {
  await pool.query(
    `INSERT INTO published_posts (channel_id, message_id, title, strategy_type, format, editor_slot_id, posted_at)
     VALUES ($1::text, (SELECT COALESCE(MAX(message_id), 0) + 1 FROM published_posts WHERE channel_id = $1::text), 'т', $2, $3, $4, $5)`,
    [CH, strategy, format, slotId, zonedToUtc(date, time, TZ)]);
}

const pollSpec = (over: Record<string, unknown> = {}) => PostSpecSchema.parse({
  format: 'poll', title: 'Роздачі', origin: 'original', body: [], hashtags: [],
  poll: { question: 'Що ви робите з безкоштовними іграми?', options: ['Забираю все', 'Лише те, що гратиму'], anonymous: true },
  ...over,
});

test('poll cap on actual posts: a second poll in the week is blocked on a live slot before publishing', { skip }, async () => {
  const channels = new EditorChannelsRepository(pool);
  const plans = new EditorPlansRepository(pool);
  const card = (await channels.get(CH))!;
  assert.equal(card.pollsPerWeek, 1, 'default cap');
  const now = zonedToUtc(TODAY, '20:00', TZ);
  const sent: unknown[] = [];
  const tools = Object.fromEntries(buildRoleTools({
    pool, plans, memory: new EditorMemoryRepository(pool), channels,
    publisher: { send: async (_k, m) => { sent.push(m); return { messageIds: [7000 + sent.length] }; } },
    recordPublish: () => {}, now: () => now,
  }).map((t) => [t.name, t]));
  const run = async (slotId: string) => tools.publish_post.execute({ spec: pollSpec() }, { runId: 'run-pc', role: 'executor', channelKey: CH, slotId, extras: { card } }) as Promise<any>;

  // 07.05: a poll went out (agent slot + its publication row: one post).
  const s1 = await slot('2030-05-07', '21:00', 'poll', 'published');
  await published('2030-05-07', '21:00', 'poll', s1);
  const live = await slot(TODAY, '20:00', 'poll', 'running', { live: true });
  assert.equal((await plans.getSlot(live))!.topicMode, 'live');
  assert.equal((await loadPollPosts(pool, { channelKey: CH, at: now, slotId: live })).length, 1, 'counted once');

  const r1 = await run(live);
  assert.equal(r1.error, 'poll_cap_reached', JSON.stringify(r1));
  assert.match(String(r1.details), /уже 1.*ліміт ресурсу 1 на тиждень/);
  assert.equal(sent.length, 0, 'nothing sent');
  assert.equal((await plans.getSlot(live))!.status, 'running', 'the slot is not stored as published');

  // The week moves on: a poll 7 local days back is out of the window → the live poll goes out.
  await pool.query(`UPDATE published_posts SET posted_at = $2 WHERE channel_id = $1`, [CH, zonedToUtc('2030-05-03', '21:00', TZ)]);
  await pool.query(`UPDATE editor_slots SET scheduled_at = $2 WHERE id = $1`, [s1, zonedToUtc('2030-05-03', '21:00', TZ)]);
  const r2 = await run(live);
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(sent.length, 1);
  // The publication row is stamped by the DB clock; put it at the test's clock (2030).
  await pool.query(`UPDATE published_posts SET posted_at = $2 WHERE editor_slot_id = $1`, [live, now]);

  // Now that one is out: another live poll the same week is blocked.
  const live2 = await slot(TODAY, '21:00', 'quiz', 'running', { live: true });
  const r3 = await tools.publish_post.execute({ spec: pollSpec({ format: 'quiz', poll: { question: 'Скільки ігор роздає Epic цього тижня?', options: ['1', '2', '3'], correct_index: 1, explanation: 'Дві: System Shock 2 і BURIED STARS.', anonymous: true } }) },
    { runId: 'run-pc', role: 'executor', channelKey: CH, slotId: live2, extras: { card } }) as any;
  assert.equal(r3.error, 'poll_cap_reached', JSON.stringify(r3));
  assert.equal(sent.length, 1);
});

test('poll cap counts chat polls, waiting and approved ones; skipped / shadowed / other formats do not count', { skip }, async () => {
  await pool.query(`DELETE FROM published_posts WHERE channel_id = $1`, [CH]);
  await pool.query(`DELETE FROM editor_slots WHERE channel_key = $1`, [CH]);
  const at = zonedToUtc(TODAY, '12:00', TZ);
  const guard = () => pollCapGuard(pool, { channelKey: CH, format: 'poll', at, timezone: TZ, cap: 1, slotId: null });

  await slot('2030-05-08', '10:00', 'poll', 'skipped');
  await slot('2030-05-08', '11:00', 'poll', 'shadowed');
  await slot('2030-05-09', '11:00', 'text', 'published');
  await published('2030-05-09', '11:00', 'text', null, 'chat');
  assert.equal(await guard(), null);

  // A chat poll published right away (no slot).
  await published('2030-05-09', '18:00', 'poll', null, 'chat');
  assert.equal((await guard())?.error, 'poll_cap_reached');
  await pool.query(`DELETE FROM published_posts WHERE channel_id = $1 AND format = 'poll'`, [CH]);

  // Waiting for the owner later in the week, then approved.
  const waiting = await slot('2030-05-13', '10:00', 'quiz', 'awaiting_approval');
  assert.equal((await guard())?.error, 'poll_cap_reached', 'waiting');
  await pool.query(`UPDATE editor_slots SET status = 'approved', approved_at = now() WHERE id = $1`, [waiting]);
  assert.equal((await guard())?.error, 'poll_cap_reached', 'approved');
  // The waiting slot itself is not counted against itself.
  assert.equal(await pollCapGuard(pool, { channelKey: CH, format: 'quiz', at, timezone: TZ, cap: 1, slotId: waiting }), null);
});
