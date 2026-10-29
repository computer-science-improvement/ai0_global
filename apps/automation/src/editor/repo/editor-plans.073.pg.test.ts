/**
 * Spec 073 T7 (A42) against a throwaway Postgres with every migration applied: the empty-day placeholders of a non-material
 * skip (`planner_skipped:`) and of the skeleton check (`series_in_quiet_hours:`, `series_format_unavailable:`) are found by
 * `EMPTY_DAY_ERROR_RE` in Postgres `~` (which has no `\b` word edge): a replan supersedes the future ones, and the same
 * declaration twice writes one row. Creates its own database next to EDITOR_PG_TEST_URL and drops it. Skipped unless
 * EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { createMigratedDb, type FreshDb } from '../sysadmin/testing/fresh-db';
import { EditorPlansRepository } from './editor-plans.repository';
import type { EmptyDaySlot } from '../schedule/empty-day';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@ed073';

let db: FreshDb;
let pool: Pool;
let plans: EditorPlansRepository;

before(async () => {
  if (!url) return;
  db = await createMigratedDb(url, 'ed073');
  pool = db.pool;
  plans = new EditorPlansRepository(pool);
  await pool.query(`INSERT INTO editor_channels (channel_key, mode, formats) VALUES ($1, 'shadow', '{"text":1}')`, [CH]);
});
after(async () => { await db?.drop(); });

const hours = (h: number) => new Date(Date.now() + h * 3600_000);
const placeholder = (series: string, at: Date, error: string): EmptyDaySlot => ({
  scheduledAt: at, resourceRef: null, format: 'text', topic: `Порожній випуск: ${series}`, sourceHints: [`series:${series}`], seriesName: series, error,
});
const rowsOf = async (planDate: string) => (await pool.query(
  `SELECT s.series_name, s.status, s.error, s.scheduled_at FROM editor_slots s JOIN editor_plans p ON p.id = s.plan_id
    WHERE p.channel_key = $1 AND p.plan_date = $2 ORDER BY s.series_name, s.scheduled_at`, [CH, planDate])).rows;

test('replacePlan supersedes the FUTURE planner_skipped / series_in_quiet_hours / series_format_unavailable placeholders and keeps the ones whose time has passed', { skip }, async () => {
  const D = '2099-03-01';
  const past = hours(-3);
  await plans.createPlan(CH, D, 'first', null, [], [
    placeholder('Prompt', hours(5), 'planner_skipped: пораду пропущено'),
    placeholder('Quiet', hours(6), 'series_in_quiet_hours: час серії у тихих годинах'),
    placeholder('NoFormat', hours(7), 'series_format_unavailable: формат недоступний'),
    placeholder('Passed', past, 'planner_skipped: вже минуло'),
    placeholder('Material', hours(8), 'planner_no_material: немає матеріалу'),
  ]);
  const before = await rowsOf(D);
  assert.equal(before.length, 5);
  assert.ok(before.every((r) => r.status === 'skipped'));

  await plans.createPlan(CH, D, 'second', null, [], []);            // a replan of the same day
  const after = Object.fromEntries((await rowsOf(D)).map((r) => [r.series_name, r.error]));
  assert.equal(after.Prompt, 'superseded by a new plan');
  assert.equal(after.Quiet, 'superseded by a new plan');
  assert.equal(after.NoFormat, 'superseded by a new plan');
  assert.equal(after.Material, 'superseded by a new plan', 'the 068 codes still work');
  assert.equal(after.Passed, 'planner_skipped: вже минуло', 'a placeholder whose time has passed stays: it was declared and counted');
});

test('the same declaration twice writes one row — in one plan, and a placeholder of another series, or of the same series more than 90 minutes later, is a row of its own', { skip }, async () => {
  const D = '2099-03-02';
  const at = hours(9);
  const e = placeholder('Prompt', at, 'planner_skipped: пораду пропущено');
  await plans.createPlan(CH, D, 'p', null, [], [e, e, placeholder('Other', at, 'planner_skipped: інша'), placeholder('Prompt', hours(14), 'planner_skipped: пізніший випуск')]);
  const rows = await rowsOf(D);
  assert.deepEqual(rows.map((r) => r.series_name), ['Other', 'Prompt', 'Prompt']);

  // The same series and instant with a different non-material code is the same close: still one.
  await plans.createPlan(CH, '2099-03-03', 'p', null, [], [
    placeholder('Third', at, 'planner_skipped: пораду пропущено'),
    placeholder('Third', at, 'series_in_quiet_hours: тихі години'),
  ]);
  assert.equal((await rowsOf('2099-03-03')).length, 1);
});
