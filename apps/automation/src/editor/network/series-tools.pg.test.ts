/**
 * Spec 023 T3 against a throwaway Postgres with every migration applied: the series tools through the real
 * NetworkRepository and OwnerInbox — a structural change is stored as pending_owner with an action card,
 * a 60-min shift in live becomes the active version at once, an owner edit (NetworkService.putPlaybook)
 * locks the series and the agent then gets series_locked. Skipped unless EDITOR_PG_TEST_URL is set.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { NetworkRepository } from './network.repository';
import { OwnerInbox } from '../agents/owner-inbox';
import { buildSeriesTools } from './series-tools';
import { NetworkService } from './network.service';
import { PlaybookSchema } from './playbook';
import { normalizePlaybook, seriesSourceCatalog } from './series-edit';
import type { NetworkCtx } from './network-context';
import type { ToolContext } from '../harness/tool';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@pgt023s_food';
const HANDLE = 'pgt023s_chef';
let pool: Pool;
let agentId: string;

async function cleanup() {
  await pool.query(`DELETE FROM agent_inbox WHERE agent_id IN (SELECT id FROM agents WHERE handle = $1)`, [HANDLE]).catch(() => {});
  await pool.query(`DELETE FROM agents WHERE handle = $1`, [HANDLE]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
}

const BODY = PlaybookSchema.parse({
  platforms: [{ resource_ref: `telegram:${CH}`, role: 'core', formats: { photo: 1, text: 0.5 }, per_day: { min: 1, max: 4 } }],
  series: [{ name: 'Рецепт дня', cadence: 'daily@19:00', resource_ref: `telegram:${CH}`, format: 'photo', brief: 'Рецепт з бібліотеки щовечора', source: { kind: 'library', table: 'recipes' } }],
});

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  agentId = (await pool.query(
    `INSERT INTO agents (kind, scope, scope_id, name, handle, mode) VALUES ('orchestrator', 'resource', $1, 'Chef', $2, 'live') RETURNING id`,
    [`telegram:${CH}`, HANDLE])).rows[0].id;
  await pool.query(`INSERT INTO editor_channels (channel_key, mode) VALUES ($1, 'live')`, [CH]);
  await new NetworkRepository(pool).insertPlaybook({ agentId, status: 'active', brief: null, body: BODY, rationale: 'seed', createdBy: 'owner' });
});

after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

async function setup() {
  const repo = new NetworkRepository(pool);
  const inbox = new OwnerInbox(pool as any, async () => {});
  const active = await repo.activePlaybook(agentId);
  const net: NetworkCtx = {
    orchestrator: { id: agentId, handle: HANDLE, mode: 'live' } as any, anchorKey: CH, groupId: null, groupName: null, mode: 'single',
    resources: [{ ref: `telegram:${CH}`, platform: 'telegram' }], playbook: active!.body, playbookVersion: active!.version, telegramFormats: ['photo', 'text'],
  };
  const card = { channelKey: CH, mode: 'live', timezone: 'Europe/Kyiv', quietStartHour: 23, quietEndHour: 8, sources: [] } as any;
  const tools = Object.fromEntries(buildSeriesTools({ repo, inbox, sourceCatalog: (c) => seriesSourceCatalog(pool, c) }).map((t) => [t.name, t]));
  const ctx: ToolContext = { runId: '6b1d1b0e-3f2a-4c55-9d8e-1a2b3c4d5e6f', role: 'orchestrator', channelKey: CH, extras: { network: net, card } };
  return { repo, tools, ctx };
}

test('a 60-min shift in live is the new active version; a new series waits as pending_owner with an action card', { skip }, async () => {
  const { repo, tools, ctx } = await setup();
  const r: any = await tools.update_series.execute({ name: 'Рецепт дня', patch: { cadence: 'daily@20:00' }, rationale: 'Вечірні пости після 20:00 мають +30 % переглядів' }, ctx);
  assert.equal(r.status, 'active', JSON.stringify(r));
  assert.equal(normalizePlaybook((await repo.activePlaybook(agentId))!.body).series[0].cadence, 'daily@20:00');

  const d: any = await tools.define_series.execute({
    name: 'Факт тижня', cadence: 'weekly:mon,thu@12:00', resource_ref: `telegram:${CH}`, format: 'text', brief: 'Цікавий факт про продукти',
    source: { kind: 'library', table: 'facts' }, rationale: 'Факти дають найбільше пересилань у мережі',
  }, ctx);
  assert.equal(d.status, 'pending_owner', JSON.stringify(d));
  const pending = await repo.pendingPlaybook(agentId);
  assert.ok(pending && normalizePlaybook(pending.body).series.some((s) => s.name === 'Факт тижня'));
  const { rows } = await pool.query(`SELECT kind, severity, ref_id FROM agent_inbox WHERE agent_id = $1 ORDER BY id`, [agentId]);
  assert.deepEqual(rows.map((x) => [x.kind, x.severity]), [['playbook_updated', 'info'], ['playbook_pending', 'action']]);
  assert.equal(rows[1].ref_id, pending!.id);
});

test('an owner edit locks the series; the agent then gets series_locked', { skip }, async () => {
  const svc = new NetworkService({
    pool, agents: { getByHandle: async () => ({ id: agentId, handle: HANDLE, kind: 'orchestrator', scope: 'resource', scopeId: `telegram:${CH}`, mode: 'live', parentId: null }), get: async () => null } as any,
    repo: new NetworkRepository(pool), inbox: { post: async () => 1 }, card: async () => ({ channelKey: CH, mode: 'live', formats: { photo: 1, text: 1 }, sources: [] } as any),
    rebuild: async () => {},
  });
  const active = normalizePlaybook((await new NetworkRepository(pool).activePlaybook(agentId))!.body);
  const edited = { ...active, series: active.series.map((s) => ({ ...s, cadence: 'weekly:mon,tue,wed,thu,fri@20:30' })) };
  const res = await svc.putPlaybook(HANDLE, { body: edited, rationale: 'Рецепти о 20:30 по буднях' });
  const s = normalizePlaybook(res.playbook.body).series[0];
  assert.deepEqual([s.cadence, s.locked, s.origin], ['weekly:mon,tue,wed,thu,fri@20:30', true, 'agent']);
  assert.equal(await new NetworkRepository(pool).pendingPlaybook(agentId), null, 'the owner version supersedes the agent draft');

  const { tools, ctx } = await setup();
  const r: any = await tools.update_series.execute({ name: 'Рецепт дня', patch: { cadence: 'weekly:mon,tue,wed,thu,fri@20:00' }, rationale: 'Повернути трохи раніший час для рецептів' }, ctx);
  assert.equal(r.error, 'series_locked');
});
