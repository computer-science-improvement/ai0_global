/** Spec 029 T3: OpenRouterClient writes one llm_usage row per logical call (retries → attempts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenRouterClient } from './openrouter.client';
import { captureUsage } from '../../common/ai/usage/testing';

type R = { status?: number; data?: any; error?: any };
function client(responses: R[], usage: any, prices?: any) {
  const post = async () => {
    const r = responses.shift()!;
    if (r.error) throw r.error;
    if (r.status && r.status >= 400) throw Object.assign(new Error(`status ${r.status}`), { response: { status: r.status, data: r.data } });
    return { data: r.data };
  };
  return new OpenRouterClient({ apiKey: 'k', http: { post }, sleep: async () => {}, usage, prices });
}
const ok = (usage: any) => ({ data: { choices: [{ message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }], usage } });
const req = { model: 'z-ai/glm-5.3-flash', messages: [{ role: 'user' as const, content: 'q' }] };

test('ok after a 429 retry: one row with provider cost, cached tokens and attempts = 2', async () => {
  const cap = captureUsage();
  await client([{ status: 429 }, ok({ prompt_tokens: 1000, completion_tokens: 50, cost: 0.00042, prompt_tokens_details: { cached_tokens: 600 } })], cap.usage).chat(req);
  const rows = await cap.rows();
  assert.equal(rows.length, 1);
  assert.deepEqual(
    [rows[0].provider, rows[0].model, rows[0].tokens_in, rows[0].tokens_out, rows[0].tokens_cached_read, rows[0].cost_usd, rows[0].cost_source, rows[0].attempts, rows[0].status],
    ['openrouter', 'z-ai/glm-5.3-flash', 1000, 50, 600, 0.00042, 'provider', 2, 'ok']);
});

test('no usage.cost: the llm_prices estimate wins over the registry map', async () => {
  const cap = captureUsage();
  const prices = { estimate: async () => ({ costUsd: 0.5, source: 'estimate' as const }) };
  const res = await client([ok({ prompt_tokens: 1_000_000, completion_tokens: 0 })], cap.usage, prices).chat(req);
  assert.equal(res.usage.costUsd, 0.5);
  const rows = await cap.rows();
  assert.deepEqual([rows[0].cost_usd, rows[0].cost_source], [0.5, 'estimate']);
  // Unpriced in llm_prices → the registry PRICES fallback (glm-5.3-flash $0.15 / 1M in).
  const cap2 = captureUsage();
  const res2 = await client([ok({ prompt_tokens: 1_000_000, completion_tokens: 0 })], cap2.usage, { estimate: async () => ({ costUsd: null, source: 'unpriced' }) }).chat(req);
  assert.equal(res2.usage.costUsd, 0.15);
});

test('400 error: one error row, no tokens, cost 0', async () => {
  const cap = captureUsage();
  await assert.rejects(client([{ status: 400, data: { error: { message: 'bad' } } }], cap.usage).chat(req), /400/);
  const rows = await cap.rows();
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].status, rows[0].error_code, rows[0].tokens_in, rows[0].cost_usd, rows[0].attempts], ['error', 'http_400', null, 0, 1]);
});

test('timeouts on every attempt: one timeout row with attempts = 3', async () => {
  const cap = captureUsage();
  const timeout = () => ({ error: Object.assign(new Error('timeout of 60000ms exceeded'), { code: 'ECONNABORTED' }) });
  await assert.rejects(client([timeout(), timeout(), timeout()], cap.usage).chat(req), /timeout/);
  const rows = await cap.rows();
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].status, rows[0].attempts, rows[0].cost_usd], ['timeout', 3, 0]);
});

test('empty response with usage: an error row that keeps the billed tokens and cost', async () => {
  const cap = captureUsage();
  await assert.rejects(client([{ data: { choices: [], usage: { prompt_tokens: 10, completion_tokens: 0, cost: 0.00001 } } }], cap.usage).chat(req), /empty response/);
  const rows = await cap.rows();
  assert.deepEqual([rows.length, rows[0].status, rows[0].tokens_in, rows[0].cost_usd], [1, 'error', 10, 0.00001]);
});
