import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenRouterClient } from './openrouter.client';

function fakeHttp(responses: Array<{ status?: number; data?: any; networkError?: boolean }>) {
  const calls: Array<{ url: string; body: any; headers: any }> = [];
  const post = async (url: string, body: any, cfg: any) => {
    calls.push({ url, body, headers: cfg.headers });
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

const ok = (message: any, usage: any = { prompt_tokens: 100, completion_tokens: 20, cost: 0.0001 }) =>
  ({ data: { choices: [{ message, finish_reason: 'stop' }], usage } });

function client(http: ReturnType<typeof fakeHttp>) {
  return new OpenRouterClient({ apiKey: 'k', baseUrl: 'https://or.test/api/v1', http: { post: http.post }, sleep: async () => {} });
}

test('sends OpenAI-shaped request with tools and maps messages', async () => {
  const http = fakeHttp([ok({ role: 'assistant', content: 'hi' })]);
  await client(http).chat({
    model: 'z-ai/glm-5.3-flash',
    maxTokens: 500, temperature: 0.5,
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 't', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c1', content: '{"ok":true}' },
    ],
    tools: [{ name: 't', description: 'd', parameters: { type: 'object', properties: {} } }],
  });
  const { url, body, headers } = http.calls[0];
  assert.equal(url, 'https://or.test/api/v1/chat/completions');
  assert.equal(headers.Authorization, 'Bearer k');
  assert.equal(body.model, 'z-ai/glm-5.3-flash');
  assert.equal(body.max_tokens, 500);
  assert.equal(body.tools[0].type, 'function');
  assert.equal(body.tools[0].function.name, 't');
  assert.deepEqual(body.messages[1].tool_calls, [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }]);
  assert.deepEqual(body.messages[2], { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' });
});

test('parses tool calls and usage cost', async () => {
  const http = fakeHttp([ok({
    role: 'assistant', content: null,
    tool_calls: [{ id: 'x', type: 'function', function: { name: 'get_stats', arguments: '{"days":7}' } }],
  }, { prompt_tokens: 1000, completion_tokens: 50, cost: 0.00042 })]);
  const res = await client(http).chat({ model: 'z-ai/glm-5.3-flash', messages: [{ role: 'user', content: 'q' }] });
  assert.deepEqual(res.message.toolCalls, [{ id: 'x', name: 'get_stats', arguments: '{"days":7}' }]);
  assert.equal(res.usage.promptTokens, 1000);
  assert.equal(res.usage.costUsd, 0.00042);
});

test('falls back to registry price when usage.cost is absent', async () => {
  const http = fakeHttp([ok({ role: 'assistant', content: 'x' }, { prompt_tokens: 1_000_000, completion_tokens: 0 })]);
  const res = await client(http).chat({ model: 'z-ai/glm-5.3-flash', messages: [{ role: 'user', content: 'q' }] });
  assert.equal(res.usage.costUsd, 0.15);
});

test('retries on 429 and network errors, then succeeds', async () => {
  const http = fakeHttp([{ status: 429 }, { networkError: true }, ok({ role: 'assistant', content: 'done' })]);
  const res = await client(http).chat({ model: 'm', messages: [{ role: 'user', content: 'q' }] });
  assert.equal(res.message.content, 'done');
  assert.equal(http.calls.length, 3);
});

test('does not retry on 400', async () => {
  const http = fakeHttp([{ status: 400, data: { error: { message: 'bad' } } }]);
  await assert.rejects(client(http).chat({ model: 'm', messages: [{ role: 'user', content: 'q' }] }), /400/);
  assert.equal(http.calls.length, 1);
});

test('gives up after 3 attempts on 5xx', async () => {
  const http = fakeHttp([{ status: 502 }, { status: 503 }, { status: 500 }]);
  await assert.rejects(client(http).chat({ model: 'm', messages: [{ role: 'user', content: 'q' }] }));
  assert.equal(http.calls.length, 3);
});

test('throws when api key missing', async () => {
  const c = new OpenRouterClient({ apiKey: undefined, http: { post: async () => ({}) as any } });
  await assert.rejects(c.chat({ model: 'm', messages: [] }), /OPENROUTER_API_KEY/);
});
