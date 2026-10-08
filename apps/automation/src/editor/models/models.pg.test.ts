/**
 * Spec 035 on a throwaway Postgres: the global default in app_settings, the
 * bulk actions over the agents table, clearing a channel card's legacy
 * `models`, and the llm_prices upsert of a newly chosen model. The catalog is a
 * FAKE (never OpenRouter). Skipped unless EDITOR_PG_TEST_URL is set. Never
 * point this at a real database. Agent models changed here are restored.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { AgentsRepository } from '../agents/agents.repository';
import { ModelDefaultsStore, DEFAULT_MODEL_KEY } from '../llm/model-defaults';
import { ModelsService, fallbackCatalog } from './models.service';
import type { CatalogSnapshot } from './model-catalog';
import { LlmPricesRepository } from '../../common/ai/usage/llm-prices.repository';
import { PriceService } from '../../common/ai/usage/price.service';
import { EditorChannelsRepository } from '../repo/editor-channels.repository';
import { makeDefaultCard } from '../chat/default-card';
import { SettingsService } from '../../settings/settings.service';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const CH = '@models035_pg';
const NEW_MODEL = 'test035/brand-new-model';
let pool: Pool;
let savedModels: Array<{ id: string; model: string | null }> = [];
let savedDefault: string | null = null;

async function cleanup() {
  await pool.query(`DELETE FROM agents WHERE handle LIKE 'm035\\_%'`);
  await pool.query(`DELETE FROM editor_channels WHERE channel_key = $1`, [CH]);
  await pool.query(`DELETE FROM llm_prices WHERE model LIKE 'test035/%'`);
}

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  await cleanup();
  savedModels = (await pool.query(`SELECT id, model FROM agents`)).rows;
  savedDefault = (await pool.query(`SELECT value FROM app_settings WHERE key = $1`, [DEFAULT_MODEL_KEY])).rows[0]?.value ?? null;
});
after(async () => {
  if (!url) return;
  for (const r of savedModels) await pool.query(`UPDATE agents SET model = $2 WHERE id = $1`, [r.id, r.model]);
  if (savedDefault) await pool.query(`UPDATE app_settings SET value = $2 WHERE key = $1`, [DEFAULT_MODEL_KEY, savedDefault]);
  else await pool.query(`DELETE FROM app_settings WHERE key = $1`, [DEFAULT_MODEL_KEY]);
  await cleanup();
  await pool.end();
});

function service(defaults: ModelDefaultsStore, prices: PriceService) {
  const catalog = {
    list: async (): Promise<CatalogSnapshot> => ({
      models: [
        { id: 'z-ai/glm-5.3-flash', name: 'GLM 5.3 Flash', contextLength: 200000, inPerM: 0.15, outPerM: 0.5, supportsReasoning: true },
        { id: NEW_MODEL, name: 'Brand new', contextLength: 100000, inPerM: 1.25, outPerM: 2.5, supportsReasoning: false },
      ],
      fetchedAt: '2026-10-08T00:00:00.000Z', stale: false, source: 'openrouter',
    }),
  };
  return new ModelsService({ pool, agents: new AgentsRepository(pool), catalog, defaults, prices, env: () => undefined });
}

test('global default, bulk actions, legacy channel overrides and the price upsert on real tables', { skip }, async () => {
  const agents = new AgentsRepository(pool);
  const orch = await agents.insert({ kind: 'orchestrator', scope: 'resource', scopeId: `telegram:${CH}`, name: 'M035', handle: 'm035_orch', createdBy: 'owner' });
  const exec = await agents.insert({ kind: 'executor', scope: 'resource', scopeId: `telegram:${CH}`, parentId: orch.id, name: 'M035 exec', handle: 'm035_exec', createdBy: 'owner' });
  const channels = new EditorChannelsRepository(pool);
  await channels.insertIfMissing({ ...makeDefaultCard(CH, 'Models'), models: { executor: 'z-ai/glm-5.3', planner: 'z-ai/glm-5.3-flashx' } });

  const defaults = new ModelDefaultsStore(pool);
  const prices = new PriceService(new LlmPricesRepository(pool));
  const svc = service(defaults, prices);

  // No setting: flash for everyone; the channel card's executor override applies to the executor.
  await pool.query(`DELETE FROM app_settings WHERE key = $1`, [DEFAULT_MODEL_KEY]);
  let o: any = await svc.overview();
  const row = (h: string) => o.agents.find((r: any) => r.handle === h);
  assert.deepEqual([row('m035_orch').effective.model, row('m035_orch').effective.source], ['z-ai/glm-5.3-flash', 'default']);
  assert.deepEqual([row('m035_exec').effective.model, row('m035_exec').effective.source], ['z-ai/glm-5.3', 'channel']);
  assert.deepEqual(o.channelOverrides.find((c: any) => c.channelKey === CH)?.models, { executor: 'z-ai/glm-5.3', planner: 'z-ai/glm-5.3-flashx' });

  // Save a new default: stored in app_settings, priced in llm_prices from the catalog, read back by a fresh store.
  assert.equal(await prices.price('openrouter', NEW_MODEL), null);
  await svc.setDefault({ model: NEW_MODEL });
  assert.equal((await pool.query(`SELECT value FROM app_settings WHERE key = $1`, [DEFAULT_MODEL_KEY])).rows[0].value, NEW_MODEL);
  assert.equal(await new ModelDefaultsStore(pool).get(), NEW_MODEL);
  const priced = await prices.price('openrouter', NEW_MODEL);
  assert.deepEqual([priced?.inPerM, priced?.outPerM], [1.25, 2.5]);
  const { rows: pr } = await pool.query(`SELECT count(*)::int AS n FROM llm_prices WHERE model = $1`, [NEW_MODEL]);
  assert.equal(pr[0].n, 1);
  await svc.setDefault({ model: NEW_MODEL });
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM llm_prices WHERE model = $1`, [NEW_MODEL])).rows[0].n, 1, 'no duplicate price');
  o = await svc.overview();
  assert.deepEqual([row('m035_orch').effective.model, row('m035_orch').effective.source], [NEW_MODEL, 'default']);

  // The settings service never treats ai.default_model as an env override.
  const settings = new SettingsService(pool as any, { get: () => undefined } as any);
  await settings.whenLoaded();
  assert.ok(!settings.get().overrides.includes(DEFAULT_MODEL_KEY));

  // Clear one role of the legacy override, then all.
  await svc.clearChannel({ channelKey: CH, role: 'executor' });
  assert.deepEqual((await channels.get(CH))!.models, { planner: 'z-ai/glm-5.3-flashx' });
  await svc.clearChannel({ channelKey: CH });
  assert.deepEqual((await channels.get(CH))!.models, {});

  // Bulk: apply to all agents, then reset all.
  const applied = await svc.bulk({ action: 'apply_all', model: 'z-ai/glm-5.3-flash' });
  assert.ok(applied.updated >= 2);
  assert.equal((await agents.get(exec.id))!.model, 'z-ai/glm-5.3-flash');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM agents WHERE model IS DISTINCT FROM 'z-ai/glm-5.3-flash'`)).rows[0].n, 0);
  const reset = await svc.bulk({ action: 'reset_all' });
  assert.ok(reset.updated >= 2);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM agents WHERE model IS NOT NULL`)).rows[0].n, 0);

  // Back to the built-in default.
  await svc.setDefault({ model: null });
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM app_settings WHERE key = $1`, [DEFAULT_MODEL_KEY])).rows[0].n, 0);
  assert.equal((await svc.overview()).defaultModel.model, 'z-ai/glm-5.3-flash');
});

test('fallback catalog from the seeded llm_prices rows', { skip }, async () => {
  const c = fallbackCatalog(await new LlmPricesRepository(pool).list());
  assert.ok(c.some((m) => m.id === 'z-ai/glm-5.3-flash' && m.inPerM != null));
  assert.ok(!c.some((m) => m.id === 'claude-haiku-4-5'), 'only OpenRouter rows');
});
