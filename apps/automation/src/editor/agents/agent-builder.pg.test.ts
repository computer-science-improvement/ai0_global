/** @ai0 builder against a real throwaway Postgres (049/050). Skipped unless EDITOR_PG_TEST_URL is set. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { AgentsRepository } from './agents.repository';
import { AgentRegistrySync } from './agent-registry-sync';
import { ResourceCatalog } from './resource-catalog';
import { ResourceProfilesRepository } from './resource-profile';
import { AgentCreator } from './agent-creator';
import { PendingActionsRepository, PendingActionsService } from './pending-actions';
import { EditorChannelsRepository } from '../repo/editor-channels.repository';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@travel_builder_pg';
const REF = `telegram:${CH}`;
let pool: Pool;

async function cleanup() {
  await pool.query(`DELETE FROM pending_actions WHERE kind = 'create_agent' AND payload->>'resource_ref' = $1`, [REF]);
  await pool.query(`DELETE FROM agents WHERE scope_id = $1`, [REF]);
  await pool.query(`DELETE FROM agent_handle_aliases WHERE handle = 'nomad_pg'`);
  await pool.query(`DELETE FROM resource_profiles WHERE resource_ref = $1`, [REF]);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM tracked_channels WHERE channel_key = $1`, [CH]);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  await pool.query(
    `INSERT INTO tracked_channels (channel_key, username, title, is_mine, about, subs_count) VALUES ($1, 'travel_builder_pg', 'Мандри', true, 'Подорожі Україною', 1200)`, [CH]);
});
after(async () => {
  if (!url) return;
  await cleanup();
  await pool.end();
});

const PROFILE = {
  topic: 'Подорожі Україною: маршрути вихідного дня', audience: { who: 'мандрівники 25–45', region: 'Україна' },
  goals: ['growth', 'engagement'], taboo: ['політика'],
};

test('catalog → create card → apply → orchestrator, children, profile and a shadow card', { skip }, async () => {
  const agents = new AgentsRepository(pool);
  const channels = new EditorChannelsRepository(pool);
  const registry = new AgentRegistrySync({ agents, channels });
  const catalog = new ResourceCatalog({ pool, telegramAccess: async () => ({ state: 'ok', detail: 'test' }) });
  const profiles = new ResourceProfilesRepository(pool);
  const creator = new AgentCreator({ agents, registry, catalog, profiles, channels });

  const listed = (await catalog.list()).find((r) => r.ref === REF);
  assert.ok(listed, 'own channel is listed');
  assert.equal(listed!.agent, null, 'free resource');
  const insp = await catalog.inspect(REF);
  assert.ok(!('error' in insp));
  assert.equal((insp as any).about, 'Подорожі Україною');
  assert.equal((insp as any).access.state, 'ok');

  const actions = new PendingActionsService(new PendingActionsRepository(pool));
  actions.register('create_agent', async (p) => {
    const r = await creator.create(p);
    if ('error' in r) throw new Error(r.error);
    return { handle: r.agent.handle };
  });
  const payload = { resource_ref: REF, name: 'Номад', handle: 'nomad_pg', emoji: '🧭', profile: PROFILE, brief: 'TG — маршрути й поради.' };
  assert.ok(!('error' in await creator.validate(payload)));
  const card = await actions.propose({ chatId: null, kind: 'create_agent', payload, summary: 'Створити @nomad_pg' });
  const applied = await actions.apply(card.id);
  assert.equal(applied.status, 'applied', applied.error ?? '');

  const orch = await agents.getByHandle('nomad_pg');
  assert.ok(orch);
  assert.equal(orch!.mode, 'shadow');
  assert.ok(orch!.shadowUntil && orch!.shadowUntil.getTime() > Date.now() + 2 * 86_400_000);
  assert.equal((await agents.children(orch!.id)).length, 4);
  assert.equal((await profiles.get(REF))!.profile!.topic, PROFILE.topic);
  const c = await channels.get(CH);
  assert.equal(c!.mode, 'shadow');
  assert.equal(c!.brief, 'TG — маршрути й поради.');
  assert.deepEqual(c!.bannedTerms, ['політика']);

  // The hourly sync does not duplicate it; the catalog now shows the agent.
  assert.equal((await registry.run()).created, 0);
  assert.equal((await catalog.list()).find((r) => r.ref === REF)!.agent, 'nomad_pg');

  // A second card for the same resource is stale on apply.
  const again = await creator.validate({ ...payload, handle: 'nomad_pg_two' });
  assert.equal((again as any).error, 'resource_has_agent');
});
