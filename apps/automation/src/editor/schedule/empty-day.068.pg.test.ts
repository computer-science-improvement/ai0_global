/**
 * Spec 068 T2 (FR-004, FR-005) against a throwaway Postgres with every migration applied (093 included): the placeholder
 * slots of an honest empty day are written in the plan's own transaction; a replan replaces the future ones and keeps those
 * whose time has passed (a `short_day` and a replan five hours later count once); the dead-series breaker counts
 * placeholders as ordinary closes, and once it pauses the series the planners' minimum and the silent-days minimum drop.
 * Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { AgentsRepository } from '../agents/agents.repository';
import { OwnerInbox } from '../agents/owner-inbox';
import { EditorChannelsRepository } from '../repo/editor-channels.repository';
import { EditorPlansRepository } from '../repo/editor-plans.repository';
import { NetworkRepository } from '../network/network.repository';
import { PlaybookSchema } from '../network/playbook';
import { seriesSourceCatalog } from '../network/series-edit';
import { validatePlan } from '../roles/plan-rules';
import { PlannerPauseView } from '../series-pause/planner-view';
import { SeriesBreaker } from '../series-pause/series-breaker';
import { SeriesPausesRepository } from '../series-pause/series-pauses.repository';
import { classifyClose } from '../series-pause/skip-cause';
import { SilentDaysWatch } from '../silent/silent-days';
import { emptyDayError, shortDayPlaceholder, type EmptyDaySlot } from './empty-day';
import { ScheduleRepository } from './schedule.repository';
import { isFail, ScheduleService } from './schedule.service';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@pgt068t2_food';
const TG = `telegram:${CH}`;
const HANDLE = 'pgt068t2_chef';
// A fixed future morning (08:00 Kyiv) so nothing depends on when the tests run.
const NOW = new Date('2030-01-15T06:00:00Z');
const TODAY = '2030-01-15';
const HOUR = 3600_000;
const REASON = 'Бібліотека рецептів порожня, нових немає';
let pool: Pool;
let agentId: string;
let clock = NOW;

const BODY = PlaybookSchema.parse({
  platforms: [{ resource_ref: TG, role: 'core', formats: { photo: 1, text: 0.5 }, per_day: { min: 1, max: 4 } }],
  series: [{
    name: 'Рецепт дня', cadence: 'daily@19:00', resource_ref: TG, format: 'photo', brief: 'Рецепт з бібліотеки щовечора',
    source: { kind: 'library', table: 'recipes' }, source_mode: 'required', origin: 'owner', locked: true,
  }],
});

async function cleanup() {
  await pool.query(`DELETE FROM agent_inbox WHERE title LIKE '%pgt068t2%'`).catch(() => {});
  await pool.query(`DELETE FROM series_pauses WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_slots WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM agent_inbox WHERE agent_id IN (SELECT id FROM agents WHERE handle = $1)`, [HANDLE]).catch(() => {});
  await pool.query(`DELETE FROM agents WHERE handle = $1`, [HANDLE]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  agentId = (await pool.query(
    `INSERT INTO agents (kind, scope, scope_id, name, handle, mode) VALUES ('orchestrator', 'resource', $1, 'Chef', $2, 'live') RETURNING id`,
    [TG, HANDLE])).rows[0].id;
  await pool.query(
    `INSERT INTO editor_channels (channel_key, mode, formats, hashtags, posts_per_day_min, posts_per_day_max) VALUES ($1, 'live', '{"photo":1,"text":1}', '{їжа}', 1, 4)`, [CH]);
  await new NetworkRepository(pool).insertPlaybook({ agentId, status: 'active', brief: null, body: BODY, rationale: 'seed', createdBy: 'owner' });
});

after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

const pausesRepo = () => new SeriesPausesRepository(pool);
function service() {
  const channels = new EditorChannelsRepository(pool);
  const plans = new EditorPlansRepository(pool, () => clock);
  const svc = new ScheduleService({
    pool, rules: new ScheduleRepository(pool), network: new NetworkRepository(pool), agents: new AgentsRepository(pool),
    card: (k) => channels.get(k), plans, inbox: new OwnerInbox(pool, async () => {}),
    time: { tzOf: async () => 'Europe/Kyiv', quietOf: async () => ({ start: 23, end: 8 }) },
    sourceCatalog: (card) => seriesSourceCatalog(pool, card),
    pauses: new PlannerPauseView(pausesRepo()),
    now: () => clock,
  });
  return { svc, plans, channels };
}
async function scope(svc: ScheduleService) {
  const sc = await svc.scopeByHandle(HANDLE);
  assert.ok(!isFail(sc), JSON.stringify(sc));
  return sc as Exclude<typeof sc, { error: string }>;
}

/** A plan of the day as the planner tool would build it: validated against the real context, so the placeholders are the real ones. */
async function validated(svc: ScheduleService, plan: Parameters<typeof validatePlan>[0]) {
  const sc = await scope(svc);
  const ctx = await svc.planContext(sc.card, sc.net, TODAY, clock, 'single');
  const v = validatePlan(plan, svc.effectiveCard(sc.card, ctx), TODAY, clock, [], ctx);
  assert.ok(v.ok, v.ok ? '' : v.errors.join('\n'));
  return v as Extract<typeof v, { ok: true }>;
}
const SKIP_RECIPE = { name: 'Рецепт дня', reason: REASON, cause: 'no_material' as const };
const placeholders = async () => (await pool.query(
  `SELECT plan_id::text AS plan_id, kind, status, error, series_name, resource_ref, format, topic, source_hints, scheduled_at
     FROM editor_slots WHERE channel_key = $1 AND error LIKE 'planner\\_%' ORDER BY scheduled_at`, [CH])).rows;
const activePlans = async () => (await pool.query(`SELECT id::text AS id FROM editor_plans WHERE channel_key = $1 AND status = 'active'`, [CH])).rows;
const wipe = async () => {
  await pool.query(`DELETE FROM series_pauses WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_slots WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = $1`, [CH]);
  clock = NOW;
};

test('a skipped series and a short day are stored with the plan; a failing placeholder rolls the whole plan back', { skip }, async () => {
  await wipe();
  const { svc, plans } = service();
  const v = await validated(svc, { rationale: 'Рецептів немає, день порожній', slots: [], skipped_series: [SKIP_RECIPE], short_day: { cause: 'no_material', reason: REASON } });
  assert.equal(v.empty.length, 2);
  const planId = await plans.createPlan(CH, TODAY, 'pgt068t2 plan', null, v.slots, v.empty);

  const rows = await placeholders();
  assert.equal(rows.length, 2);
  for (const r of rows) assert.deepEqual([r.plan_id, r.kind, r.status], [planId, 'content', 'skipped']);
  const series = rows.find((r) => r.series_name === 'Рецепт дня')!;
  assert.deepEqual([series.error, series.resource_ref, series.format, series.topic, series.source_hints, new Date(series.scheduled_at).toISOString()],
    [`planner_no_material: ${REASON}`, null, 'photo', 'Порожній випуск: Рецепт дня', ['series:Рецепт дня'], '2030-01-15T17:00:00.000Z']);
  const day = rows.find((r) => !r.series_name)!;
  assert.deepEqual([day.error, day.resource_ref, day.format, day.source_hints, new Date(day.scheduled_at).toISOString()],
    [`planner_no_material: ${REASON}`, null, 'text', [], NOW.toISOString()]);
  // The breaker reads them as ordinary closed slots of their causes.
  for (const r of rows) assert.deepEqual(classifyClose({ status: r.status, error: r.error }), { k: 'cause', cause: 'no_material' });

  // Atomic: a placeholder the database refuses leaves the active plan as it was.
  const bad: EmptyDaySlot = { ...v.empty[0], scheduledAt: new Date('not a date') };
  await assert.rejects(plans.createPlan(CH, TODAY, 'pgt068t2 broken', null, [], [bad]));
  assert.deepEqual((await activePlans()).map((p) => p.id), [planId], 'the first plan is still the active one');
  assert.equal((await placeholders()).length, 2);
});

test('a replan replaces the future placeholders and keeps those whose time has passed: a short day and a replan 5 h later count once', { skip }, async () => {
  await wipe();
  const { svc, plans } = service();
  const declare = { rationale: 'Рецептів немає, день порожній', slots: [], skipped_series: [SKIP_RECIPE], short_day: { cause: 'no_material' as const, reason: REASON } };
  const first = await validated(svc, declare);
  await plans.createPlan(CH, TODAY, 'pgt068t2 first', null, first.slots, first.empty);

  // 13:00 Kyiv: the short day (08:00) is behind us, the 19:00 recipe is ahead. The planner declares the same again.
  clock = new Date(NOW.getTime() + 5 * HOUR);
  const second = await validated(svc, declare);
  assert.deepEqual(second.empty.map((e) => e.scheduledAt.toISOString()).sort(), ['2030-01-15T11:00:00.000Z', '2030-01-15T17:00:00.000Z'], 'the short day starts at the replan\'s now');
  const secondId = await plans.createPlan(CH, TODAY, 'pgt068t2 second', null, second.slots, second.empty);

  const live = (await placeholders()).filter((r) => r.error.startsWith('planner_'));
  assert.equal(live.length, 2, 'one series placeholder and one short day, not four');
  const shortDay = live.find((r) => !r.series_name)!;
  assert.equal(new Date(shortDay.scheduled_at).toISOString(), NOW.toISOString(), 'the first short-day record stays: its time has passed');
  assert.notEqual(shortDay.plan_id, secondId, 'it stayed on the superseded plan, not copied');
  const recipe = live.find((r) => r.series_name === 'Рецепт дня')!;
  assert.equal(recipe.plan_id, secondId, 'the future one was replaced by the new plan\'s');
  const superseded = (await pool.query(`SELECT count(*)::int AS n FROM editor_slots WHERE channel_key = $1 AND status = 'skipped' AND error = 'superseded by a new plan'`, [CH])).rows[0].n;
  assert.equal(superseded, 1, 'the old future recipe placeholder');

  // After 19:00 the breaker's window holds exactly two closes of the empty day.
  const closes = (await pausesRepo().closedSlots(new Date('2030-01-15T18:00:00Z'), CH)).map((s) => classifyClose(s));
  assert.equal(closes.filter((c) => c.k === 'cause').length, 2);
  assert.equal(closes.filter((c) => c.k === 'ignore').length, 1, 'the superseded one is not counted');

  // A third plan that plans the recipe instead of declaring it empty leaves no future placeholder for it.
  clock = new Date(NOW.getTime() + 6 * HOUR);
  const third = await validated(svc, { rationale: 'Знайшов рецепт, планую його', slots: [{ time: '19:00', format: 'photo', topic: 'Рецепт борщу з пампушками', source_hints: ['library:recipes'], series: 'Рецепт дня', is_experiment: false }] });
  assert.equal(third.empty.length, 0);
  await plans.createPlan(CH, TODAY, 'pgt068t2 third', null, third.slots, third.empty);
  const after = (await placeholders()).filter((r) => r.error.startsWith('planner_'));
  assert.deepEqual(after.map((r) => r.series_name), [null], 'only the past short-day record is left');
});

// Review fix R5: the executor (or the pre-flight) already closed the instance; the replan's declaration must not close it twice.
test('an instance the executor already skipped is not counted again when a replan declares the series empty', { skip }, async () => {
  await wipe();
  const { svc, plans } = service();
  const planned = await validated(svc, { rationale: 'Планую рецепт дня на вечір', slots: [
    { time: '19:00', format: 'photo', topic: 'Рецепт борщу з пампушками', source_hints: ['library:recipes'], series: 'Рецепт дня', is_experiment: false },
  ] });
  await plans.createPlan(CH, TODAY, 'pgt068t2 r5 first', null, planned.slots, planned.empty);

  // 21:00 Kyiv: the executor found nothing and skipped the 19:00 slot (agent skip, as the executor writes it).
  const slotId = (await pool.query(`SELECT id FROM editor_slots WHERE channel_key = $1 AND series_name = 'Рецепт дня'`, [CH])).rows[0].id;
  await pool.query(`UPDATE editor_slots SET status = 'skipped', error = $2 WHERE id = $1`, [slotId, 'skipped by agent: no_material: у бібліотеці немає непублікованих рецептів']);

  // 19:30 Kyiv: the planner replans and declares the same instance empty.
  clock = new Date('2030-01-15T17:30:00Z');
  const second = await validated(svc, { rationale: 'Рецептів немає, пропускаю серію', slots: [], skipped_series: [SKIP_RECIPE], short_day: { cause: 'no_material', reason: REASON } });
  const recipeDeclared = second.empty.filter((e) => e.seriesName === 'Рецепт дня');
  assert.equal(recipeDeclared.length, 1, 'the replan does declare the instance');
  await plans.createPlan(CH, TODAY, 'pgt068t2 r5 second', null, second.slots, second.empty);

  const rows = await placeholders();
  assert.equal(rows.filter((r) => r.series_name === 'Рецепт дня').length, 0, 'no second close for the instance the executor already skipped');
  assert.equal(rows.filter((r) => !r.series_name).length, 1, 'the short day is still written (a different record)');
  const closes = (await pausesRepo().closedSlots(new Date('2030-01-15T22:00:00Z'), CH)).map((x) => classifyClose(x));
  assert.equal(closes.filter((c) => c.k === 'cause' && c.cause === 'no_material').length, 2, 'the executor skip and the short day: two closes, not three');

  // The guard is not blind: a skip of another series, one that was superseded, one by the breaker and one 2 h away do not shield the declaration.
  await wipe();
  const first = await validated(svc, { rationale: 'Планую рецепт дня на вечір', slots: [
    { time: '19:00', format: 'photo', topic: 'Рецепт борщу з пампушками', source_hints: ['library:recipes'], series: 'Рецепт дня', is_experiment: false },
  ] });
  await plans.createPlan(CH, TODAY, 'pgt068t2 r5 third', null, first.slots, first.empty);
  const id2 = (await pool.query(`SELECT id FROM editor_slots WHERE channel_key = $1 AND series_name = 'Рецепт дня'`, [CH])).rows[0].id;
  for (const [error, shift] of [['superseded by a new plan', 0], ['series_paused: 3 пропуски поспіль', 0], ['skipped by agent: no_material: x', 150]] as const) {
    await pool.query(`UPDATE editor_slots SET status = 'skipped', error = $2, scheduled_at = '2030-01-15T17:00:00Z'::timestamptz + make_interval(mins => $3) WHERE id = $1`, [id2, error, shift]);
    const again = await validated(svc, { rationale: 'Рецептів немає, пропускаю серію', slots: [], skipped_series: [SKIP_RECIPE], short_day: { cause: 'no_material', reason: REASON } });
    await plans.createPlan(CH, TODAY, `pgt068t2 r5 ${error}`, null, again.slots, again.empty);
    assert.equal((await placeholders()).filter((r) => r.series_name === 'Рецепт дня' && r.status === 'skipped' && r.error.startsWith('planner_')).length, 1, `a close that does not count (${error}, +${shift} min) leaves the declaration`);
    await pool.query(`DELETE FROM editor_slots WHERE channel_key = $1 AND error LIKE 'planner\\_%'`, [CH]);
  }
});

test('three empty days pause the series; the planner\'s minimum, the network section and the silent-days minimum drop', { skip }, async () => {
  await wipe();
  const { svc, plans } = service();
  const sc = await scope(svc);
  // Before any pause the card's own minimum counts.
  assert.equal(await svc.minPerDay(sc.card, TODAY, NOW), 1);

  for (const day of ['2030-01-12', '2030-01-13', '2030-01-14']) {
    const e: EmptyDaySlot = {
      scheduledAt: new Date(`${day}T17:00:00Z`), resourceRef: null, format: 'photo', topic: 'Порожній випуск: Рецепт дня', sourceHints: ['series:Рецепт дня'],
      seriesName: 'Рецепт дня', error: emptyDayError('no_material', REASON),
    };
    await plans.createPlan(CH, day, 'pgt068t2 old day', null, [], [e]);
  }
  const repo = pausesRepo();
  const breaker = new SeriesBreaker({
    repo: Object.assign(Object.create(repo), {
      closedSlots: async (now: Date) => (await repo.closedSlots(now)).filter((s) => s.channelKey === CH),
      open: async () => (await repo.open()).filter((p) => p.channelKey === CH),
    }),
    inbox: new OwnerInbox(pool, async () => {}), threshold: () => 3, everyMs: 0,
  });
  assert.equal(await breaker.check(NOW), 1, 'three placeholders in a row are three dead releases');
  const open = await repo.open(CH);
  assert.deepEqual(open.map((p) => [p.key, p.cause, p.streak]), [['series:Рецепт дня', 'no_material', 3]]);
  assert.match(open[0].reason, /Бібліотека рецептів порожня/);

  // The planners: the paused series is not due, and the minimum loses its instance.
  const ctx = await svc.planContext(sc.card, sc.net, TODAY, NOW, 'single');
  assert.deepEqual(ctx.paused?.map((p) => p.name), ['Рецепт дня']);
  assert.equal(svc.effectiveCard(sc.card, ctx).postsPerDayMin, 0);
  assert.equal(svc.effectiveCard(sc.card, ctx).postsPerDayMax, 4);
  assert.equal(svc.effectiveNet(sc.net, ctx).playbook!.platforms[0].per_day.min, 0);
  const empty = validatePlan({ rationale: 'Серія на паузі, нічого не планую', slots: [] }, svc.effectiveCard(sc.card, ctx), TODAY, NOW, [], ctx);
  assert.equal(empty.ok, true, empty.ok ? '' : empty.errors.join('\n'));

  // Silent days: the lowered minimum is read from the schedule service (a paused channel is not a dark day).
  assert.equal(await svc.minPerDay(sc.card, TODAY, NOW), 0);
  const watch = new SilentDaysWatch({ pool, inbox: new OwnerInbox(pool, async () => {}), everyMs: 0, minPerDay: (c, d, n) => svc.minPerDay(c, d, n) });
  const loaded = await watch.load([sc.card], new Date('2030-01-15T16:00:00Z'));
  assert.equal(loaded.resources.find((r) => r.ref === TG)?.minPerDay, 0);
  const plain = await new SilentDaysWatch({ pool, inbox: new OwnerInbox(pool, async () => {}), everyMs: 0 }).load([sc.card], new Date('2030-01-15T16:00:00Z'));
  assert.equal(plain.resources.find((r) => r.ref === TG)?.minPerDay, 1, 'without the hook the card\'s minimum, as before');

  // Resumed: the minimum is back.
  await repo.resume(open[0].id, 'owner');
  assert.equal(await svc.minPerDay(sc.card, TODAY, NOW), 1);
});

test('a network plan stores a short day per resource (the anchor without resource_ref); a replan inside the same local day adds none', { skip }, async () => {
  await wipe();
  const { plans } = service();
  const IG = 'instagram:pgt068t2';
  const mk = (resourceRef: string | null, tz: string) => shortDayPlaceholder({ resourceRef, tz, planDate: TODAY, now: clock, cause: 'no_material', reason: REASON });
  const planId = await plans.createNetworkPlan(CH, TODAY, 'pgt068t2 net', null, [], [], null, [mk(null, 'Europe/Kyiv'), mk(IG, 'America/New_York')]);
  const rows = await placeholders();
  assert.deepEqual(rows.map((r) => [r.plan_id, r.resource_ref, r.status]).sort(), [[planId, IG, 'skipped'], [planId, null, 'skipped']].sort());

  clock = new Date(NOW.getTime() + 2 * HOUR);
  await plans.createNetworkPlan(CH, TODAY, 'pgt068t2 net again', null, [], [], null, [mk(null, 'Europe/Kyiv'), mk(IG, 'America/New_York')]);
  assert.equal((await placeholders()).length, 2, 'the same declaration is one close');

  // The next local day is a new declaration.
  const tomorrow = shortDayPlaceholder({ resourceRef: IG, tz: 'America/New_York', planDate: '2030-01-16', now: clock, cause: 'source_unreachable', reason: REASON });
  await plans.createNetworkPlan(CH, '2030-01-16', 'pgt068t2 net tomorrow', null, [], [], null, [tomorrow]);
  assert.equal((await placeholders()).length, 3);
});
