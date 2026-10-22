import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicClient, RoutingLlmClient, staticCost, supportsEffort, toAnthropicMessages } from './anthropic.client';
import type { ChatMessage, LlmClient, LlmRequest } from './llm.types';

function fakeHttp(responses: Array<{ status?: number; data?: any; networkError?: boolean }>) {
  const calls: Array<{ url: string; body: any; headers: any }> = [];
  const post = async (url: string, body: any, cfg: any) => {
    calls.push({ url, body: JSON.parse(JSON.stringify(body)), headers: cfg.headers });
    const r = responses.shift();
    if (!r) throw new Error('no more fake responses');
    if (r.networkError) { const e: any = new Error('ECONNRESET'); e.code = 'ECONNRESET'; throw e; }
    if (r.status && r.status >= 400) {
      const e: any = new Error(`status ${r.status}`); e.response = { status: r.status, data: r.data }; throw e;
    }
    return { status: 200, data: r.data };
  };
  return { calls, post };
}

const usage = { input_tokens: 1000, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0, output_tokens: 500 };
const reply = (content: any[], stop = 'end_turn', u: any = usage) => ({ data: { type: 'message', role: 'assistant', content, stop_reason: stop, usage: u } });

function client(http: ReturnType<typeof fakeHttp>, prices?: any) {
  return new AnthropicClient({ apiKey: 'sk-test', baseUrl: 'https://anthropic.test', http: { post: http.post }, sleep: async () => {}, prices });
}

const TOOLS = [
  { name: 'web_fetch', description: 'Fetch a page', parameters: { type: 'object', properties: { url: { type: 'string' } } } },
  { name: 'submit_post', description: 'Submit', parameters: { type: 'object', properties: {} } },
];

test('request: system on top, tools as input_schema with a cache breakpoint, effort, no temperature, thinking headroom', async () => {
  const http = fakeHttp([reply([{ type: 'text', text: 'ok' }])]);
  await client(http).chat({
    model: 'claude-sonnet-5-5', maxTokens: 6000, temperature: 0.7, reasoningEffort: 'low', provider: 'anthropic',
    messages: [{ role: 'system', content: 'You are the editor.' }, { role: 'user', content: 'Plan the day.' }],
    tools: TOOLS,
  });
  const { url, body, headers } = http.calls[0];
  assert.equal(url, 'https://anthropic.test/v1/messages');
  assert.equal(headers['x-api-key'], 'sk-test');
  assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.deepEqual(body.system, [{ type: 'text', text: 'You are the editor.', cache_control: { type: 'ephemeral' } }]);
  assert.equal(body.max_tokens, 16_000, 'thinking headroom over the 6000 role budget');
  assert.equal(body.temperature, undefined, 'temperature is not sent (thinking is on)');
  assert.deepEqual(body.output_config, { effort: 'low' });
  assert.deepEqual(body.tools[0], { name: 'web_fetch', description: 'Fetch a page', input_schema: TOOLS[0].parameters });
  assert.deepEqual(body.tools[1].cache_control, { type: 'ephemeral' });
  assert.deepEqual(body.tool_choice, { type: 'auto' });
  assert.deepEqual(body.messages, [{ role: 'user', content: [{ type: 'text', text: 'Plan the day.', cache_control: { type: 'ephemeral' } }] }]);
});

test("cache 'prefix' (spec 063 FR-008): one breakpoint after the system prompt, none on tools or messages", async () => {
  const c = client(fakeHttp([]));
  const req = {
    model: 'claude-sonnet-5-5', provider: 'anthropic' as const, cache: 'prefix' as const,
    messages: [{ role: 'system' as const, content: 'Stable rubric.' }, { role: 'user' as const, content: 'This post.' }],
    tools: TOOLS,
  };
  const body = c.body(req) as any;
  assert.deepEqual(body.system, [{ type: 'text', text: 'Stable rubric.', cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(body.messages, [{ role: 'user', content: [{ type: 'text', text: 'This post.' }] }]);
  assert.ok(body.tools.every((t: any) => t.cache_control === undefined));
  // false stays fully off; the default keeps the rolling breakpoint.
  const off = c.body({ ...req, cache: false }) as any;
  assert.equal(off.system[0].cache_control, undefined);
  const def = c.body({ ...req, cache: undefined }) as any;
  assert.deepEqual(def.messages[0].content[0].cache_control, { type: 'ephemeral' });
});

test('effort only for models that take it', () => {
  assert.ok(supportsEffort('claude-opus-5-5'));
  assert.ok(supportsEffort('claude-haiku-5-5'));
  assert.ok(supportsEffort('claude-sonnet-5'));
  assert.ok(supportsEffort('claude-opus-4-6'));
  assert.ok(!supportsEffort('claude-haiku-4-5'));
  assert.ok(!supportsEffort('claude-sonnet-4-5'));
  const c = new AnthropicClient({ apiKey: 'k' });
  assert.equal(c.body({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'x' }], reasoningEffort: 'high' }).output_config, undefined);
});

test('tool loop: tool_use parsed, thinking kept verbatim, tool results merged into one user turn after it', async () => {
  const blocks = [
    { type: 'thinking', thinking: 'Need the page first.', signature: 'sig-1' },
    { type: 'text', text: 'Fetching.' },
    { type: 'tool_use', id: 'toolu_1', name: 'web_fetch', input: { url: 'https://a.test' } },
    { type: 'tool_use', id: 'toolu_2', name: 'web_fetch', input: { url: 'https://b.test' } },
  ];
  const http = fakeHttp([reply(blocks, 'tool_use'), reply([{ type: 'text', text: 'done' }])]);
  const c = client(http);
  const messages: ChatMessage[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }];
  const r1 = await c.chat({ model: 'claude-opus-5-5', messages, tools: TOOLS });
  assert.equal(r1.finishReason, 'tool_calls');
  assert.equal(r1.message.content, 'Fetching.');
  assert.deepEqual(r1.message.toolCalls, [
    { id: 'toolu_1', name: 'web_fetch', arguments: '{"url":"https://a.test"}' },
    { id: 'toolu_2', name: 'web_fetch', arguments: '{"url":"https://b.test"}' },
  ]);
  messages.push(r1.message, { role: 'tool', toolCallId: 'toolu_1', content: 'A' }, { role: 'tool', toolCallId: 'toolu_2', content: 'B' },
    { role: 'user', content: 'Last step.' });
  const r2 = await c.chat({ model: 'claude-opus-5-5', messages, tools: TOOLS });
  assert.equal(r2.finishReason, 'stop');
  const sent = http.calls[1].body.messages;
  assert.equal(sent.length, 3);
  assert.deepEqual(sent[1], { role: 'assistant', content: blocks }, 'the thinking block goes back with its signature');
  assert.deepEqual(sent[2].content.map((b: any) => b.type), ['tool_result', 'tool_result', 'text']);
  assert.equal(sent[2].content[0].tool_use_id, 'toolu_1');
  assert.deepEqual(sent[2].content[2].cache_control, { type: 'ephemeral' }, 'rolling cache breakpoint on the newest block');
});

test('messages without providerContent: assistant text + tool_use rebuilt; a later system note becomes user text; empty turns padded', () => {
  const { system, messages } = toAnthropicMessages([
    { role: 'system', content: 'a' }, { role: 'system', content: 'b' },
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'calling', toolCalls: [{ id: 'c1', name: 't', arguments: 'not json' }] },
    { role: 'tool', toolCallId: 'c1', content: '' },
    { role: 'system', content: 'mid' },
    { role: 'assistant', content: null },
  ]);
  assert.equal(system, 'a\n\nb');
  assert.deepEqual(messages[1].content, [{ type: 'text', text: 'calling' }, { type: 'tool_use', id: 'c1', name: 't', input: {} }]);
  assert.deepEqual(messages[2].content, [{ type: 'tool_result', tool_use_id: 'c1', content: '(empty)' }, { type: 'text', text: '[System note] mid' }]);
  assert.deepEqual(messages[3], { role: 'assistant', content: [{ type: 'text', text: '…', cache_control: { type: 'ephemeral' } }] });
});

test('usage and cost: cache reads and writes counted, llm_prices first, static map as the fallback', async () => {
  const http = fakeHttp([reply([{ type: 'text', text: 'x' }]), reply([{ type: 'text', text: 'y' }], 'max_tokens')]);
  const seen: any[] = [];
  const prices = { estimate: async (provider: string, model: string, u: any) => { seen.push({ provider, model, u }); return { costUsd: 0.123, source: 'estimate' as const }; } };
  const r = await client(http, prices).chat({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'x' }] });
  assert.deepEqual(r.usage, { promptTokens: 10_000, completionTokens: 500, costUsd: 0.123 });
  assert.deepEqual(seen[0], { provider: 'anthropic', model: 'claude-sonnet-5-5', u: { tokensIn: 10_000, tokensOut: 500, tokensCachedRead: 9000, tokensCachedWrite: 0 } });
  const r2 = await client(http).chat({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r2.finishReason, 'length');
  // 1000 × $2 + 9000 × $0.10 + 500 × $10 per 1M = 0.002 + 0.0009 + 0.005
  assert.equal(r2.usage.costUsd, 0.0079);
  assert.equal(staticCost('claude-opus-5-5', { tokensIn: 2_000_000, tokensOut: 0, tokensCachedRead: 0, tokensCachedWrite: 1_000_000 }), 9);
});

test('retries 429 / 529 / network, then succeeds; a 400 (credit balance) throws at once with the API message', async () => {
  const http = fakeHttp([{ status: 529, data: { error: { message: 'Overloaded' } } }, { networkError: true }, reply([{ type: 'text', text: 'ok' }])]);
  const r = await client(http).chat({ model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.message.content, 'ok');
  assert.equal(http.calls.length, 3);

  const bad = fakeHttp([{ status: 400, data: { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } } }]);
  await assert.rejects(() => client(bad).chat({ model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'x' }] }),
    (e: any) => e.status === 400 && /Anthropic request failed \(400\): Your credit balance is too low/.test(e.message));
  assert.equal(bad.calls.length, 1);
});

test('no key → a clear error before any request', async () => {
  const http = fakeHttp([]);
  const c = new AnthropicClient({ apiKey: undefined, http: { post: http.post } });
  await assert.rejects(() => c.chat({ model: 'claude-sonnet-5-5', messages: [] }), /Anthropic API key is not set/);
  assert.equal(http.calls.length, 0);
});

test('RoutingLlmClient sends each request to its workspace', async () => {
  const hits: string[] = [];
  const fake = (name: string): LlmClient => ({ chat: async (r: LlmRequest) => { hits.push(`${name}:${r.model}`); return { message: { role: 'assistant', content: name }, finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 } }; } });
  const router = new RoutingLlmClient({ openrouter: fake('or'), anthropic: fake('an') });
  await router.chat({ model: 'z-ai/glm-5.3-flash', messages: [] });
  await router.chat({ model: 'z-ai/glm-5.3', messages: [], provider: 'openrouter' });
  await router.chat({ model: 'claude-sonnet-5-5', messages: [], provider: 'anthropic' });
  assert.deepEqual(hits, ['or:z-ai/glm-5.3-flash', 'or:z-ai/glm-5.3', 'an:claude-sonnet-5-5']);
});

test('run trace: raw provider blocks are not stored; the thinking text is kept, capped', async () => {
  const { traceMessage } = await import('../harness/run-recorder');
  const msg = { role: 'assistant' as const, content: 'ok', toolCalls: [{ id: 't1', name: 'x', arguments: '{}' }],
    providerContent: [{ type: 'thinking', thinking: 'Plan: '.padEnd(5000, 'x'), signature: 'sig' }, { type: 'text', text: 'ok' }] };
  const t = traceMessage(msg);
  assert.equal(t.providerContent, undefined);
  assert.equal((t.thinking as string).length, 4000);
  assert.deepEqual(traceMessage({ role: 'assistant', content: 'plain' }), { role: 'assistant', content: 'plain' });
});

test('a history that opens with the agent\'s reply gets a user turn first', () => {
  const { messages } = toAnthropicMessages([{ role: 'system', content: 's' }, { role: 'assistant', content: 'Hi, I am @ai0.' }, { role: 'user', content: 'go' }]);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user']);
});
