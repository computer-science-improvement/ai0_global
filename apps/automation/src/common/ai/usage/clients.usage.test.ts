/**
 * Spec 029 T3: every provider client writes exactly one ledger row per call
 * (success, error, timeout), and a blocking budget takes the caller's null path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Logger } from '@nestjs/common';
import { ClaudeAgent } from '../agents/claude.agent';
import { OpenAiCompatibleAgent } from '../agents/openai-compatible.agent';
import { setLlmUsage, BudgetExceededError } from './llm-usage.service';
import { withLlmContext } from './llm-context';
import { runTrackedQuery, agentSdkAllowed } from './agent-sdk-usage';
import { captureUsage } from './testing';

const aiLogs: any[] = [];
const aiLogger = { log: async (e: any) => { aiLogs.push(e); } } as any;

function claude(create: (args: any) => Promise<any>) {
  const a = new ClaudeAgent({ get: () => undefined } as any, aiLogger);
  (a as any).client = { messages: { create } };
  return a;
}

class FakeCompat extends OpenAiCompatibleAgent {
  protected readonly logger = new Logger('FakeCompat');
  protected readonly apiKey = 'k';
  protected readonly baseUrl = 'https://x.test';
  protected readonly defaultModel = 'sonar-pro';
  constructor(protected readonly agentName: string, private readonly impl: () => Promise<{ data: any }>) { super(); this.aiLogger = aiLogger; }
  protected post() { return this.impl(); }
}

const msg = [{ role: 'user' as const, content: 'hi' }];

test('ClaudeAgent: ok with cache tokens, error, timeout → one row each; ai_logs unchanged', async () => {
  const cap = captureUsage({ price: (_m, u) => (u.tokensIn + u.tokensOut) / 1e6 });
  setLlmUsage(cap.usage);
  aiLogs.length = 0;
  const ok = claude(async () => ({
    content: [{ type: 'text', text: 'answer' }], stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 },
  }));
  assert.equal(await withLlmContext({ feature: 'strategy.s1.generate', resourceRef: 'strategy:s1' }, () => ok.chat(msg, { feature: 'review.post' })), 'answer');
  assert.equal(await claude(async () => { throw Object.assign(new Error('overloaded'), { status: 529 }); }).chat(msg), null);
  assert.equal(await claude(async () => { throw Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' }); }).chat(msg), null);

  const rows = await cap.rows();
  assert.equal(rows.length, 3);
  assert.deepEqual(
    [rows[0].provider, rows[0].model, rows[0].feature, rows[0].resource_ref, rows[0].status],
    ['anthropic', 'claude-haiku-4-5-20251001', 'review.post', 'strategy:s1', 'ok']);
  assert.deepEqual([rows[0].tokens_in, rows[0].tokens_out, rows[0].tokens_cached_read, rows[0].tokens_cached_write], [1150, 20, 1000, 50]);
  assert.equal(rows[0].cost_source, 'estimate');
  assert.deepEqual([rows[1].status, rows[1].error_code, rows[1].cost_usd, rows[1].feature], ['error', 'http_529', 0, 'unattributed']);
  assert.deepEqual([rows[2].status, rows[2].error_code], ['timeout', 'timeout']);
  assert.deepEqual(aiLogs.map((l) => l.status), ['success', 'error', 'error'], 'ai_logs still gets one entry per call');
});

test('ClaudeAgent: a blocking budget refuses the call → null, no provider call, no ledger row, no ai_log', async () => {
  const cap = captureUsage({ budget: { assertWithin: async () => { throw new BudgetExceededError('global', 3.1, 3); } } });
  setLlmUsage(cap.usage);
  aiLogs.length = 0;
  let called = false;
  const a = claude(async () => { called = true; return {}; });
  assert.deepEqual(await a.chatWithMeta(msg), { text: null, stopReason: null });
  assert.equal(called, false);
  assert.equal((await cap.rows()).length, 0);
  assert.equal(aiLogs.length, 0);
});

test('ClaudeAgent: a failing budget check lets the call through (fail open)', async () => {
  const cap = captureUsage({ budget: { assertWithin: async () => { throw new Error('db down'); } } });
  setLlmUsage(cap.usage);
  const a = claude(async () => ({ content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
  assert.equal(await a.chat(msg), 'x');
  assert.equal((await cap.rows()).length, 1);
});

test('OpenAI-compatible agents: provider per agent, cached tokens, error and timeout rows', async () => {
  const cap = captureUsage({ price: () => 0.001 });
  setLlmUsage(cap.usage);
  const okData = { data: { choices: [{ message: { content: 'r' } }], usage: { prompt_tokens: 300, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 100 } } } };
  assert.equal(await new FakeCompat('perplexity', async () => okData).chat(msg, { feature: 'text.summarize' }), 'r');
  assert.equal(await new FakeCompat('grok', async () => okData).chat(msg), 'r');
  assert.equal(await new FakeCompat('openai', async () => { throw Object.assign(new Error('Request failed with status code 500'), { response: { status: 500 } }); }).chat(msg), null);
  assert.equal(await new FakeCompat('openai', async () => { throw Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' }); }).chat(msg), null);
  const rows = await cap.rows();
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.provider), ['perplexity', 'xai', 'openai', 'openai']);
  assert.deepEqual([rows[0].tokens_in, rows[0].tokens_out, rows[0].tokens_cached_read, rows[0].feature, rows[0].model], [300, 40, 100, 'text.summarize', 'sonar-pro']);
  assert.equal(rows[0].cost_usd, 0.001);
  assert.deepEqual([rows[2].status, rows[2].error_code, rows[2].cost_usd], ['error', 'http_500', 0]);
  assert.deepEqual([rows[3].status, rows[3].error_code], ['timeout', 'timeout']);
});

test('OpenAI-compatible: a blocking budget returns null without calling the API', async () => {
  const cap = captureUsage({ budget: { assertWithin: async () => { throw new BudgetExceededError('provider:openai', 1, 1); } } });
  setLlmUsage(cap.usage);
  let called = false;
  assert.equal(await new FakeCompat('openai', async () => { called = true; return { data: {} }; }).chat(msg), null);
  assert.equal(called, false);
  assert.equal((await cap.rows()).length, 0);
});

async function* stream(msgs: any[], throwAt?: Error) {
  for (const m of msgs) yield m;
  if (throwAt) throw throwAt;
}

test('Agent SDK: success, error subtype, thrown timeout and missing result → one row each', async () => {
  const cap = captureUsage();
  const usage = cap.usage;
  const result = (subtype: string) => ({
    type: 'result', subtype, result: ' DUPLICATE ', total_cost_usd: 0.0021,
    usage: { input_tokens: 400, output_tokens: 5, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 },
    modelUsage: { 'claude-haiku-4-5-20251001': {} },
  });
  assert.equal(await runTrackedQuery(() => stream([{ type: 'system' }, result('success')]), { feature: 'dedup.novelty', usage }), 'DUPLICATE');
  assert.equal(await runTrackedQuery(() => stream([result('error_max_turns')]), { feature: 'routing.topic', usage }), null);
  await assert.rejects(() => runTrackedQuery(() => stream([], new Error('operation timed out')), { feature: 'dedup.novelty', usage }), /timed out/);
  assert.equal(await runTrackedQuery(() => stream([{ type: 'assistant' }]), { feature: 'dedup.novelty', usage }), null);
  const rows = await cap.rows();
  assert.equal(rows.length, 4);
  assert.deepEqual(
    [rows[0].provider, rows[0].model, rows[0].cost_usd, rows[0].cost_source, rows[0].tokens_in, rows[0].tokens_cached_read, rows[0].status],
    ['agent_sdk', 'claude-haiku-4-5-20251001', 0.0021, 'provider', 2400, 2000, 'ok']);
  assert.deepEqual([rows[1].status, rows[1].error_code, rows[1].cost_usd, rows[1].feature], ['error', 'error_max_turns', 0.0021, 'routing.topic']);
  assert.deepEqual([rows[2].status, rows[2].tokens_in, rows[2].cost_usd], ['timeout', null, 0]);
  assert.deepEqual([rows[3].status, rows[3].error_code], ['error', 'no_result']);
});

test('Agent SDK: a blocking budget refuses before query() runs', async () => {
  const warn: string[] = [];
  const cap = captureUsage({ budget: { assertWithin: async (f) => { if (f === 'dedup.novelty') throw new BudgetExceededError('global', 3, 3); } } });
  assert.equal(await agentSdkAllowed('dedup.novelty', (m) => warn.push(m), cap.usage), false);
  assert.equal(await agentSdkAllowed('routing.topic', (m) => warn.push(m), cap.usage), true);
  assert.match(warn[0], /refused/);
});
