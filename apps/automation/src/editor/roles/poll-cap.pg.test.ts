/**
 * Spec 034 FR-005 on a throwaway Postgres: SqlPollCaps reads the caps from resource_profiles and counts the
 * poll/quiz slots of the 7-day window (statuses, the plan date's replaceable slots, series), the Telegram card
 * carries the reader-question cap, and the planner's submit_plan refuses a second poll in the week.
 * Skipped unless EDITOR_PG_TEST_URL is set. Never point this at a real database.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { SqlPollCaps } from './poll-cap';
import { zonedToUtc } from './time';
import { validatePlan } from './plan-rules';
import { EditorChannelsRepository } from '../repo/editor-channels.repository';
import { ResourceProfilesRepository } from '../agents/resource-profile';
import { makeDefaultCard } from '../chat/default-card';
import { lintPost } from '../post/lint-post';
import { makeSpec } from '../post/testing/fixtures';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@pollcap034_pg';
const REF = `telegram:${CH}`;
const IG = 'instagram:pollcap034';
const TZ = 'Europe/Kyiv';
const PLAN_DATE = '2026-10-10';
let pool: Pool;

async function cleanup() {
  await pool.query(`DELETE FROM editor_slots WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM resource_profile_versions WHERE resource_ref = ANY($1::text[])`, [[REF, IG]]);
  await pool.query(`DELETE FROM resource_profiles WHERE resource_ref = ANY($1::text[])`, [[REF, IG]]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
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

async function plan(date: string): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO editor_plans (channel_key, plan_date, rationale, status) VALUES ($1, $2, 'test', 'superseded') RETURNING id`, [CH, date]);
  return rows[0].id;
}
async function slot(planId: string, date: string, time: string, format: string, o: { status?: string; kind?: string; series?: string; resourceRef?: string } = {}) {
  await pool.query(
    `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, kind, format, topic, source_hints, status, resource_ref)
     VALUES ($1, $2, $3, $4, $5, 'Тема для тесту', $6, $7, $8)`,
    [planId, CH, zonedToUtc(date, time, TZ), o.kind ?? 'content', format, JSON.stringify(o.series ? [`series:${o.series}`] : []), o.status ?? 'published', o.resourceRef ?? null]);
}

test('SqlPollCaps: caps from the profile, the 7-day window, statuses and the replaceable plan-date slots', { skip }, async () => {
  const channels = new EditorChannelsRepository(pool);
  await channels.insertIfMissing({ ...makeDefaultCard(CH, 'Опитування'), mode: 'live', formats: { text: 1, photo: 1, poll: 0.2, quiz: 0.2 } });
  const profiles = new ResourceProfilesRepository(pool);
  const caps = new SqlPollCaps(pool);

  // No profile: the default cap (1) and an empty window.
  let ctx = await caps.load({ refs: [REF], planDate: PLAN_DATE, tz: TZ, defaultRef: REF });
  assert.deepEqual(ctx, { caps: { [REF]: 1 }, recent: [], defaultRef: REF });

  const p0 = await plan('2026-10-03');
  await slot(p0, '2026-10-03', '12:00', 'poll');                       // 7 days before: outside the window
  const p1 = await plan('2026-10-04');
  await slot(p1, '2026-10-04', '12:00', 'quiz');                       // first day of the window: counts
  await slot(p1, '2026-10-04', '15:00', 'poll', { status: 'skipped' }); // skipped: no
  await slot(p1, '2026-10-04', '18:00', 'photo');                      // not a poll: no
  const p2 = await plan('2026-10-08');
  await slot(p2, '2026-10-08', '12:00', 'poll', { status: 'shadowed', series: 'ПДР щодня' });
  await slot(p2, '2026-10-08', '14:00', 'poll', { status: 'planned', resourceRef: IG });
  const p3 = await plan(PLAN_DATE);
  await slot(p3, PLAN_DATE, '09:00', 'poll', { status: 'planned' });   // replaced by the new plan: no
  await slot(p3, PLAN_DATE, '10:00', 'poll', { status: 'published' }); // already out: counts
  await slot(p3, PLAN_DATE, '11:00', 'poll', { status: 'planned', kind: 'reserved' }); // the owner's chat poll: counts

  ctx = await caps.load({ refs: [REF, IG], planDate: PLAN_DATE, tz: TZ, defaultRef: REF });
  const mine = ctx.recent.filter((r) => r.resourceRef === REF);
  assert.equal(mine.length, 4, JSON.stringify(ctx.recent));
  assert.deepEqual(mine.map((r) => r.series).filter(Boolean), ['ПДР щодня']);
  assert.equal(ctx.recent.filter((r) => r.resourceRef === IG).length, 1);

  // The owner makes the channel a quiz resource: no default cap; then sets one explicitly.
  await profiles.patchFormat(REF, { content_kind: 'quiz' }, { by: 'owner' });
  assert.equal((await caps.load({ refs: [REF], planDate: PLAN_DATE, tz: TZ })).caps[REF], null);
  await profiles.patchFormat(REF, { polls_per_week: 5 }, { by: 'owner' });
  assert.equal((await caps.load({ refs: [REF], planDate: PLAN_DATE, tz: TZ })).caps[REF], 5);

  // validatePlan with the loaded context: 4 counted (one of them an owner/migration series → exempt with the series list).
  const card = (await channels.get(CH))!;
  const now = zonedToUtc(PLAN_DATE, '07:00', TZ);
  const p = { rationale: 'Ще два опитування', slots: [
    { time: '13:00', format: 'poll', topic: 'Улюблена планета', source_hints: [], is_experiment: false },
    { time: '16:00', format: 'quiz', topic: 'Найбільша планета', source_hints: [], is_experiment: false },
  ] };
  const full = await caps.load({ refs: [REF], planDate: PLAN_DATE, tz: TZ, defaultRef: REF });
  const v = validatePlan(p, { ...card, postsPerDayMin: 1 }, PLAN_DATE, now, [], undefined, [], full);
  assert.equal(v.ok, false);
  assert.match((v as { errors: string[] }).errors.join('\n'), /було б 6 \(уже 4, у плані 2\) — ліміт ресурсу 5 на тиждень/);
});

test('the Telegram card carries the reader-question cap: news topic → 0, owner override → 2', { skip }, async () => {
  const channels = new EditorChannelsRepository(pool);
  await channels.insertIfMissing({ ...makeDefaultCard(CH, 'Опитування'), mode: 'live' });
  const profiles = new ResourceProfilesRepository(pool);
  await profiles.setProfile(REF, {
    topic: 'Новини Києва за день', audience: { who: 'кияни' }, language: 'uk', goals: ['growth'], taboo: [], sources: [],
    ads_allowed: { allowed: true, categories: [] }, examples: [],
  }, 'owner');
  await profiles.patchFormat(REF, { content_kind: null, polls_per_week: null }, { by: 'owner', replace: true });
  let card = (await channels.get(CH))!;
  assert.deepEqual([card.readerQuestionsMax, card.pollsPerWeek], [0, 1]);
  const spec = makeSpec({ body: [{ type: 'lead', text: 'Метро відкрили після ремонту' }, { type: 'p', text: 'Станція працює з 6:00. А ви вже їздили?' }] });
  assert.ok(lintPost(spec, card).errors.some((e) => e.code === 'reader_questions'));
  assert.equal((await profiles.capsOf(REF)).kind, 'news');

  await profiles.patchFormat(REF, { questions_to_readers_per_day: 2 }, { by: 'owner' });
  card = (await channels.get(CH))!;
  assert.equal(card.readerQuestionsMax, 2);
  assert.ok(!lintPost(spec, card).errors.some((e) => e.code === 'reader_questions'));
  // An agent cannot raise it back above the default.
  const r = await profiles.patchFormat(REF, { questions_to_readers_per_day: 3 }, { by: 'agent', reason: 'читачі відповідають' });
  assert.equal('error' in r && r.error, 'owner_only');
});
