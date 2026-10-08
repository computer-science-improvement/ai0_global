// Spec 035: the Models page service over an in-memory pool and a fake catalog (no OpenRouter, no DB).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelsService, fallbackCatalog } from './models.service';
import type { CatalogModel, CatalogSnapshot } from './model-catalog';
import type { Agent } from '../agents/agent.types';
import type { PriceRow } from '../../common/ai/usage/llm-prices.repository';
import { AgentsService } from '../agents/agents.service';

const T0 = new Date('2026-10-08T10:00:00Z');

function agent(p: Partial<Agent> & Pick<Agent, 'id' | 'kind' | 'handle'>): Agent {
  return {
    scope: 'system', scopeId: null, parentId: null, name: p.handle, emoji: null, description: null, mode: 'shadow', status: 'active',
    pausedUntil: null, model: null, reasoningEffort: null, schedule: {}, dailyBudgetUsd: null, shadowUntil: null,
    createdBy: 'migration', createdAt: T0, updatedAt: T0, ...p,
  };
}

const CATALOG: CatalogModel[] = [
  { id: 'z-ai/glm-5.3-flash', name: 'GLM 5.3 Flash', contextLength: 200000, inPerM: 0.15, outPerM: 0.5, supportsReasoning: true },
  { id: 'openai/gpt-5-mini', name: 'GPT-5 Mini', contextLength: 400000, inPerM: 0.25, outPerM: 2, supportsReasoning: false },
  { id: 'anthropic/claude-haiku-4.5', name: 'Claude Haiku 4.5', contextLength: 200000, inPerM: 1, outPerM: 5, supportsReasoning: true },
];

function world(opts: { env?: Record<string, string>; saved?: string | null; source?: 'openrouter' | 'fallback'; priced?: string[] } = {}) {
  const agents: Agent[] = [
    agent({ id: 'm', kind: 'manager', handle: 'manager' }),
    agent({ id: 'b', kind: 'builder', handle: 'ai0', model: 'openai/gpt-5-mini' }),
    agent({ id: 'o1', kind: 'orchestrator', handle: 'news', scope: 'resource', scopeId: 'telegram:@news', reasoningEffort: 'high' }),
    agent({ id: 'p1', kind: 'planner', handle: 'news_planner', parentId: 'o1', scope: 'resource', scopeId: 'telegram:@news' }),
    agent({ id: 'e1', kind: 'executor', handle: 'news_executor', parentId: 'o1', scope: 'resource', scopeId: 'telegram:@news' }),
    agent({ id: 'i1', kind: 'idea_reviewer', handle: 'news_ideas', parentId: 'o1', scope: 'resource', scopeId: 'telegram:@news' }),
    agent({ id: 'o2', kind: 'orchestrator', handle: 'space', scope: 'resource', scopeId: 'telegram:@space', model: 'anthropic/claude-haiku-4.5' }),
    agent({ id: 'r2', kind: 'reviewer', handle: 'space_reviewer', parentId: 'o2', scope: 'resource', scopeId: 'telegram:@space' }),
  ];
  const channels: Array<{ channel_key: string; title: string | null; models: Record<string, string> }> = [
    { channel_key: '@news', title: 'News', models: { executor: 'z-ai/glm-5.3', planner: ' ' } },
    { channel_key: '@space', title: null, models: {} },
  ];
  const prices: PriceRow[] = (opts.priced ?? ['z-ai/glm-5.3-flash']).map((m) => ({
    provider: 'openrouter', model: m, inPerM: 0.11, outPerM: 0.22, cachedReadPerM: null, cachedWritePerM: null, perRequestUsd: null, effectiveFrom: '2026-01-01',
  }));
  const sqls: string[] = [];
  let invalidated = 0;
  let saved = opts.saved ?? null;
  const pool = {
    query: async (sql: string, params: any[] = []) => {
      sqls.push(sql);
      if (sql.includes('FROM editor_channels')) return { rows: channels.map((c) => ({ ...c, models: { ...c.models } })), rowCount: channels.length };
      if (sql.startsWith('UPDATE agents SET model = $1')) {
        let n = 0;
        for (const a of agents) if (a.model !== params[0]) { a.model = params[0]; n++; }
        return { rows: [], rowCount: n };
      }
      if (sql.startsWith('UPDATE agents SET model = NULL')) {
        let n = 0;
        for (const a of agents) if (a.model !== null) { a.model = null; n++; }
        return { rows: [], rowCount: n };
      }
      if (sql.startsWith('UPDATE editor_channels')) {
        const c = channels.find((x) => x.channel_key === params[0]);
        if (!c) return { rows: [], rowCount: 0 };
        if (params[1] == null) c.models = {}; else delete c.models[params[1]];
        return { rows: [{ models: c.models }], rowCount: 1 };
      }
      if (sql.startsWith('INSERT INTO llm_prices')) {
        prices.push({ provider: params[0], model: params[1], inPerM: params[2], outPerM: params[3], cachedReadPerM: null, cachedWritePerM: null, perRequestUsd: null, effectiveFrom: '2026-01-01' });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  const snapshot = (): CatalogSnapshot => (opts.source === 'fallback'
    ? { models: fallbackCatalog(prices), fetchedAt: null, stale: true, source: 'fallback' }
    : { models: CATALOG, fetchedAt: T0.toISOString(), stale: false, source: 'openrouter' });
  const svc = new ModelsService({
    pool: pool as any,
    agents: { list: async () => agents.map((a) => ({ ...a })) },
    catalog: { list: async () => snapshot() },
    defaults: { get: async () => saved, set: async (m) => { saved = m; } },
    prices: { price: async (_p, m) => prices.find((x) => x.model === m) ?? null, invalidate: () => { invalidated++; } },
    env: (k) => opts.env?.[k],
  });
  return { svc, agents, channels, prices, sqls, get saved() { return saved; }, get invalidated() { return invalidated; } };
}

test('catalog: the current default first', async () => {
  const w = world({ saved: 'openai/gpt-5-mini' });
  const c = await w.svc.catalog();
  assert.equal(c.defaultModel, 'openai/gpt-5-mini');
  assert.deepEqual(c.models.map((m) => m.id), ['openai/gpt-5-mini', 'z-ai/glm-5.3-flash', 'anthropic/claude-haiku-4.5']);
  const d = await world().svc.catalog();
  assert.equal(d.defaultModel, 'z-ai/glm-5.3-flash');
  assert.equal(d.models[0].id, 'z-ai/glm-5.3-flash');
});

test('overview: effective model + source per agent, inheritance, channel overrides, env notes without values', async () => {
  const w = world({ env: { EDITOR_MODEL_REVIEWER: 'secret/env-model', OPENROUTER_API_KEY: 'sk-should-never-leak' } });
  const o: any = await w.svc.overview();
  const row = (h: string) => o.agents.find((r: any) => r.handle === h);
  assert.deepEqual(o.agents.map((r: any) => r.handle), ['manager', 'ai0', 'news', 'news_planner', 'news_executor', 'news_ideas', 'space', 'space_reviewer']);
  assert.deepEqual(o.defaultModel, { model: 'z-ai/glm-5.3-flash', saved: null, builtin: 'z-ai/glm-5.3-flash', price: { inPerM: 0.11, outPerM: 0.22, source: 'llm_prices' } });

  assert.deepEqual([row('manager').effective.model, row('manager').effective.source], ['z-ai/glm-5.3-flash', 'default']);
  assert.deepEqual([row('ai0').effective.model, row('ai0').effective.source], ['openai/gpt-5-mini', 'agent']);
  assert.deepEqual(row('ai0').price, { inPerM: 0.25, outPerM: 2, source: 'catalog' });
  // The legacy channel card override applies to that role only (blank entries ignored).
  assert.deepEqual([row('news_executor').effective.model, row('news_executor').effective.source], ['z-ai/glm-5.3', 'channel']);
  assert.equal(row('news_executor').channelKey, '@news');
  assert.deepEqual([row('news_planner').effective.model, row('news_planner').effective.source], ['z-ai/glm-5.3-flash', 'default']);
  // idea_reviewer has no special default any more.
  assert.deepEqual([row('news_ideas').effective.model, row('news_ideas').effective.source], ['z-ai/glm-5.3-flash', 'default']);
  // Role children inherit the orchestrator's model (and reasoning effort).
  assert.deepEqual([row('space_reviewer').effective.model, row('space_reviewer').effective.source, row('space_reviewer').effective.inheritedFrom],
    ['anthropic/claude-haiku-4.5', 'agent', 'space']);
  assert.deepEqual([row('news_planner').effective.reasoningEffort, row('news_planner').effective.reasoningSource], ['high', 'agent']);
  assert.deepEqual([row('manager').effective.reasoningEffort, row('manager').effective.reasoningSource], ['medium', 'default']);
  assert.equal(row('news_planner').parentHandle, 'news');

  assert.deepEqual(o.envOverrides, [{ role: 'reviewer', key: 'EDITOR_MODEL_REVIEWER' }]);
  const text = JSON.stringify(o);
  assert.ok(!text.includes('secret/env-model'), 'env values are never returned');
  assert.ok(!text.includes('sk-should-never-leak'));
  assert.deepEqual(o.channelOverrides, [{ channelKey: '@news', title: 'News', models: { executor: 'z-ai/glm-5.3' } }]);
});

test('overview: an env override beats the global default but not an agent/channel choice', async () => {
  const w = world({ saved: 'openai/gpt-5-mini', env: { EDITOR_MODEL_MANAGER: 'x/env' } });
  const o: any = await w.svc.overview();
  const m = o.agents.find((r: any) => r.handle === 'manager');
  assert.deepEqual([m.effective.model, m.effective.source], ['x/env', 'env']);
  const p = o.agents.find((r: any) => r.handle === 'news_planner');
  assert.deepEqual([p.effective.model, p.effective.source], ['openai/gpt-5-mini', 'default']);
  assert.equal(o.defaultModel.saved, 'openai/gpt-5-mini');
});

test('setDefault: validates against the catalog, prices a new model, null returns to the built-in default', async () => {
  const w = world({ priced: [] });
  await assert.rejects(w.svc.setDefault({ model: 'nope/model' }), (e: any) => e.response?.error === 'unknown_model');
  await assert.rejects(w.svc.setDefault({ model: 'has space' }), (e: any) => e.response?.error === 'invalid_body');
  await assert.rejects(w.svc.setDefault({}), (e: any) => e.response?.error === 'invalid_body');
  const r = await w.svc.setDefault({ model: 'anthropic/claude-haiku-4.5' });
  assert.deepEqual(r, { ok: true, defaultModel: 'anthropic/claude-haiku-4.5', saved: 'anthropic/claude-haiku-4.5' });
  assert.equal(w.saved, 'anthropic/claude-haiku-4.5');
  assert.deepEqual(w.prices.map((p) => [p.model, p.inPerM, p.outPerM]), [['anthropic/claude-haiku-4.5', 1, 5]]);
  assert.equal(w.invalidated, 1);
  // Choosing it again does not insert a second price.
  await w.svc.setDefault({ model: 'anthropic/claude-haiku-4.5' });
  assert.equal(w.prices.length, 1);
  const back = await w.svc.setDefault({ model: null });
  assert.deepEqual(back, { ok: true, defaultModel: 'z-ai/glm-5.3-flash', saved: null });
  assert.equal(w.saved, null);
});

test('validation with an offline catalog: the fallback list (llm_prices + static) and the values already set are accepted', async () => {
  const w = world({ source: 'fallback', saved: 'custom/kept', priced: ['z-ai/glm-5.3-flash', 'openai/gpt-4o-mini'] });
  await w.svc.setDefault({ model: 'z-ai/glm-5.3' });
  await w.svc.setDefault({ model: 'openai/gpt-4o-mini' });
  await assert.rejects(w.svc.setDefault({ model: 'openai/gpt-5-mini' }), (e: any) => /offline model list/.test(e.response?.details));
  await w.svc.checkAgentModel('custom/agent-own', 'custom/agent-own');
  // No price insert from the fallback list (it is priced already).
  assert.ok(!w.sqls.some((s) => s.startsWith('INSERT INTO llm_prices')));
});

test('bulk: apply to all agents (validated, priced) and reset all to the default', async () => {
  const w = world({ priced: [] });
  await assert.rejects(w.svc.bulk({ action: 'apply_all' }), (e: any) => e.response?.error === 'invalid_body');
  await assert.rejects(w.svc.bulk({ action: 'apply_all', model: 'x/unknown' }), (e: any) => e.response?.error === 'unknown_model');
  await assert.rejects(w.svc.bulk({ action: 'nuke' }), (e: any) => e.response?.error === 'invalid_body');
  const r = await w.svc.bulk({ action: 'apply_all', model: 'openai/gpt-5-mini' });
  assert.deepEqual(r, { ok: true, action: 'apply_all', model: 'openai/gpt-5-mini', updated: 7 });
  assert.ok(w.agents.every((a) => a.model === 'openai/gpt-5-mini'));
  assert.deepEqual(w.prices.map((p) => p.model), ['openai/gpt-5-mini']);
  const o: any = await w.svc.overview();
  assert.ok(o.agents.every((a: any) => a.effective.source === 'agent' && a.effective.model === 'openai/gpt-5-mini'), 'agent beats the channel override');
  const z = await w.svc.bulk({ action: 'reset_all' });
  assert.deepEqual(z, { ok: true, action: 'reset_all', updated: 8 });
  assert.ok(w.agents.every((a) => a.model === null));
  // A model already set on some agent may be applied to all even when the catalog no longer lists it.
  w.agents[0].model = 'legacy/kept';
  await w.svc.bulk({ action: 'apply_all', model: 'legacy/kept' });
});

test('clear a channel override: one role, or all; unknown channel → 404', async () => {
  const w = world();
  const one = await w.svc.clearChannel({ channelKey: '@news', role: 'executor' });
  assert.deepEqual(one, { ok: true, channelKey: '@news', models: { planner: ' ' } });
  const all = await w.svc.clearChannel({ channelKey: '@news' });
  assert.deepEqual(all.models, {});
  await assert.rejects(w.svc.clearChannel({ channelKey: '@missing' }), (e: any) => e.response?.error === 'channel_not_found');
  await assert.rejects(w.svc.clearChannel({ channelKey: '@news', role: 'janitor' }), (e: any) => e.response?.error === 'invalid_body');
});

test('ensurePrice: never throws, skips priced / unknown models', async () => {
  const w = world({ priced: ['openai/gpt-5-mini'] });
  assert.equal(await w.svc.ensurePrice('openai/gpt-5-mini'), false);
  assert.equal(await w.svc.ensurePrice('not/in-catalog'), false);
  assert.equal(await w.svc.ensurePrice('anthropic/claude-haiku-4.5'), true);
  const broken = new ModelsService({
    pool: { query: async () => { throw new Error('db down'); } },
    agents: { list: async () => [] }, catalog: { list: async () => ({ models: CATALOG, fetchedAt: null, stale: false, source: 'openrouter' }) },
    defaults: { get: async () => null, set: async () => {} },
    prices: { price: async () => null, invalidate: () => {} }, env: () => undefined,
  });
  assert.equal(await broken.ensurePrice('openai/gpt-5-mini'), false);
});

test('fallbackCatalog: OpenRouter rows of llm_prices (latest) + the static map', () => {
  const rows: PriceRow[] = [
    { provider: 'openrouter', model: 'z-ai/glm-5.3-flash', inPerM: 0.1, outPerM: 0.4, cachedReadPerM: null, cachedWritePerM: null, perRequestUsd: null, effectiveFrom: '2026-01-01' },
    { provider: 'openrouter', model: 'z-ai/glm-5.3-flash', inPerM: 0.2, outPerM: 0.6, cachedReadPerM: null, cachedWritePerM: null, perRequestUsd: null, effectiveFrom: '2026-09-01' },
    { provider: 'anthropic', model: 'claude-haiku-4-5', inPerM: 1, outPerM: 5, cachedReadPerM: null, cachedWritePerM: null, perRequestUsd: null, effectiveFrom: '2026-01-01' },
  ];
  const c = fallbackCatalog(rows);
  assert.deepEqual(c.map((m) => m.id), ['z-ai/glm-5.3', 'z-ai/glm-5.3-flash', 'z-ai/glm-5.3-flashx']);
  assert.deepEqual([c[1].inPerM, c[1].outPerM], [0.2, 0.6]);
});

test('PATCH /api/agents/:handle runs the model guard on a new model only, and prices it after the save', async () => {
  const a = agent({ id: 'x', kind: 'builder', handle: 'ai0', model: 'old/model' });
  const checked: string[] = [];
  const chosen: string[] = [];
  const updates: any[] = [];
  const svc = new AgentsService({
    pool: { query: async () => ({ rows: [] }) } as any,
    agents: { getByHandle: async () => a, update: async (_id: string, p: any) => { updates.push(p); return { ...a, ...p }; } } as any,
    skills: {} as any, inbox: {} as any,
    setChannelMode: async () => {}, runNow: async () => ({ started: false, what: '' }), memory: async () => [],
    models: {
      check: async (m) => { checked.push(m); if (m === 'bad/model') throw new Error('unknown_model'); },
      chosen: async (m) => { chosen.push(m); },
    },
  });
  await assert.rejects(svc.patch('ai0', { model: 'bad/model' }), /unknown_model/);
  assert.equal(updates.length, 0, 'nothing saved');
  await svc.patch('ai0', { model: 'openai/gpt-5-mini', reasoning_effort: 'high' });
  await svc.patch('ai0', { model: 'old/model' });
  await svc.patch('ai0', { model: null, reasoning_effort: null });
  assert.deepEqual(checked, ['bad/model', 'openai/gpt-5-mini']);
  assert.deepEqual(chosen, ['openai/gpt-5-mini']);
  assert.deepEqual(updates[0], { model: 'openai/gpt-5-mini', reasoningEffort: 'high' });
  assert.deepEqual(updates[2], { model: null, reasoningEffort: null });
});
