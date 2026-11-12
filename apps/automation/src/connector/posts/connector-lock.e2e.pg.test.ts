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
  db = await createMigratedDb(url, 'p103c_lock');
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
