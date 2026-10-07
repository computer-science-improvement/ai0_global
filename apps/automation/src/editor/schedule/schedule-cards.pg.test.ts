/**
 * Spec 023 T5 against a throwaway Postgres: the chat cards end to end through the real PendingActionsService —
 * Apply of series_change writes an owner version with the series locked (and a second card for the same
 * series fails as stale), schedule_rule and slot_change cards apply once and fail when stale, Unlock hands
 * the series back, and the Schedule REST service projects series / rules / slots in each resource's zone.
 * Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { AgentsRepository } from '../agents/agents.repository';
import { OwnerInbox } from '../agents/owner-inbox';
import { PendingActionsRepository, PendingActionsService } from '../agents/pending-actions';
import { EditorChannelsRepository } from '../repo/editor-channels.repository';
import { EditorPlansRepository } from '../repo/editor-plans.repository';
import { NetworkRepository } from '../network/network.repository';
import { normalizePlaybook, seriesSourceCatalog } from '../network/series-edit';
import { PlaybookSchema } from '../network/playbook';
import { ScheduleRepository } from './schedule.repository';
import { isFail, ScheduleService } from './schedule.service';
import { buildScheduleTools, registerScheduleActions } from './schedule-tools';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@pgt023t5_food';
const TG = `telegram:${CH}`;
const HANDLE = 'pgt023t5_chef';
const NOW = new Date('2030-01-15T06:00:00Z'); // 08:00 Kyiv
let pool: Pool;
let agentId: string;

const BODY = PlaybookSchema.parse({
  platforms: [{ resource_ref: TG, role: 'core', formats: { photo: 1, text: 0.5 }, per_day: { min: 1, max: 4 } }],
  series: [{ name: 'Рецепт дня', cadence: 'daily@19:00', resource_ref: TG, format: 'photo', brief: 'Рецепт з бібліотеки щовечора', source: { kind: 'library', table: 'recipes' } }],
});

async function cleanup() {
  await pool.query(`DELETE FROM editor_slots WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM pending_actions WHERE agent_id IN (SELECT id FROM agents WHERE handle = $1)`, [HANDLE]).catch(() => {});
  await pool.query(`DELETE FROM agent_inbox WHERE agent_id IN (SELECT id FROM agents WHERE handle = $1)`, [HANDLE]).catch(() => {});
  await pool.query(`DELETE FROM agents WHERE handle = $1`, [HANDLE]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  agentId = (await pool.query(
    `INSERT INTO agents (kind, scope, scope_id, name, handle, mode) VALUES ('orchestrator', 'resource', $1, 'Chef', $2, 'approve') RETURNING id`,
    [TG, HANDLE])).rows[0].id;
  await pool.query(`INSERT INTO editor_channels (channel_key, mode, formats) VALUES ($1, 'approve', '{"photo":1,"text":1}')`, [CH]);
  await new NetworkRepository(pool).insertPlaybook({ agentId, status: 'active', brief: null, body: BODY, rationale: 'seed', createdBy: 'orchestrator' });
});

after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

function setup(ownerText: string) {
  const channels = new EditorChannelsRepository(pool);
  const agents = new AgentsRepository(pool);
  const svc = new ScheduleService({
    pool, rules: new ScheduleRepository(pool), network: new NetworkRepository(pool), agents,
    card: (k) => channels.get(k), plans: new EditorPlansRepository(pool), inbox: new OwnerInbox(pool, async () => {}),
    time: { tzOf: async () => 'Europe/Kyiv', quietOf: async () => ({ start: 23, end: 8 }) },
    sourceCatalog: (card) => seriesSourceCatalog(pool, card), now: () => NOW,
  });
  const actions = new PendingActionsService(new PendingActionsRepository(pool));
  registerScheduleActions(actions, svc);
  const tools = Object.fromEntries(buildScheduleTools({ schedule: svc, actions, now: () => NOW }).map((t) => [t.name, t]));
  const ctx = async (): Promise<any> => ({
    runId: 'r', role: 'composer', channelKey: null,
    extras: { chat: { chatId: null, channelKey: null }, agentIntent: false, ownerText, agent: await agents.get(agentId) },
  });
  return { svc, actions, tools, ctx };
}

const activeSeries = async () => normalizePlaybook((await new NetworkRepository(pool).activePlaybook(agentId))!.body).series;

test('series_change: "рецепти о 20:30 по буднях" → a card; Apply writes a locked owner version; a second card for the series is stale', { skip }, async () => {
  const { actions, tools, ctx } = setup('рецепти о 20:30 по буднях');
  const a: any = await tools.propose_series_change.execute({ op: 'update', series: { name: 'Рецепт дня', cadence: 'weekly:mon,tue,wed,thu,fri@20:30' } }, await ctx());
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(a.summary, `Series change for @${HANDLE}: "Рецепт дня": every day 19:00 → weekdays 20:30`);
  const b: any = await tools.propose_series_change.execute({ op: 'pause', series: { name: 'Рецепт дня' } }, await ctx());
  assert.equal(b.ok, true);
  const applied = await actions.apply(a.pending_action);
  assert.equal(applied.status, 'applied', applied.error ?? '');
  const s = (await activeSeries()).find((x) => x.name === 'Рецепт дня')!;
  assert.deepEqual([s.cadence, s.locked, s.origin], ['weekly:mon,tue,wed,thu,fri@20:30', true, 'agent']);
  const row = await new NetworkRepository(pool).activePlaybook(agentId);
  assert.equal(row!.createdBy, 'owner');
  const stale = await actions.apply(b.pending_action);
  assert.equal(stale.status, 'failed');
  assert.match(stale.error!, /stale/);
  // An invalid change is refused at propose time.
  const bad: any = await tools.propose_series_change.execute({ op: 'update', series: { name: 'Рецепт дня', format: 'video' } }, await ctx());
  assert.equal(bad.error, 'series_invalid');
});

test('Unlock hands the series back; get_schedule shows origin and lock; the REST projection is in the resource zone', { skip }, async () => {
  const { svc, tools, ctx } = setup('покажи розклад');
  const sc: any = await svc.scopeByHandle(HANDLE);
  const got: any = await tools.get_schedule.execute({ days: 7 }, await ctx());
  assert.deepEqual(got.series.map((s: any) => [s.name, s.locked, s.origin]), [['Рецепт дня', true, 'agent']]);
  const u: any = await svc.unlockSeries(sc, 'Рецепт дня');
  assert.equal(u.ok, true);
  assert.equal((await activeSeries())[0].locked, false);
  assert.equal(((await svc.unlockSeries(sc, 'Рецепт дня')) as any).error, 'not_locked');
  const put: any = await svc.putSeries(sc, 'Порада', { cadence: 'daily@12:00', resource_ref: TG, format: 'text', brief: 'Коротка кухонна порада опівдні' });
  assert.equal(put.ok, true, JSON.stringify(put));
  const view = await svc.schedule(sc, { from: '2030-01-15', to: '2030-01-21' });
  assert.equal(view.days.length, 7);
  const tips = view.items.filter((i) => i.kind === 'series' && i.name === 'Порада');
  assert.equal(tips.length, 7);
  assert.equal((tips[0] as any).at, '2030-01-15T10:00:00.000Z');
  assert.equal(view.items.filter((i) => i.kind === 'series' && i.name === 'Рецепт дня').length, 5); // weekdays only
  assert.equal(view.resources[0].timezone, 'Europe/Kyiv');
  const unknown: any = await svc.putSeries(sc, 'Чуже', { cadence: 'daily@12:00', resource_ref: 'instagram:nope', format: 'text', brief: 'Серія на чужому ресурсі' });
  assert.ok(isFail(unknown));
});

test('schedule_rule cards: add applies as created_by chat; of two cards for one rule the second is stale', { skip }, async () => {
  const { svc, actions, tools, ctx } = setup('не публікуй з 13:00 до 15:00 по буднях');
  const add: any = await tools.propose_schedule_rule.execute({ op: 'add', rule: { resource_ref: TG, kind: 'blackout', at_local: '13:00', until_local: '15:00', days: [1, 2, 3, 4, 5] } }, await ctx());
  assert.equal(add.ok, true, JSON.stringify(add));
  assert.equal(add.summary, `Add rule on ${TG}: Blackout 13:00–15:00 weekdays`);
  const done = await actions.apply(add.pending_action);
  assert.equal(done.status, 'applied', done.error ?? '');
  const id = (done.result as any).rule;
  const { rows } = await pool.query(`SELECT created_by, active FROM schedule_rules WHERE id = $1`, [id]);
  assert.deepEqual(rows[0], { created_by: 'chat', active: true });
  const upd: any = await tools.propose_schedule_rule.execute({ op: 'update', rule_id: id, rule: { until_local: '16:00' } }, await ctx());
  const dis: any = await tools.propose_schedule_rule.execute({ op: 'disable', rule_id: id }, await ctx());
  assert.match(dis.summary, /^Disable rule/);
  assert.equal((await actions.apply(dis.pending_action)).status, 'applied');
  const stale = await actions.apply(upd.pending_action);
  assert.equal(stale.status, 'failed');
  assert.match(stale.error!, /stale/);
  const invalid: any = await tools.propose_schedule_rule.execute({ op: 'add', rule: { resource_ref: 'instagram:nope', kind: 'blackout', at_local: '13:00', until_local: '15:00' } }, await ctx());
  assert.equal(invalid.error, 'rule_invalid');
  void svc;
});

test('slot_change cards: only planned content slots within 48 h; skip applies; a move after it is stale', { skip }, async () => {
  const plans = new EditorPlansRepository(pool);
  await plans.createPlan(CH, '2030-01-15', 'план дня', null, [
    { scheduledAt: new Date('2030-01-15T09:00:00Z'), format: 'photo', topic: 'Сніданок дня', angle: null, sourceHints: [], isExperiment: false },
    { scheduledAt: new Date('2030-01-18T09:00:00Z'), format: 'photo', topic: 'Далекий слот', angle: null, sourceHints: [], isExperiment: false },
  ]);
  const { rows } = await pool.query(`SELECT id, topic FROM editor_slots WHERE channel_key = $1 AND kind = 'content' ORDER BY scheduled_at`, [CH]);
  const { actions, tools, ctx } = setup('перенеси сніданок на 12:30, а потім пропусти його');
  const move: any = await tools.propose_slot_change.execute({ slot_id: rows[0].id, op: 'move', to_local: '12:30' }, await ctx());
  assert.equal(move.ok, true, JSON.stringify(move));
  assert.match(move.summary, /^Move "Сніданок дня" on telegram:@pgt023t5_food: Tue 15 Jan 11:00 → Tue 15 Jan 12:30 \(Europe\/Kyiv\)/);
  const skipCard: any = await tools.propose_slot_change.execute({ slot_id: rows[0].id, op: 'skip' }, await ctx());
  const skipped = await actions.apply(skipCard.pending_action);
  assert.equal(skipped.status, 'applied', skipped.error ?? '');
  assert.equal((await plans.getSlot(rows[0].id))!.status, 'skipped');
  const stale = await actions.apply(move.pending_action);
  assert.equal(stale.status, 'failed');
  assert.match(stale.error!, /stale/);
  const far: any = await tools.propose_slot_change.execute({ slot_id: rows[1].id, op: 'skip' }, await ctx());
  assert.equal(far.error, 'slot_too_far');
});
