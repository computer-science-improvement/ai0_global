/**
 * Spec 073 FR-001 on a throwaway Postgres (init.sql + every migration): the `pin` and `series` columns of the two poll-cap
 * SQLs (SqlPollCaps.load for the plan validators, loadPollPosts for the publish guard). Skipped unless
 * EDITOR_PG_TEST_URL is set (needs CREATEDB). Never point this at a real database.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { SqlPollCaps } from './poll-cap';
import { zonedToUtc } from './time';
import { loadPollPosts, pollCapIssue } from '../post/polls/poll-cap-guard';
import { createMigratedDb, type FreshDb } from '../sysadmin/testing/fresh-db';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@pgt073_polls';
const REF = `telegram:${CH}`;
const TZ = 'Europe/Kyiv';
const PLAN_DATE = '2026-10-10';
let db: FreshDb;
let pool: Pool;
let planId: string;
let ruleId: string;

async function slot(date: string, time: string, o: { format?: string; series?: string; hint?: string; rule?: boolean; status?: string } = {}) {
  await pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, kind, format, topic, source_hints, status, series_name, schedule_rule_id, rule_date)
     VALUES ($1, $2, $3, 'content', $4, 'Тема', $5, $6, $7, $8, $9)`,
    [planId, CH, zonedToUtc(date, time, TZ), o.format ?? 'quiz', JSON.stringify(o.hint ? [`series:${o.hint}`] : []), o.status ?? 'published', o.series ?? null, o.rule ? ruleId : null, o.rule ? date : null]);
}

before(async () => {
  if (!url) return;
  db = await createMigratedDb(url, 'p073');
  pool = db.pool;
  await pool.query(`INSERT INTO editor_channels (channel_key, mode, formats) VALUES ($1, 'live', '{"text":1,"quiz":0.2}')`, [CH]);
  planId = (await pool.query(`INSERT INTO editor_plans (channel_key, plan_date, rationale, status) VALUES ($1, $2, 'test', 'superseded') RETURNING id`, [CH, PLAN_DATE])).rows[0].id;
  const agent = (await pool.query(`INSERT INTO agents (kind, scope, scope_id, name, handle, mode, created_by) VALUES ('orchestrator', 'resource', $1, 'P', 'pgt073p', 'live', 'owner') RETURNING id`, [REF])).rows[0].id;
  ruleId = (await pool.query(`INSERT INTO schedule_rules (agent_id, resource_ref, kind, at_local, format) VALUES ($1, $2, 'pin', '12:00', 'quiz') RETURNING id`, [agent, REF])).rows[0].id;
});
after(async () => { if (db) await db.drop(); });

test('SqlPollCaps.load marks series_name and series-hint slots with their series and pins with pin=true', { skip }, async () => {
  await slot('2026-10-05', '12:00', { series: 'Білети ПДР' });       // the series_name column alone
  await slot('2026-10-06', '12:00', { hint: 'Білети ПДР' });          // the hint alone
  await slot('2026-10-07', '12:00', { rule: true });                  // a pin
  await slot('2026-10-08', '12:00', { format: 'poll' });              // improvised
  await slot('2026-10-08', '15:00', { format: 'photo', series: 'Фото' }); // not a poll
  const ctx = await new SqlPollCaps(pool).load({ refs: [REF], planDate: PLAN_DATE, tz: TZ, defaultRef: REF });
  const rows = ctx.recent.filter((r) => r.resourceRef === REF);
  assert.equal(rows.length, 4, JSON.stringify(rows));
  assert.deepEqual(rows.map((r) => r.series).filter(Boolean), ['Білети ПДР', 'Білети ПДР']);
  assert.equal(rows.filter((r) => r.pin).length, 1);
  assert.equal(rows.filter((r) => !r.pin && !r.series).length, 1, 'only the improvised poll is left to count');
});

test('loadPollPosts carries series and pin in both UNION branches, and pollCapIssue ignores them', { skip }, async () => {
  const at = zonedToUtc('2026-10-09', '12:00', TZ);
  await slot('2026-10-12', '12:00', { series: 'Білети ПДР', status: 'awaiting_approval' }); // the slots branch
  const rows = await loadPollPosts(pool, { channelKey: CH, at, slotId: null });
  assert.equal(rows.length, 5, JSON.stringify(rows));
  assert.ok(rows.every((r) => typeof r.pin === 'boolean'));
  assert.equal(rows.filter((r) => r.series).length, 3);
  assert.equal(rows.filter((r) => r.pin).length, 1);
  // Only the one improvised poll counts: a cap of 1 is full for an improvised post, and never for a series or pin post.
  const input = { channelKey: CH, format: 'poll', at, timezone: TZ, cap: 1 };
  assert.equal(pollCapIssue(input, rows)?.error, 'poll_cap_reached');
  assert.equal(pollCapIssue({ ...input, series: 'Білети ПДР' }, rows), null);
  assert.equal(pollCapIssue({ ...input, pin: true }, rows), null);
});
