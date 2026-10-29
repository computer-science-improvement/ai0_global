/**
 * Spec 073 T6 (FR-005, A11) against a throwaway Postgres with every migration applied: `plannerRunsOn` counts a channel's planner
 * runs of one local day (`n`), those that left no plan (`failed`) and the latest of those (`lastFailedAt`), honours `since`
 * and the local-day boundary (also across a DST change); `lastToolErrors` returns the validator's lines of the last failed call.
 * Creates its own database next to EDITOR_PG_TEST_URL and drops it. Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createMigratedDb, type FreshDb } from '../sysadmin/testing/fresh-db';
import { lastToolErrors, plannerRunsOn } from './planner-runs';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const KYIV = 'Europe/Kyiv';

let db: FreshDb;
let pool: Pool;

before(async () => {
  if (!url) return;
  db = await createMigratedDb(url, 'pr073');
  pool = db.pool;
  for (const k of ['@pr_a', '@pr_b']) await pool.query(`INSERT INTO editor_channels (channel_key, mode, formats) VALUES ($1, 'shadow', '{"text":1}')`, [k]);
});
after(async () => { await db?.drop(); });

async function run(channel: string, role: string, startedAt: string, plan?: { date: string }): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO editor_runs (id, role, channel_key, model, status, started_at) VALUES ($1, $2, $3, 'm', 'error', $4)`, [id, role, channel, startedAt]);
  if (plan) await pool.query(`INSERT INTO editor_plans (channel_key, plan_date, rationale, run_id, status) VALUES ($1, $2, 'r', $3, 'superseded')`, [channel, plan.date, id]);
  return id;
}

test('plannerRunsOn: n counts the day\'s planner runs of the channel, failed those without a plan, lastFailedAt the latest of them', { skip }, async () => {
  await run('@pr_a', 'planner', '2026-10-01T03:00:00Z');                                      // 06:00 local, failed
  await run('@pr_a', 'planner', '2026-10-01T03:30:00Z');                                      // 06:30 local, failed
  await run('@pr_a', 'planner', '2026-10-01T04:00:00Z', { date: '2026-10-01' });              // 07:00 local, made a plan (since superseded)
  await run('@pr_a', 'executor', '2026-10-01T04:30:00Z');                                     // not a planner
  await run('@pr_b', 'planner', '2026-10-01T04:30:00Z');                                      // another channel
  const r = await plannerRunsOn(pool, '@pr_a', KYIV, '2026-10-01');
  assert.equal(r.n, 3);
  assert.equal(r.failed, 2);
  assert.equal(r.lastFailedAt?.toISOString(), '2026-10-01T03:30:00.000Z');
  assert.deepEqual(await plannerRunsOn(pool, '@pr_b', KYIV, '2026-10-01').then((x) => [x.n, x.failed]), [1, 1]);
});

test('plannerRunsOn: a channel with no runs, or a day with none, is 0 / 0 / null', { skip }, async () => {
  assert.deepEqual(await plannerRunsOn(pool, '@pr_a', KYIV, '2026-12-24'), { n: 0, failed: 0, lastFailedAt: null });
  assert.deepEqual(await plannerRunsOn(pool, '@nobody', KYIV, '2026-10-01'), { n: 0, failed: 0, lastFailedAt: null });
});

test('plannerRunsOn: since keeps only the runs at or after it, and all three numbers follow', { skip }, async () => {
  const all = await plannerRunsOn(pool, '@pr_a', KYIV, '2026-10-01');
  const late = await plannerRunsOn(pool, '@pr_a', KYIV, '2026-10-01', { since: new Date('2026-10-01T03:10:00Z') });
  assert.deepEqual([all.n, all.failed], [3, 2]);
  assert.deepEqual([late.n, late.failed, late.lastFailedAt?.toISOString()], [2, 1, '2026-10-01T03:30:00.000Z']);
  const exact = await plannerRunsOn(pool, '@pr_a', KYIV, '2026-10-01', { since: new Date('2026-10-01T03:30:00Z') });
  assert.deepEqual([exact.n, exact.failed], [2, 1], 'at or after');
  const none = await plannerRunsOn(pool, '@pr_a', KYIV, '2026-10-01', { since: new Date('2026-10-01T05:00:00Z') });
  assert.deepEqual(none, { n: 0, failed: 0, lastFailedAt: null });
});

test('plannerRunsOn: the day is the LOCAL day of the zone — midnight edges, and the 25-hour day when summer time ends', { skip }, async () => {
  // Kyiv is UTC+3 until 2026-10-25 03:00 local, UTC+2 after. Oct 2: 2026-10-01T21:00Z (00:00 local) … 2026-10-02T20:59:59Z.
  await run('@pr_b', 'planner', '2026-10-01T20:59:59Z');   // 23:59:59 local on Oct 1
  await run('@pr_b', 'planner', '2026-10-01T21:00:00Z');   // 00:00:00 local on Oct 2
  await run('@pr_b', 'planner', '2026-10-02T20:59:59Z');   // 23:59:59 local on Oct 2
  await run('@pr_b', 'planner', '2026-10-02T21:00:00Z');   // 00:00:00 local on Oct 3
  const oct1 = await plannerRunsOn(pool, '@pr_b', KYIV, '2026-10-01');
  const oct2 = await plannerRunsOn(pool, '@pr_b', KYIV, '2026-10-02');
  const oct3 = await plannerRunsOn(pool, '@pr_b', KYIV, '2026-10-03');
  assert.equal(oct1.n, 2, 'the 04:30Z run of the first test plus the 23:59:59 one');
  assert.equal(oct2.n, 2);
  assert.equal(oct3.n, 1);

  // 2026-10-25 has 25 hours in Kyiv: 2026-10-24T21:00Z … 2026-10-25T22:00Z (exclusive).
  await run('@pr_b', 'planner', '2026-10-24T20:59:59Z');   // 23:59:59 local Oct 24
  await run('@pr_b', 'planner', '2026-10-24T21:00:00Z');   // 00:00 local Oct 25
  await run('@pr_b', 'planner', '2026-10-25T21:59:59Z');   // 23:59:59 local Oct 25 (the 25th hour of the day)
  await run('@pr_b', 'planner', '2026-10-25T22:00:00Z');   // 00:00 local Oct 26
  assert.equal((await plannerRunsOn(pool, '@pr_b', KYIV, '2026-10-25')).n, 2);
  assert.equal((await plannerRunsOn(pool, '@pr_b', KYIV, '2026-10-24')).n, 1);
  assert.equal((await plannerRunsOn(pool, '@pr_b', KYIV, '2026-10-26')).n, 1);
  // The same instants read in UTC fall on other days: the zone parameter matters.
  assert.equal((await plannerRunsOn(pool, '@pr_b', 'UTC', '2026-10-25')).n, 2 /* 21:59:59Z of the 25th and 22:00Z of the 25th */);
});

test('lastToolErrors: the validator lines of the LAST failed call of the tool, up to 5, each clipped to 200 characters', { skip }, async () => {
  const id = await run('@pr_a', 'planner', '2026-11-01T06:00:00Z');
  const step = (idx: number, tool: string, isError: boolean, output: unknown) =>
    pool.query(`INSERT INTO editor_run_steps (run_id, idx, type, tool_name, input, output, is_error) VALUES ($1, $2, 'tool', $3, '{}', $4, $5)`, [id, idx, tool, JSON.stringify(output), isError]);
  assert.deepEqual(await lastToolErrors(pool, id, 'submit_plan'), [], 'no such step yet');
  await step(1, 'submit_plan', true, { error: 'plan_invalid', details: ['early 1', 'early 2'] });
  await step(2, 'get_channel_card', true, { error: 'x', details: ['other tool'] });
  await step(3, 'submit_plan', true, { error: 'plan_invalid', details: ['later 1', 'later 2'] });
  assert.deepEqual(await lastToolErrors(pool, id, 'submit_plan'), ['later 1', 'later 2']);
  assert.deepEqual(await lastToolErrors(pool, id, 'submit_network_plan'), []);

  await step(4, 'submit_plan', false, { ok: true });                                               // a success is not an error step
  assert.deepEqual(await lastToolErrors(pool, id, 'submit_plan'), ['later 1', 'later 2']);

  const long = `слот 7: ${'дуже довгий опис проблеми '.repeat(30)}`;
  await step(5, 'submit_plan', true, { error: 'plan_invalid', details: ['1', '2', long, '4', '5', '6', '7'] });
  const lines = await lastToolErrors(pool, id, 'submit_plan');
  assert.equal(lines.length, 5);
  assert.equal(lines[2].length, 200);
  assert.ok(lines[2].endsWith('…') && lines[2].startsWith('слот 7: '));
  assert.deepEqual([lines[0], lines[4]], ['1', '5']);

  await step(6, 'submit_plan', true, { error: 'plan_invalid', details: 'one plain string' });
  assert.deepEqual(await lastToolErrors(pool, id, 'submit_plan'), ['one plain string']);
  await step(7, 'submit_plan', true, { error: 'plan_invalid' });
  assert.deepEqual(await lastToolErrors(pool, id, 'submit_plan'), [], 'an error without lines');
});
