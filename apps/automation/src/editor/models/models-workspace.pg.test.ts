/**
 * Spec 038 on a throwaway Postgres: migration 077 (agents.anthropic_model, the Anthropic llm_prices rows), the
 * workspace in app_settings, per-workspace defaults and the bulk action on the Anthropic column only. Catalogs are
 * fakes / the static price list (never a network call). Skipped unless EDITOR_PG_TEST_URL is set. Never point
 * this at a real database. Settings and agent models changed here are restored.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { AgentsRepository } from '../agents/agents.repository';
import { ModelsService } from './models.service';
import { anthropicCatalog } from './model-catalog';
import { ANTHROPIC_DEFAULT_MODEL_KEY, WORKSPACE_KEY, WorkspaceModelStore, WorkspaceStore } from '../llm/workspace';
import { DEFAULT_MODEL_KEY } from '../llm/model-defaults';
import { LlmPricesRepository } from '../../common/ai/usage/llm-prices.repository';
import { PriceService } from '../../common/ai/usage/price.service';
import { SettingsService } from '../../settings/settings.service';

const url = process.env.EDITOR_PG_TEST_URL;
const skip = !url ? 'EDITOR_PG_TEST_URL not set' : false;
const MIGRATION = join(__dirname, '../../../../../database/migrations/077_model_workspace.sql');
const KEYS = [WORKSPACE_KEY, ANTHROPIC_DEFAULT_MODEL_KEY, DEFAULT_MODEL_KEY];
let pool: Pool;
let savedAgents: Array<{ id: string; model: string | null; anthropic_model: string | null }> = [];
let savedSettings: Array<{ key: string; value: string }> = [];

before(async () => {
  if (!url) return;
  pool = new Pool({ connectionString: url });
  const sql = readFileSync(MIGRATION, 'utf8');
  await pool.query(sql);
  await pool.query(sql); // CI re-applies every file: idempotent
  await pool.query(`DELETE FROM agents WHERE handle LIKE 'w038\\_%'`);
  savedAgents = (await pool.query(`SELECT id, model, anthropic_model FROM agents`)).rows;
  savedSettings = (await pool.query(`SELECT key, value FROM app_settings WHERE key = ANY($1)`, [KEYS])).rows;
});
after(async () => {
  if (!url) return;
  for (const r of savedAgents) await pool.query(`UPDATE agents SET model = $2, anthropic_model = $3 WHERE id = $1`, [r.id, r.model, r.anthropic_model]);
  await pool.query(`DELETE FROM app_settings WHERE key = ANY($1)`, [KEYS]);
  for (const r of savedSettings) await pool.query(`INSERT INTO app_settings (key, value) VALUES ($1, $2)`, [r.key, r.value]);
  await pool.query(`DELETE FROM agents WHERE handle LIKE 'w038\\_%'`);
  await pool.end();
});

test('migration 077: the column, the Anthropic prices with cache rates, the version row', { skip }, async () => {
  const { rows: col } = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'agents' AND column_name = 'anthropic_model'`);
  assert.equal(col.length, 1);
  const prices = new PriceService(new LlmPricesRepository(pool));
  const p = await prices.price('anthropic', 'claude-sonnet-5-5');
  assert.deepEqual([p?.inPerM, p?.outPerM, p?.cachedReadPerM, p?.cachedWritePerM], [2, 10, 0.1, 2.5]);
  const e = await prices.estimate('anthropic', 'claude-opus-5-5', { tokensIn: 1_000_000, tokensOut: 100_000, tokensCachedRead: 800_000, tokensCachedWrite: 0 });
  // 200K × $4 + 800K × $0.20 + 100K × $20 per 1M = 0.8 + 0.16 + 2
  assert.equal(e.costUsd, 2.96);
  const { rows: v } = await pool.query(`SELECT 1 FROM schema_migrations WHERE version = '077_model_workspace'`);
  assert.equal(v.length, 1);
});

test('workspace, per-workspace defaults, agent models per column, bulk on the active column only', { skip }, async () => {
  await pool.query(`DELETE FROM app_settings WHERE key = ANY($1)`, [KEYS]);
  const agents = new AgentsRepository(pool);
  const a = await agents.insert({ kind: 'orchestrator', scope: 'resource', scopeId: 'telegram:@w038_pg', name: 'W038', handle: 'w038_orch', createdBy: 'owner', model: 'z-ai/glm-5.3' });
  const upd = (await agents.update(a.id, { anthropicModel: 'claude-haiku-5-5' }))!;
  assert.deepEqual([upd.model, upd.anthropicModel], ['z-ai/glm-5.3', 'claude-haiku-5-5']);

  const workspace = new WorkspaceStore(pool);
  const defaults = new WorkspaceModelStore(pool, 'default', {}, workspace);
  let key = false;
  const svc = new ModelsService({
    pool, agents, defaults, workspace, anthropicKey: () => key,
    catalog: { list: async () => ({ models: [], fetchedAt: null, stale: true, source: 'fallback' }) },
    anthropicCatalog: anthropicCatalog({ apiKey: undefined, fetch: async () => { throw new Error('no network in tests'); } }),
    prices: new PriceService(new LlmPricesRepository(pool)), env: () => undefined,
  });

  assert.equal(await workspace.get(), 'openrouter');
  await assert.rejects(() => svc.setWorkspace({ workspace: 'anthropic' }), (e: any) => e.getResponse?.().error === 'anthropic_key_missing');
  key = true;
  await svc.setWorkspace({ workspace: 'anthropic' });
  assert.equal((await pool.query(`SELECT value FROM app_settings WHERE key = $1`, [WORKSPACE_KEY])).rows[0].value, 'anthropic');
  assert.equal(await new WorkspaceStore(pool).get(), 'anthropic', 'a fresh store reads it back');
  assert.equal(await defaults.workspace(), 'anthropic');

  await svc.setDefault({ model: 'claude-opus-5-5' });
  assert.equal((await pool.query(`SELECT value FROM app_settings WHERE key = $1`, [ANTHROPIC_DEFAULT_MODEL_KEY])).rows[0].value, 'claude-opus-5-5');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM app_settings WHERE key = $1`, [DEFAULT_MODEL_KEY])).rows[0].n, 0, 'the OpenRouter default is untouched');

  const o: any = await svc.overview();
  const row = o.agents.find((r: any) => r.handle === 'w038_orch');
  assert.deepEqual([row.model, row.effective.model, row.effective.source], ['claude-haiku-5-5', 'claude-haiku-5-5', 'agent']);

  await svc.bulk({ action: 'apply_all', model: 'claude-sonnet-5-5' });
  const after1 = (await agents.get(a.id))!;
  assert.deepEqual([after1.model, after1.anthropicModel], ['z-ai/glm-5.3', 'claude-sonnet-5-5']);
  await svc.bulk({ action: 'reset_all' });
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM agents WHERE anthropic_model IS NOT NULL`)).rows[0].n, 0);
  assert.equal((await agents.get(a.id))!.model, 'z-ai/glm-5.3', 'OpenRouter choices survive');

  // The settings service never treats ai.* (the workspace included) as env overrides.
  const settings = new SettingsService(pool as any, { get: () => undefined } as any);
  await settings.whenLoaded();
  assert.ok(!settings.get().overrides.includes(WORKSPACE_KEY));

  await svc.setWorkspace({ workspace: 'openrouter' });
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM app_settings WHERE key = $1`, [WORKSPACE_KEY])).rows[0].n, 0, 'openrouter = no row');
});
