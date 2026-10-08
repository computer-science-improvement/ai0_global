// Spec 035 FR-002: the OpenRouter catalog with a FAKE fetch — these tests never call OpenRouter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelCatalog, OPENROUTER_MODELS_URL, parseOpenRouterModels, type CatalogModel, type FetchLike } from './model-catalog';

const FAKE_PAYLOAD = {
  data: [
    { id: 'z-ai/glm-5.3-flash', name: 'Z.AI: GLM 5.3 Flash', context_length: 200000,
      pricing: { prompt: '0.00000015', completion: '0.0000005' }, supported_parameters: ['tools', 'tool_choice', 'reasoning', 'include_reasoning'] },
    { id: 'openai/gpt-5-mini', name: 'OpenAI: GPT-5 Mini', context_length: 400000,
      pricing: { prompt: '0.00000025', completion: '0.000002' }, supported_parameters: ['tools', 'max_tokens'] },
    { id: 'some/no-tools', name: 'No tools', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['max_tokens'] },
    { id: 'openrouter/auto', name: 'Auto', pricing: { prompt: '-1', completion: '-1' }, supported_parameters: ['tools'] },
    { id: 'bad id with spaces too long'.repeat(10), supported_parameters: ['tools'] },
    { name: 'no id', supported_parameters: ['tools'] },
    null,
  ],
};

function fakeFetch(responses: Array<unknown | Error | 'hang'>) {
  const calls: string[] = [];
  const fn: FetchLike = async (url) => {
    calls.push(url);
    const r = responses.length > 1 ? responses.shift() : responses[0];
    if (r === 'hang') return new Promise(() => undefined);
    if (r instanceof Error) throw r;
    if (typeof r === 'number') return { ok: false, status: r, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => r };
  };
  return { fn, calls };
}

const FALLBACK: CatalogModel[] = [{ id: 'z-ai/glm-5.3-flash', name: 'z-ai/glm-5.3-flash', contextLength: null, inPerM: 0.15, outPerM: 0.5, supportsReasoning: false }];

test('parse: only tool-capable models, prices per 1M, reasoning flag, malformed entries skipped', () => {
  const m = parseOpenRouterModels(FAKE_PAYLOAD);
  assert.deepEqual(m.map((x) => x.id), ['openai/gpt-5-mini', 'openrouter/auto', 'z-ai/glm-5.3-flash']);
  const glm = m.find((x) => x.id === 'z-ai/glm-5.3-flash')!;
  assert.deepEqual(glm, { id: 'z-ai/glm-5.3-flash', name: 'Z.AI: GLM 5.3 Flash', contextLength: 200000, inPerM: 0.15, outPerM: 0.5, supportsReasoning: true });
  assert.equal(m.find((x) => x.id === 'openai/gpt-5-mini')!.supportsReasoning, false);
  const auto = m.find((x) => x.id === 'openrouter/auto')!;
  assert.equal(auto.inPerM, null, 'negative (variable) prices are unknown');
  assert.equal(auto.contextLength, null);
  assert.throws(() => parseOpenRouterModels({ nope: 1 }));
});

test('cached for 24 h: one fetch, then a refetch after the TTL', async () => {
  const f = fakeFetch([FAKE_PAYLOAD]);
  let now = Date.UTC(2026, 9, 8, 12);
  const cat = new ModelCatalog({ fetch: f.fn, fallback: async () => FALLBACK, now: () => now });
  const a = await cat.list();
  assert.equal(a.source, 'openrouter');
  assert.equal(a.stale, false);
  assert.equal(a.fetchedAt, new Date(now).toISOString());
  assert.equal(a.models.length, 3);
  await cat.list();
  now += 23 * 3_600_000;
  await cat.list();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls, [OPENROUTER_MODELS_URL]);
  now += 2 * 3_600_000;
  await cat.list();
  assert.equal(f.calls.length, 2);
});

test('concurrent requests share one fetch', async () => {
  const f = fakeFetch([FAKE_PAYLOAD]);
  const cat = new ModelCatalog({ fetch: f.fn, fallback: async () => FALLBACK });
  await Promise.all([cat.list(), cat.list(), cat.find('openai/gpt-5-mini')]);
  assert.equal(f.calls.length, 1);
});

test('a failed refresh serves the last good list as stale, and backs off before retrying', async () => {
  const f = fakeFetch([FAKE_PAYLOAD, new Error('ECONNRESET'), 503, FAKE_PAYLOAD]);
  let now = 0;
  const logs: string[] = [];
  const cat = new ModelCatalog({ fetch: f.fn, fallback: async () => FALLBACK, now: () => now, ttlMs: 1000, retryMs: 500, log: (m) => logs.push(m) });
  assert.equal((await cat.list()).stale, false);
  now = 1500;
  const s = await cat.list();
  assert.equal(s.source, 'openrouter');
  assert.equal(s.stale, true);
  assert.equal(s.models.length, 3);
  assert.equal(s.fetchedAt, new Date(0).toISOString());
  assert.match(logs[0], /ECONNRESET/);
  now = 1700;
  await cat.list();
  assert.equal(f.calls.length, 2, 'inside the back-off window: no new fetch');
  now = 2100;
  await cat.list();
  assert.equal(f.calls.length, 3);
  assert.match(logs[1], /HTTP 503/);
  now = 2700;
  const ok = await cat.list();
  assert.equal(ok.stale, false);
  assert.equal(f.calls.length, 4);
});

test('no good list yet: the fallback (llm_prices + static), marked stale', async () => {
  const f = fakeFetch([new Error('offline')]);
  const cat = new ModelCatalog({ fetch: f.fn, fallback: async () => FALLBACK });
  const s = await cat.list();
  assert.deepEqual(s, { models: FALLBACK, fetchedAt: null, stale: true, source: 'fallback' });
  const broken = new ModelCatalog({ fetch: f.fn, fallback: async () => { throw new Error('db'); } });
  assert.deepEqual((await broken.list()).models, []);
});

test('a hanging request times out and falls back', async () => {
  const f = fakeFetch(['hang']);
  const cat = new ModelCatalog({ fetch: f.fn, fallback: async () => FALLBACK, timeoutMs: 30 });
  const s = await cat.list();
  assert.equal(s.source, 'fallback');
});

test('an empty tool list is a failure, not an empty catalog', async () => {
  const f = fakeFetch([{ data: [{ id: 'a/b', supported_parameters: [] }] }]);
  const cat = new ModelCatalog({ fetch: f.fn, fallback: async () => FALLBACK });
  assert.equal((await cat.list()).source, 'fallback');
});
