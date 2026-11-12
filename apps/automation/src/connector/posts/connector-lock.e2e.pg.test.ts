/**
 * Spec 103 WP-C: a prepared post survives a replan. Depends on WP-B's replacePlan change (locked slots are kept);
 * on a branch without it this fails for that reason only. Throwaway Postgres (prefix p103c_), scripted planner.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { createMigratedDb, type FreshDb } from '../../editor/sysadmin/testing/fresh-db';
import { FakeLlm } from '../../editor/harness/testing/fakes';
import { SPEC, cleanChannel, harness, seedChannel } from '../testing/pg-harness';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const NOW = new Date('2030-03-04T07:00:00Z'); // Monday 09:00 Kyiv
let db: FreshDb;
let pool: Pool;

before(async () => {
  if (!url) return;
  db = await createMigratedDb(url, 'p103f_lock');
  pool = db.pool;
});
after(async () => { if (db) await db.drop(); });

test('prepare_post → replan → the prepared post stays, untouched', { skip }, async () => {
  const CH = '@p103c_lock';
  await seedChannel(pool, CH, 'approve');
  const clock = { now: NOW };
  const llm = new FakeLlm([
    { calls: [{ name: 'submit_plan', args: { rationale: 'One post late morning.', slots: [{ time: '11:00', format: 'text', topic: 'An agent topic about telescopes' }] } }] },
    { calls: [{ name: 'submit_plan', args: { rationale: 'Replanned: one post at noon.', slots: [{ time: '12:00', format: 'text', topic: 'A different agent topic about nebulae' }] } }] },
  ]);
  const h = harness(pool, clock, llm);
  const card = (await h.channels.get(CH))!;

  const first = await h.runner.runPlanner(card);
  assert.equal(first.terminalTool, 'submit_plan', JSON.stringify(first));
  const mine: any = await h.posts.prepare({ channel: CH, at: '2030-03-04 15:00', post: SPEC });

  const second = await h.runner.runPlanner(card);
  assert.equal(second.terminalTool, 'submit_plan', JSON.stringify(second));

  const slot = (await h.plans.getSlot(mine.post_id))!;
  assert.equal(slot.status, 'awaiting_approval', 'the prepared post is not skipped by the replan');
  assert.equal(slot.lockedBy, 'connector');
  const plan = (await h.plans.getActivePlan(CH, '2030-03-04'))!;
  assert.equal(slot.planId, plan.id, 'it moved with the plan: the new active plan carries it');
  const open = (await h.plans.listSlots(CH, plan.id)).filter((s) => s.status === 'planned');
  assert.equal(open.length, 1, 'the agent replaced only its own slots');
  await cleanChannel(pool, CH);
});

// ── review fixes: LOCK-3/C2 (topic reaches the executor) and LOCK-4/C3 (a moved slot changes plan day) ──

test('LOCK-3/C2: update_post of an agent live/series slot makes it a fixed slot with the owner topic and no old drivers', { skip }, async () => {
  const CH = '@p103f_topic';
  await seedChannel(pool, CH, 'live');
  const h = harness(pool, { now: NOW }, new FakeLlm([]));
  const card = (await h.channels.get(CH))!;
  const made: any = await h.posts.plan({ channel: CH, at: '2030-03-05 11:00', topic: 'Agent topic', notes: 'n' });
  // Make it look like an agent's live news slot that also sits in a series.
  await pool.query(
    `UPDATE editor_slots SET topic_mode = 'live', series_name = 'Old series', source_hints = $2,
            live_spec = '{"sources":["https://feed.example/rss"],"brief":"freshest space news","max_age_hours":24,"origin":"planner"}'
      WHERE id = $1`, [made.post_id, JSON.stringify(['series:Old series', 'https://old.example'])]);
  await h.posts.update({ postId: made.post_id, topic: 'The owner topic about Webb', angle: 'infrared' });
  const slot = (await h.plans.getSlot(made.post_id))!;
  assert.equal(slot.topic, 'The owner topic about Webb');
  assert.notEqual(slot.topicMode, 'live');
  assert.equal((await pool.query(`SELECT topic_mode FROM editor_slots WHERE id = $1`, [made.post_id])).rows[0].topic_mode, 'fixed');
  assert.equal(slot.liveSpec, undefined);
  assert.equal(slot.seriesName, undefined);
  assert.equal(slot.ideaId, undefined);
  assert.deepEqual(slot.sourceHints, ['connector:plan']);
  assert.equal(slot.lockedBy, 'connector');
  const { executorUserPrompt } = await import('../../editor/roles/prompts');
  const prompt = executorUserPrompt(card, slot, NOW);
  assert.match(prompt, /Тема: The owner topic about Webb/);
  assert.match(prompt, /Кут подачі: infrared/);
  assert.doesNotMatch(prompt, /freshest space news|Old series|old\.example/);
  await cleanChannel(pool, CH);
});

test('LOCK-4/C3: update_post to another local day moves the slot into that day\'s plan (planned and written)', { skip }, async () => {
  const CH = '@p103f_move';
  await seedChannel(pool, CH, 'approve');
  const h = harness(pool, { now: NOW }, new FakeLlm([]));
  const { ScheduleRepository } = await import('../../editor/schedule/schedule.repository');
  const sched = new ScheduleRepository(pool as any);
  const keepUntil = NOW;
  const planned: any = await h.posts.plan({ channel: CH, at: '2030-03-05 11:00', topic: 'A planned one' });
  const written: any = await h.posts.prepare({ channel: CH, at: '2030-03-05 15:00', post: SPEC });
  const ids = async (day: string) => (await sched.keptOn(CH, day, keepUntil)).map((s) => s.id);
  assert.deepEqual((await ids('2030-03-05')).sort(), [planned.post_id, written.post_id].sort());
  assert.deepEqual(await ids('2030-03-06'), []);

  await h.posts.update({ postId: planned.post_id, at: '2030-03-06 11:00' });
  await h.posts.update({ postId: written.post_id, at: '2030-03-06 15:00' });
  assert.deepEqual(await ids('2030-03-05'), [], 'the old day no longer counts them');
  assert.deepEqual((await ids('2030-03-06')).sort(), [planned.post_id, written.post_id].sort(), 'the new day plans around both');
  // Same-day move keeps the plan.
  await h.posts.update({ postId: planned.post_id, at: '2030-03-06 12:30' });
  assert.ok((await ids('2030-03-06')).includes(planned.post_id));
  await cleanChannel(pool, CH);
});
