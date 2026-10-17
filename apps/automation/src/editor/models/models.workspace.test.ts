// Spec 038: the model workspace (OpenRouter | Anthropic) — registry precedence, the Models service per workspace, the
// Anthropic catalog and the agent PATCH. In-memory pool and fake catalogs only (no network, no DB, no paid call).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelsService } from './models.service';
import { anthropicCatalog, anthropicStaticCatalog, parseAnthropicModels, type CatalogModel } from './model-catalog';
import { pickModel, resolveModel, envModelKey } from '../llm/model-registry';
import { agentModelIn, anthropicApiKey, readModelContext, type Workspace } from '../llm/workspace';
import { AgentsService } from '../agents/agents.service';
import type { Agent } from '../agents/agent.types';

const T0 = new Date('2026-10-15T10:00:00Z');
const agent = (p: Partial<Agent> & Pick<Agent, 'id' | 'kind' | 'handle'>): Agent => ({
  scope: 'system', scopeId: null, parentId: null, name: p.handle, emoji: null, description: null, mode: 'shadow', status: 'active',
  pausedUntil: null, model: null, anthropicModel: null, reasoningEffort: null, schedule: {}, dailyBudgetUsd: null, shadowUntil: null,
  createdBy: 'migration', createdAt: T0, updatedAt: T0, ...p,
});

test('registry: the Anthropic workspace skips OpenRouter channel overrides, has its own env keys and built-in default', () => {
  const env = (k: string) => ({ EDITOR_MODEL_EXECUTOR: 'z-ai/glm-5.3', EDITOR_ANTHROPIC_MODEL_REVIEWER: 'claude-opus-5-5' } as Record<string, string>)[k];
  const card = { executor: 'openai/gpt-5-mini' };
  assert.deepEqual(pickModel('executor', env, card, {}), { model: 'openai/gpt-5-mini', source: 'channel' });
  assert.deepEqual(pickModel('executor', env, card, { workspace: 'anthropic' }), { model: 'claude-sonnet-5-5', source: 'default' });
  assert.deepEqual(pickModel('reviewer', env, card, { workspace: 'anthropic' }), { model: 'claude-opus-5-5', source: 'env' });
  assert.deepEqual(pickModel('executor', env, null, { workspace: 'anthropic', defaultModel: 'claude-haiku-5-5' }), { model: 'claude-haiku-5-5', source: 'default' });
  assert.deepEqual(pickModel('executor', env, card, { workspace: 'anthropic', agentModel: 'claude-opus-5-5' }), { model: 'claude-opus-5-5', source: 'agent' });
  assert.equal(envModelKey('planner', 'anthropic'), 'EDITOR_ANTHROPIC_MODEL_PLANNER');

  const p = resolveModel('planner', () => undefined, null, { workspace: 'anthropic', agentModel: 'claude-opus-5-5' });
  assert.deepEqual([p.model, p.workspace, p.inPerM, p.outPerM], ['claude-opus-5-5', 'anthropic', 4, 20]);
  const o = resolveModel('planner', () => undefined, null, {});
  assert.equal(o.workspace, undefined, 'OpenRouter profiles stay as before');
  assert.equal(o.model, 'z-ai/glm-5.3-flash');
});

test('workspace helpers: the agent model per workspace, the run context, the key (editor key first)', async () => {
  const a = { model: 'z-ai/glm-5.3', anthropicModel: 'claude-haiku-5-5' };
  assert.equal(agentModelIn(a, 'openrouter'), 'z-ai/glm-5.3');
  assert.equal(agentModelIn(a, 'anthropic'), 'claude-haiku-5-5');
  assert.equal(agentModelIn({ model: null }, 'anthropic'), null);
  const seen: Array<Workspace | undefined> = [];
  const ctx = await readModelContext({ workspace: async () => 'anthropic', defaultModel: async (ws) => { seen.push(ws); return ws === 'anthropic' ? 'claude-opus-5-5' : 'x'; } });
  assert.deepEqual(ctx, { workspace: 'anthropic', defaultModel: 'claude-opus-5-5' });
  assert.deepEqual(seen, ['anthropic']);
  assert.deepEqual(await readModelContext({ workspace: async () => { throw new Error('db down'); } }), { workspace: 'openrouter', defaultModel: null });
  assert.equal(anthropicApiKey((k) => ({ EDITOR_ANTHROPIC_API_KEY: ' ed ', ANTHROPIC_API_KEY: 'gen' } as any)[k]), 'ed');
  assert.equal(anthropicApiKey((k) => ({ EDITOR_ANTHROPIC_API_KEY: '', ANTHROPIC_API_KEY: 'gen' } as any)[k]), 'gen');
  assert.equal(anthropicApiKey(() => undefined), undefined);
});

test('Anthropic catalog: the price list without a key (no network); the live list merged with it', async () => {
  let fetched = 0;
  const off = anthropicCatalog({ apiKey: undefined, fetch: async () => { fetched++; throw new Error('no'); } });
  const snap = await off.list();
  assert.equal(fetched, 0);
  assert.equal(snap.source, 'anthropic');
  assert.ok(snap.models.some((m) => m.id === 'claude-sonnet-5-5' && m.inPerM === 2 && m.outPerM === 10));

  const merged = parseAnthropicModels({ data: [
    { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' },
    { id: 'claude-fable-5-1', display_name: 'Claude Fable 5.1' },
    { id: 'claude-3-haiku-20240307', display_name: 'Claude Haiku 3' },
  ] });
  assert.ok(merged.find((m) => m.id === 'claude-fable-5-1' && m.inPerM === null && m.supportsReasoning));
  assert.ok(!merged.some((m) => m.id.startsWith('claude-3')), 'old generations left out');
  assert.equal(merged.filter((m) => m.id === 'claude-sonnet-5-5').length, 1);

  const calls: any[] = [];
  const on = anthropicCatalog({ apiKey: 'sk-ant', fetch: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ data: [{ id: 'claude-fable-5-1', display_name: 'Claude Fable 5.1' }] }) }; } });
  const live = await on.list();
  assert.equal(live.source, 'anthropic');
  assert.ok(live.fetchedAt);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/models?limit=1000');
  assert.equal(calls[0].init.headers['x-api-key'], 'sk-ant');
  assert.equal(live.models.length, anthropicStaticCatalog().length + 1);
});

function world(o: { ws?: Workspace; key?: boolean } = {}) {
  let ws: Workspace = o.ws ?? 'openrouter';
  const saved: Record<Workspace, string | null> = { openrouter: null, anthropic: null };
  const critic: Record<Workspace, string | null> = { openrouter: null, anthropic: null };
  const agents: Agent[] = [
    agent({ id: 'm', kind: 'manager', handle: 'manager', model: 'z-ai/glm-5.3', anthropicModel: 'claude-opus-5-5' }),
    agent({ id: 'o1', kind: 'orchestrator', handle: 'news', scope: 'resource', scopeId: 'telegram:@news', anthropicModel: 'claude-haiku-5-5' }),
    agent({ id: 'e1', kind: 'executor', handle: 'news_executor', parentId: 'o1', scope: 'resource', scopeId: 'telegram:@news', model: 'openai/gpt-5-mini' }),
  ];
  const sqls: Array<{ sql: string; params: any[] }> = [];
  const pool = {
    query: async (sql: string, params: any[] = []) => {
      sqls.push({ sql, params });
      if (sql.includes('FROM editor_channels')) return { rows: [{ channel_key: '@news', title: 'News', models: { executor: 'z-ai/glm-5.3' } }], rowCount: 1 };
      if (sql.startsWith('UPDATE agents SET anthropic_model = $1')) {
        let n = 0;
        for (const a of agents) if (a.anthropicModel !== params[0]) { a.anthropicModel = params[0]; n++; }
        return { rows: [], rowCount: n };
      }
      if (sql.startsWith('UPDATE agents SET anthropic_model = NULL')) {
        let n = 0;
        for (const a of agents) if (a.anthropicModel) { a.anthropicModel = null; n++; }
        return { rows: [], rowCount: n };
      }
      if (sql.includes('INSERT INTO llm_prices')) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  const OR: CatalogModel[] = [{ id: 'z-ai/glm-5.3-flash', name: 'GLM', contextLength: null, inPerM: 0.15, outPerM: 0.5, supportsReasoning: true }];
  const svc = new ModelsService({
    pool: pool as any,
    agents: { list: async () => agents.map((a) => ({ ...a })) },
    catalog: { list: async () => ({ models: OR, fetchedAt: T0.toISOString(), stale: false, source: 'openrouter' }) },
    anthropicCatalog: anthropicCatalog({ apiKey: undefined, fetch: async () => { throw new Error('no network'); } }),
    defaults: { get: async (w = 'openrouter') => saved[w], set: async (w, m) => { saved[w] = m; } },
    critic: { get: async (w = 'openrouter') => critic[w], set: async (w, m) => { critic[w] = m; } },
    workspace: { get: async () => ws, set: async (w) => { ws = w; } },
    anthropicKey: () => !!o.key,
    prices: { price: async () => null, invalidate: () => {} },
    env: (k) => ({ EDITOR_ANTHROPIC_MODEL_CHECKER: 'claude-haiku-5-5', EDITOR_MODEL_PLANNER: 'z-ai/glm-5.3' } as Record<string, string>)[k],
  });
  return { svc, agents, sqls, saved, critic, get ws() { return ws; } };
}

test('switching: Anthropic needs a key on the server; the info lists each workspace default and own-model counts', async () => {
  const w = world();
  await assert.rejects(() => w.svc.setWorkspace({ workspace: 'anthropic' }), (e: any) => e.getResponse?.().error === 'anthropic_key_missing');
  assert.equal(w.ws, 'openrouter');
  await assert.rejects(() => w.svc.setWorkspace({ workspace: 'vertex' }), /Bad Request|invalid_body/);

  const k = world({ key: true });
  assert.deepEqual(await k.svc.setWorkspace({ workspace: 'anthropic' }), { ok: true, workspace: 'anthropic' });
  const info = await k.svc.workspaceInfo();
  assert.equal(info.active, 'anthropic');
  assert.equal(info.anthropicKey, true);
  assert.deepEqual(info.workspaces, [
    { id: 'openrouter', defaultModel: 'z-ai/glm-5.3-flash', perRole: false, agentsWithOwnModel: 2 },
    { id: 'anthropic', defaultModel: 'claude-sonnet-5-5', perRole: true, agentsWithOwnModel: 2 },
  ]);
  await k.svc.setWorkspace({ workspace: 'openrouter' });
  assert.equal(k.ws, 'openrouter', 'back to OpenRouter needs nothing');
});

test('overview in the Anthropic workspace: its own agent models, inheritance, env keys, no legacy channel overrides', async () => {
  const w = world({ ws: 'anthropic', key: true });
  const o: any = await w.svc.overview();
  assert.equal(o.workspace, 'anthropic');
  assert.deepEqual([o.defaultModel.model, o.defaultModel.builtin], ['claude-sonnet-5-5', 'claude-sonnet-5-5']);
  const by = Object.fromEntries(o.agents.map((a: any) => [a.handle, a]));
  assert.deepEqual([by.manager.model, by.manager.effective.model, by.manager.effective.source], ['claude-opus-5-5', 'claude-opus-5-5', 'agent']);
  assert.deepEqual([by.news_executor.model, by.news_executor.effective.model, by.news_executor.effective.inheritedFrom], [null, 'claude-haiku-5-5', 'news'],
    'the OpenRouter model of the executor is not used; it inherits the orchestrator\'s Anthropic model');
  assert.deepEqual(by.news_executor.price, { inPerM: 0.1, outPerM: 0.5, source: 'catalog' });
  assert.deepEqual(o.channelOverrides, []);
  assert.deepEqual(o.envOverrides, [{ role: 'checker', key: 'EDITOR_ANTHROPIC_MODEL_CHECKER' }]);
  assert.deepEqual([o.criticModel.model, o.criticModel.source], ['claude-haiku-5-5', 'env']);

  const or: any = await world().svc.overview();
  assert.equal(or.channelOverrides.length, 1);
  assert.deepEqual(or.envOverrides, [{ role: 'planner', key: 'EDITOR_MODEL_PLANNER' }]);
});

test('default, critic and bulk write the active workspace only; validation by its catalog', async () => {
  const w = world({ ws: 'anthropic', key: true });
  assert.deepEqual(await w.svc.setDefault({ model: 'claude-opus-5-5' }), { ok: true, workspace: 'anthropic', defaultModel: 'claude-opus-5-5', saved: 'claude-opus-5-5' });
  assert.deepEqual(w.saved, { openrouter: null, anthropic: 'claude-opus-5-5' });
  await assert.rejects(() => w.svc.setDefault({ model: 'z-ai/glm-5.3-flash' }), (e: any) => /not an Anthropic model/.test(e.getResponse?.().details));
  await w.svc.setCritic({ model: 'claude-haiku-5-5' });
  assert.deepEqual(w.critic, { openrouter: null, anthropic: 'claude-haiku-5-5' });

  const r = await w.svc.bulk({ action: 'apply_all', model: 'claude-sonnet-5-5' });
  assert.deepEqual(r, { ok: true, action: 'apply_all', workspace: 'anthropic', model: 'claude-sonnet-5-5', updated: 3 });
  assert.deepEqual(w.agents.map((a) => [a.model, a.anthropicModel]), [['z-ai/glm-5.3', 'claude-sonnet-5-5'], [null, 'claude-sonnet-5-5'], ['openai/gpt-5-mini', 'claude-sonnet-5-5']],
    'OpenRouter models are untouched');
  const z = await w.svc.bulk({ action: 'reset_all' });
  assert.equal(z.updated, 3);
  assert.ok(w.sqls.some((q) => q.sql.includes('INSERT INTO llm_prices') && q.params[0] === 'claude-opus-5-5'), 'a chosen Anthropic model is priced');
  const c = await w.svc.catalog();
  assert.equal(c.workspace, 'anthropic');
  assert.equal(c.models[0].id, 'claude-opus-5-5', 'the saved default first');
});

test('agent PATCH: `model` is the agent model of the active workspace', async () => {
  let ws: Workspace = 'anthropic';
  const a = agent({ id: 'o1', kind: 'orchestrator', handle: 'news', scope: 'resource', scopeId: 'telegram:@news', model: 'z-ai/glm-5.3' });
  const patches: any[] = [];
  const checks: any[] = [];
  const svc = new AgentsService({
    pool: { query: async () => ({ rows: [], rowCount: 0 }) } as any,
    agents: {
      list: async () => [a], get: async () => a, getByHandle: async () => a,
      update: async (_id: string, p: any) => { patches.push(p); return { ...a, ...p }; },
    } as any,
    setChannelMode: async () => undefined, runNow: async () => ({ started: false, what: '' }), memory: async () => [],
    models: { check: async (m, cur) => { checks.push([m, cur]); }, chosen: async () => undefined, workspace: async () => ws },
  } as any);
  await svc.patch('news', { model: 'claude-opus-5-5' });
  assert.deepEqual(patches[0], { anthropicModel: 'claude-opus-5-5' });
  assert.deepEqual(checks[0], ['claude-opus-5-5', null]);
  ws = 'openrouter';
  await svc.patch('news', { model: null });
  assert.deepEqual(patches[1], { model: null });
});

test('046: without the owner default the Anthropic workspace picks a model per role; the owner default still wins', () => {
  const none = () => undefined;
  assert.deepEqual(pickModel('executor', none, null, { workspace: 'anthropic' }), { model: 'claude-sonnet-5-5', source: 'default' });
  assert.deepEqual(pickModel('checker', none, null, { workspace: 'anthropic' }), { model: 'claude-sonnet-5-5', source: 'default' });
  for (const r of ['planner', 'orchestrator', 'idea_reviewer'] as const) {
    assert.deepEqual(pickModel(r, none, null, { workspace: 'anthropic' }), { model: 'claude-haiku-5-5', source: 'default' }, r);
  }
  assert.deepEqual(pickModel('orchestrator', none, null, { workspace: 'anthropic', defaultModel: 'claude-sonnet-5-5' }), { model: 'claude-sonnet-5-5', source: 'default' });
  assert.deepEqual(pickModel('orchestrator', none, null, {}), { model: 'z-ai/glm-5.3-flash', source: 'default' }, 'OpenRouter keeps one default');
});
