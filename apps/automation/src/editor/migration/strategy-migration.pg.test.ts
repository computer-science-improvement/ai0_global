/**
 * Spec 023 T6 against a throwaway Postgres: the dry run writes nothing; the migrate card writes a pending
 * migration draft (a changed binding makes the card stale); after the owner approves it and the series ran a
 * week in shadow the cutover is offered; the cutover is one transaction (card + agent → approve, the taken-over
 * bindings retired, config:changed) and is refused while EDITOR_ENABLED≠true; the live guard answers 409 with
 * the ext_ids while a binding is still enabled; a retired binding cannot be re-enabled (409 binding_retired and
 * the DB check); the rollback card restores the bindings and puts the agent back to shadow.
 * Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { AgentsRepository } from '../agents/agents.repository';
import { AgentsService } from '../agents/agents.service';
import { OwnerInbox } from '../agents/owner-inbox';
import { PendingActionsRepository, PendingActionsService } from '../agents/pending-actions';
import { SkillStore } from '../agents/skill-store';
import { EditorChannelsRepository } from '../repo/editor-channels.repository';
import { NetworkRepository } from '../network/network.repository';
import { PlaybookSchema } from '../network/playbook';
import { normalizePlaybook, seriesSourceCatalog } from '../network/series-edit';
import { zonedToUtc } from '../roles/time';
import { shiftDate } from '../schedule/schedule-rules';
import { StrategyBindingsRepository } from '../../config/strategy-bindings.repository';
import { StrategiesController } from '../../config/api/strategies.controller';
import { isFail, StrategyMigrationService } from './strategy-migration.service';
import { migrationCard, offerCutovers, registerMigrationActions } from './migration-actions';
import { dryRun } from './dry-run';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@pgt023t6_food';
const TG = `telegram:${CH}`;
const HANDLE = 'pgt023t6_chef';
const NOW = new Date('2030-03-12T10:00:00Z'); // 12:00 Kyiv (UTC+2)
let pool: Pool;
let agentId: string;
let channelId: string;
let enabled = true;
const published: string[] = [];

async function cleanup() {
  await pool.query(`DELETE FROM strategy_bindings WHERE ext_id LIKE '%:pgt6'`);
  await pool.query(`DELETE FROM editor_slots WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM editor_plans WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM pending_actions WHERE agent_id IN (SELECT id FROM agents WHERE handle = $1)`, [HANDLE]).catch(() => {});
  await pool.query(`DELETE FROM agent_inbox WHERE agent_id IN (SELECT id FROM agents WHERE handle = $1)`, [HANDLE]).catch(() => {});
  await pool.query(`DELETE FROM playbooks WHERE agent_id IN (SELECT id FROM agents WHERE handle = $1)`, [HANDLE]);
  await pool.query(`DELETE FROM agents WHERE handle = $1`, [HANDLE]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM tracked_channels WHERE channel_key = $1`, [CH]);
}

const binding = (ext: string, type: string, schedule: string, on = true) => pool.query(
  `INSERT INTO strategy_bindings (ext_id, type, channel_id, schedule, params, enabled) VALUES ($1, $2, $3, $4, '{}', $5) RETURNING id`,
  [ext, type, channelId, schedule, on]);

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  channelId = (await pool.query(`INSERT INTO tracked_channels (channel_key, title, is_mine) VALUES ($1, 'Food', true) RETURNING id`, [CH])).rows[0].id;
  agentId = (await pool.query(
    `INSERT INTO agents (kind, scope, scope_id, name, handle, mode) VALUES ('orchestrator', 'resource', $1, 'Chef', $2, 'shadow') RETURNING id`,
    [TG, HANDLE])).rows[0].id;
  await pool.query(`INSERT INTO editor_channels (channel_key, mode, formats, quiet_start_hour, quiet_end_hour, timezone) VALUES ($1, 'shadow', '{"photo":1,"text":1,"quiz":1}', 23, 8, 'Europe/Kyiv')`, [CH]);
  await new NetworkRepository(pool).insertPlaybook({
    agentId, status: 'active', brief: null, rationale: 'seed', createdBy: 'orchestrator',
    body: PlaybookSchema.parse({ platforms: [{ resource_ref: TG, role: 'core', formats: { photo: 1, text: 0.5 }, per_day: { min: 1, max: 3 } }] }),
  });
  await binding('recipes:pgt6', 'recipes', '0 19 * * *');             // → series daily@19:00
  await binding('quotes:pgt6', 'quotes', '*/30 8-22 * * *');           // → frequency hint
  await binding('pdr-quiz:pgt6', 'pdr-quiz', '0 9 1 * *');             // → unmappable (day of month), stays enabled
  await binding('facts:pgt6', 'facts', '0 10 * * *', false);           // disabled: not migrated
});

after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

function setup(now: Date = NOW) {
  const channels = new EditorChannelsRepository(pool);
  const svc = new StrategyMigrationService({
    pool, agents: new AgentsRepository(pool), network: new NetworkRepository(pool), card: (k) => channels.get(k),
    inbox: new OwnerInbox(pool, async () => {}), sourceCatalog: (card) => seriesSourceCatalog(pool, card),
    time: { tzOf: async () => 'Europe/Kyiv', quietOf: async () => ({ start: 23, end: 8 }) },
    publishConfig: async () => { published.push('strategy'); }, editorEnabled: () => enabled, cronTz: 'Europe/Kyiv', now: () => now,
  });
  // Cards are stamped by the DB clock: the TTL check uses the real time.
  const actions = new PendingActionsService(new PendingActionsRepository(pool));
  registerMigrationActions(actions, svc);
  return { svc, actions, channels };
}

const counts = async () => (await pool.query(
  `SELECT (SELECT count(*) FROM playbooks) AS p, (SELECT count(*) FROM pending_actions) AS a, (SELECT count(*) FROM agent_inbox) AS i,
          (SELECT string_agg(ext_id || enabled::text || COALESCE(retired_at::text, '-'), ',' ORDER BY ext_id) FROM strategy_bindings) AS b`)).rows[0];
const bindingRow = async (ext: string) => (await pool.query(`SELECT enabled, retired_at, retired_reason, migrated_to FROM strategy_bindings WHERE ext_id = $1`, [ext])).rows[0];
const propose = async (actions: PendingActionsService, svc: StrategyMigrationService, op: 'migrate' | 'cutover' | 'rollback') => {
  const c = await migrationCard(svc, op, CH);
  assert.ok(!isFail(c), JSON.stringify(c));
  if (isFail(c)) throw new Error('unreachable');
  return actions.propose({ chatId: null, agentId: c.agentId, kind: c.kind, payload: c.payload, summary: c.summary });
};

test('T6 end to end: dry run → migrate card → approve → shadow → cutover → live guard → rollback', { skip }, async () => {
  const { svc, actions, channels } = setup();

  // 1. The dry run maps 2 of 3 enabled bindings and writes nothing.
  const before = await counts();
  const p = await svc.propose(CH);
  assert.ok(!isFail(p));
  if (isFail(p)) return;
  assert.deepEqual(p.bindings.map((b) => [b.ext_id, b.outcome]), [['pdr-quiz:pgt6', 'unmappable'], ['quotes:pgt6', 'frequency'], ['recipes:pgt6', 'series']]);
  assert.equal((p.bindings[2] as any).cadence, 'daily@19:00');
  const all = await dryRun(svc, pool, { channel: CH });
  assert.equal(all.mapped, 2);
  assert.equal(all.total, 3);
  assert.deepEqual(await counts(), before, 'the dry run wrote nothing');

  // 2. The migrate card: a stale card fails, a fresh one writes the pending migration draft.
  const stale = await propose(actions, svc, 'migrate');
  await pool.query(`UPDATE strategy_bindings SET schedule = '0 20 * * *' WHERE ext_id = 'recipes:pgt6'`);
  const s = await actions.apply(stale.id);
  assert.equal(s.status, 'failed');
  assert.match(s.error ?? '', /^stale/);
  const card = await propose(actions, svc, 'migrate');
  assert.match(card.summary, /Migrate 2 of 3 strategy binding\(s\) on @pgt023t6_food to @pgt023t6_chef/);
  const applied = await actions.apply(card.id);
  assert.equal(applied.status, 'applied', applied.error ?? '');
  const net = new NetworkRepository(pool);
  const pending = await net.pendingPlaybook(agentId);
  assert.equal(pending?.createdBy, 'migration');
  const draft = normalizePlaybook(pending!.body);
  assert.deepEqual(draft.series.map((x) => [x.name, x.cadence, x.origin, x.locked, x.migrated_from]), [['recipes:pgt6', 'daily@20:00', 'migration', false, 'recipes:pgt6']]);
  assert.ok(draft.rules.some((r) => r.startsWith('Замість стратегії quotes:pgt6 (quotes)')));
  assert.match(pending!.rationale ?? '', /Unmappable \(left as they are\):\n- pdr-quiz:pgt6 \(pdr-quiz, 0 9 1 \* \*\): day of month/);
  assert.equal((await bindingRow('recipes:pgt6')).enabled, true, 'the bindings keep publishing in shadow');
  assert.equal((await svc.status()).find((r) => r.channel_key === CH)?.state, 'draft_pending');

  // 3. Approved; the cutover is not offered before a week of shadow.
  await net.decidePlaybook(pending!.id, true);
  const early = await svc.cutoverOffer(CH);
  assert.ok(isFail(early) && early.error === 'cutover_not_ready', JSON.stringify(early));

  // 4. Eight days of shadowed series instances at 20:00 Kyiv → ready (7 of 7 in the window).
  for (let i = 8; i >= 1; i--) {
    const day = shiftDate('2030-03-12', -i);
    const plan = (await pool.query(`INSERT INTO editor_plans (channel_key, plan_date) VALUES ($1, $2) RETURNING id`, [CH, day])).rows[0].id;
    await pool.query(
      `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, status, series_name) VALUES ($1, $2, $3, 'photo', 'Рецепт', 'shadowed', 'recipes:pgt6')`,
      [plan, CH, zonedToUtc(day, '20:00', 'Europe/Kyiv')]);
  }
  const offer = await svc.cutoverOffer(CH);
  assert.ok(!isFail(offer), JSON.stringify(offer));
  if (isFail(offer)) return;
  assert.deepEqual(offer.extIds.sort(), ['quotes:pgt6', 'recipes:pgt6']);
  assert.equal(offer.stats.expected, 7);
  assert.equal(offer.stats.ratio, 1);
  assert.equal((await svc.status()).find((r) => r.channel_key === CH)?.state, 'cutover_ready');

  // The daily offer files one chatless card (and one Inbox item), never twice.
  assert.equal(await offerCutovers({ svc, actions, inbox: new OwnerInbox(pool, async () => {}), pool }), 1);
  assert.equal(await offerCutovers({ svc, actions, inbox: new OwnerInbox(pool, async () => {}), pool }), 0);
  const offered = (await pool.query(`SELECT id FROM pending_actions WHERE kind = 'strategy_cutover' AND status = 'pending' AND payload->>'channel_key' = $1`, [CH])).rows;
  assert.equal(offered.length, 1);

  // 5. Refused while EDITOR_ENABLED≠true: nothing changes.
  enabled = false;
  const off = await actions.apply(offered[0].id);
  assert.equal(off.status, 'failed');
  assert.match(off.error ?? '', /^editor_disabled/);
  assert.equal((await bindingRow('recipes:pgt6')).enabled, true);
  enabled = true;

  // 6. The cutover: one transaction, card + agent → approve, two bindings retired, config:changed once.
  const cut = await propose(actions, svc, 'cutover');
  published.length = 0;
  const done = await actions.apply(cut.id);
  assert.equal(done.status, 'applied', done.error ?? '');
  assert.deepEqual(done.result, { mode: 'approve', retired: ['quotes:pgt6', 'recipes:pgt6'] });
  assert.equal((await channels.get(CH))?.mode, 'approve');
  assert.equal((await new AgentsRepository(pool).get(agentId))?.mode, 'approve');
  for (const ext of ['recipes:pgt6', 'quotes:pgt6']) {
    const r = await bindingRow(ext);
    assert.equal(r.enabled, false);
    assert.ok(r.retired_at);
    assert.equal(r.retired_reason, 'migrated');
    assert.equal(r.migrated_to.agent_id, agentId);
  }
  assert.deepEqual((await bindingRow('recipes:pgt6')).migrated_to.series, ['recipes:pgt6']);
  assert.equal((await bindingRow('pdr-quiz:pgt6')).enabled, true, 'the unmappable binding is left alone');
  assert.deepEqual(published, ['strategy']);
  const audit = (await pool.query(`SELECT text FROM editor_channel_memory WHERE channel_key = $1 AND evidence->>'audit' = 'mode_change'`, [CH])).rows;
  assert.ok(audit.some((a) => a.text === 'mode changed shadow→approve by strategy cutover'));

  // 7. The live guard: 409 bindings_still_enabled listing the ext_ids (card upsert and agent PATCH).
  const card0 = (await channels.get(CH))!;
  await assert.rejects(() => channels.upsert({ ...card0, mode: 'live' }), (err: any) => {
    assert.equal(err.getStatus(), 409);
    assert.deepEqual(err.getResponse().ext_ids, ['pdr-quiz:pgt6']);
    assert.equal(err.getResponse().error, 'bindings_still_enabled');
    return true;
  });
  assert.equal((await channels.get(CH))?.mode, 'approve', 'the refused switch changed nothing');
  const agentsSvc = new AgentsService({
    pool, agents: new AgentsRepository(pool), skills: new SkillStore(pool), inbox: new OwnerInbox(pool, async () => {}),
    setChannelMode: async (key, mode) => channels.upsert({ ...(await channels.get(key))!, mode }),
    runNow: async () => ({ started: false, what: '' }), memory: async () => [],
  });
  await assert.rejects(() => agentsSvc.patch(HANDLE, { mode: 'live' }), (err: any) => err.getStatus() === 409 && err.getResponse().ext_ids.join() === 'pdr-quiz:pgt6');

  // 8. A retired binding cannot be re-enabled: 409 binding_retired, and the DB check.
  const ctl = new StrategiesController(new StrategyBindingsRepository(pool), {} as any, {} as any, { getChannelById: () => ({}) } as any,
    { publish: async () => {} } as any, {} as any, {} as any, {} as any, { supportedPlatforms: () => ['telegram'] } as any, {} as any);
  const rid = (await pool.query(`SELECT id FROM strategy_bindings WHERE ext_id = 'recipes:pgt6'`)).rows[0].id;
  await assert.rejects(() => ctl.patch(rid, { enabled: true } as any), (err: any) => err.getStatus() === 409 && err.getResponse().error === 'binding_retired');
  await assert.rejects(() => pool.query(`UPDATE strategy_bindings SET enabled = true WHERE ext_id = 'recipes:pgt6'`), /strategy_bindings_retired_chk/);

  // Pausing the last binding unblocks live.
  await pool.query(`UPDATE strategy_bindings SET enabled = false WHERE ext_id = 'pdr-quiz:pgt6'`);
  await agentsSvc.patch(HANDLE, { mode: 'live' });
  assert.equal((await channels.get(CH))?.mode, 'live');
  assert.equal((await svc.status()).find((r) => r.channel_key === CH)?.state, 'retired');

  // 9. The rollback card: the migrated bindings come back, the agent and its card go to shadow.
  const rb = await propose(actions, svc, 'rollback');
  const back = await actions.apply(rb.id);
  assert.equal(back.status, 'applied', back.error ?? '');
  assert.deepEqual((back.result as any).restored.sort(), ['quotes:pgt6', 'recipes:pgt6']);
  for (const ext of ['recipes:pgt6', 'quotes:pgt6']) {
    const r = await bindingRow(ext);
    assert.deepEqual([r.enabled, r.retired_at, r.retired_reason, r.migrated_to], [true, null, null, null]);
  }
  assert.equal((await channels.get(CH))?.mode, 'shadow');
  assert.equal((await new AgentsRepository(pool).get(agentId))?.mode, 'shadow');
  // A second rollback has nothing to restore.
  const again = await migrationCard(svc, 'rollback', CH);
  assert.ok(!isFail(again));
  if (!isFail(again)) {
    const a2 = await actions.propose({ chatId: null, agentId: again.agentId, kind: again.kind, payload: again.payload, summary: again.summary });
    const r2 = await actions.apply(a2.id);
    assert.match(r2.error ?? '', /^nothing_to_restore/);
  }
});

test('no agent on the channel → no_agent (the proposal is refused)', { skip }, async () => {
  const { svc } = setup();
  const r = await svc.propose('@pgt023t6_nobody');
  assert.ok(isFail(r) && r.error === 'no_agent');
});
