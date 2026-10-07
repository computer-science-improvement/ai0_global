/**
 * Spec 023 T4 against a throwaway Postgres with every migration applied (059 included): pins are
 * materialised once per (rule, date) and survive a replan; a series slot gets series_name; a changed pin
 * moves its future slot; the live executor refuses a slot inside a blackout and a post that ignores a
 * `required` series source; an exhausted required source skips by code with one `series_source_empty`
 * Inbox item. Skipped unless EDITOR_PG_TEST_URL is set.
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
import { checkPublishGuards } from '../tools/role-tools';
import { makeCard, makeSpec } from '../post/testing/fixtures';
import { ScheduleRepository } from './schedule.repository';
import { isFail, ScheduleService } from './schedule.service';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@pgt023t4_food';
const TG = `telegram:${CH}`;
const HANDLE = 'pgt023t4_chef';
// A fixed future morning (08:00 Kyiv) so nothing depends on when the tests run.
const NOW = new Date('2030-01-15T06:00:00Z');
const TODAY = '2030-01-15';
let pool: Pool;
let agentId: string;
let unposted: number | null = 5;

const BODY = PlaybookSchema.parse({
  platforms: [{ resource_ref: TG, role: 'core', formats: { photo: 1, text: 0.5 }, per_day: { min: 1, max: 4 } }],
  series: [{
    name: 'Рецепт дня', cadence: 'daily@19:00', resource_ref: TG, format: 'photo', brief: 'Рецепт з бібліотеки щовечора',
    source: { kind: 'library', table: 'recipes' }, source_mode: 'required', origin: 'owner', locked: true,
  }],
});

async function cleanup() {
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
  await pool.query(`INSERT INTO editor_channels (channel_key, mode, formats, hashtags) VALUES ($1, 'live', '{"photo":1,"text":1}', '{космос}')`, [CH]);
  await new NetworkRepository(pool).insertPlaybook({ agentId, status: 'active', brief: null, body: BODY, rationale: 'seed', createdBy: 'owner' });
});

after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

function service(now = NOW) {
  const channels = new EditorChannelsRepository(pool);
  const plans = new EditorPlansRepository(pool);
  const svc = new ScheduleService({
    pool, rules: new ScheduleRepository(pool), network: new NetworkRepository(pool), agents: new AgentsRepository(pool),
    card: (k) => channels.get(k), plans, inbox: new OwnerInbox(pool, async () => {}),
    time: { tzOf: async () => 'Europe/Kyiv', quietOf: async () => ({ start: 23, end: 8 }) },
    sourceCatalog: (card) => seriesSourceCatalog(pool, card),
    unposted: async () => unposted,
    now: () => now,
  });
  return { svc, plans, channels };
}

async function scope(svc: ScheduleService) {
  const sc = await svc.scopeByHandle(HANDLE);
  assert.ok(!isFail(sc), JSON.stringify(sc));
  return sc as Exclude<typeof sc, { error: string }>;
}

const pinSlots = async () => (await pool.query(
  `SELECT id, scheduled_at, rule_date::text AS rule_date, plan_id, status, series_name, format FROM editor_slots WHERE channel_key = $1 AND schedule_rule_id IS NOT NULL ORDER BY scheduled_at`, [CH])).rows;

test('a pin is materialised once per date (today and tomorrow), survives a replan, and a series slot gets series_name', { skip }, async () => {
  const { svc, plans, channels } = service();
  const sc = await scope(svc);
  const r: any = await svc.addRule(sc, { resource_ref: TG, kind: 'pin', at_local: '12:00', format: 'text', brief: 'Порада власника опівдні щодня' }, 'owner');
  assert.ok(!isFail(r), JSON.stringify(r));
  assert.equal((await pinSlots()).length, 2);
  // Idempotent: the scheduler sweep and a forced rerun add nothing.
  const card = (await channels.get(CH))!;
  assert.equal(await svc.materialiseChannel(card, NOW, true), 0);
  assert.equal(await svc.materialiseAgent({ id: agentId }, card, NOW), 0);
  const pins = await pinSlots();
  assert.deepEqual(pins.map((p) => p.rule_date), [TODAY, '2030-01-16']);
  assert.equal(new Date(pins[0].scheduled_at).toISOString(), '2030-01-15T10:00:00.000Z');

  // The planner's plan replaces the day's plan: the pin moves along, and the series slot is tagged.
  const planId = await plans.createPlan(CH, TODAY, 'план дня з серією', null, [
    { scheduledAt: new Date('2030-01-15T17:00:00Z'), format: 'photo', topic: 'Рецепт дня: борщ', angle: null, sourceHints: ['series:Рецепт дня', 'library:recipes'], isExperiment: false },
  ]);
  const after = await pinSlots();
  assert.equal(after.length, 2);
  assert.equal(after[0].plan_id, planId);
  assert.equal(after[0].status, 'planned');
  const { rows } = await pool.query(`SELECT series_name FROM editor_slots WHERE plan_id = $1 AND schedule_rule_id IS NULL`, [planId]);
  assert.deepEqual(rows.map((x) => x.series_name), ['Рецепт дня']);

  // The plan context sees the pin: it counts toward per_day and blocks a slot too close to it.
  const ctx = await svc.planContext(card, sc.net, TODAY, NOW, 'single');
  assert.equal(ctx.pins.length, 1);
  assert.equal(svc.effectiveCard(card, ctx).postsPerDayMax, card.postsPerDayMax - 1);

  // Moving the pin drops its future planned slots and materialises the new time.
  const moved: any = await svc.updateRule(sc, r.rule.id, { at_local: '13:30' });
  assert.ok(!isFail(moved), JSON.stringify(moved));
  const now2 = await pinSlots();
  assert.equal(now2.length, 2);
  assert.equal(new Date(now2[0].scheduled_at).toISOString(), '2030-01-15T11:30:00.000Z');
  const off: any = await svc.updateRule(sc, r.rule.id, { active: false });
  assert.equal(off.rule.active, false);
  assert.equal((await pinSlots()).length, 0);
});

test('live executor: a slot inside a blackout is refused; a post ignoring a required series source is refused', { skip }, async () => {
  const at = new Date('2030-01-15T17:00:00Z'); // 19:00 Kyiv
  const { svc, plans, channels } = service(at);
  const sc = await scope(svc);
  const b: any = await svc.addRule(sc, { resource_ref: TG, kind: 'blackout', at_local: '18:30', until_local: '20:00' }, 'owner');
  assert.ok(!isFail(b), JSON.stringify(b));
  const { rows } = await pool.query(`SELECT id FROM editor_slots WHERE channel_key = $1 AND series_name = 'Рецепт дня' AND status = 'planned'`, [CH]);
  const slot = await plans.claimSlot(rows[0].id);
  assert.ok(slot);
  const card = { ...makeCard({ channelKey: CH, mode: 'live', formats: { photo: 1, text: 1 } }) };
  const deps: any = { pool, plans, schedule: svc };
  const ctx: any = { runId: 'r', role: 'executor', channelKey: CH, slotId: slot!.id, extras: { card } };
  const inBlackout: any = await checkPublishGuards(deps, ctx, makeSpec({ origin: 'library', library_ref: 'data://recipes/1', source: undefined }), at);
  assert.equal(inBlackout.error, 'blackout_window');
  // Outside the blackout (shadow has no live checks): the required library source decides.
  const shadowCtx: any = { ...ctx, extras: { card: { ...card, mode: 'shadow' } } };
  const mismatch: any = await checkPublishGuards(deps, shadowCtx, makeSpec(), at);
  assert.equal(mismatch.error, 'series_source_mismatch');
  assert.match(mismatch.details, /library:recipes/);
  await svc.updateRule(sc, b.rule.id, { active: false });
  void channels;
});

test('an exhausted required source skips by code with one series_source_empty Inbox item', { skip }, async () => {
  const { svc } = service();
  const { rows } = await pool.query(`SELECT * FROM editor_slots WHERE channel_key = $1 AND series_name = 'Рецепт дня' LIMIT 1`, [CH]);
  const { rowToSlot } = await import('../repo/editor-plans.repository');
  const slot = rowToSlot(rows[0]);
  unposted = 3;
  const fine = await svc.executorContext(slot);
  assert.equal(fine.skip, undefined);
  assert.match(fine.note!, /Джерело серії обовʼязкове: library:recipes/);
  unposted = 0;
  const empty = await svc.executorContext(slot);
  assert.match(empty.skip!, /nothing left/);
  await svc.executorContext(slot);
  const inbox = await pool.query(`SELECT title FROM agent_inbox WHERE agent_id = $1 AND kind = 'series_source_empty'`, [agentId]);
  assert.equal(inbox.rows.length, 1);
  assert.match(inbox.rows[0].title, /Рецепт дня/);
  unposted = 5;
});
