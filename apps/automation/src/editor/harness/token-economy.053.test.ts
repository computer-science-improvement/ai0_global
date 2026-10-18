import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { AgentLoop } from './agent-loop';
import { defineTool } from './tool';
import { FakeBudget, FakeLlm, MemoryRecorder } from './testing/fakes';
import { resolveModel } from '../llm/model-registry';
import { TOOL_RESULT_MAX_CHARS, fitJson, toToolContent } from './truncate';
import { TOOL_CONTEXT_MAX_CHARS, TOOL_CONTEXT_TARGET_CHARS, elideOldToolResults } from './context-trim';
import { AnthropicClient } from '../llm/anthropic.client';
import { OpenRouterClient, needsCacheMarks, withCacheMarks } from '../llm/openrouter.client';
import type { ChatMessage } from '../llm/llm.types';
import { costFromPrice, longPromptMultiplier } from '../../common/ai/usage/price.service';
import { staticCost } from '../llm/anthropic.client';

/** Spec 053 FR-002 / FR-003 / FR-009: cache hygiene, tool results that do not pile up, OpenRouter parity. */

const model = resolveModel('executor', () => undefined);

test('tool results shrink by rows: valid JSON, an «[N more items omitted]» marker, the cap holds', () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ id: i, title: `Пост номер ${i}`, text: 'х'.repeat(120) }));
  const out = toToolContent({ ok: true, rows });
  assert.ok(out.length <= TOOL_RESULT_MAX_CHARS, String(out.length));
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.rows[0].id, 0, 'the first rows stay');
  assert.match(parsed.rows.at(-1), /^\[\d+ more items omitted\]$/);
  const kept = parsed.rows.length - 1;
  assert.equal(Number(/\d+/.exec(parsed.rows.at(-1))![0]) + kept, 200);
  // A long page text is cut, not the JSON.
  const page = toToolContent({ url: 'https://x.test/a', text: 'слово '.repeat(4000) });
  assert.ok(JSON.parse(page).text.includes('…[cut '));
  // A tool may ask for more (load_skill).
  assert.equal(toToolContent({ body: 'a'.repeat(9000) }, 12_000).length, 9000 + '{"body":""}'.length);
  assert.equal(fitJson('just a string', 5), null, 'a bare string falls back to the plain cut');
});

test('old tool results give way to stubs in one batch; the newest turn and the newest result of each tool stay', () => {
  const big = (n: number) => JSON.stringify({ text: 'a'.repeat(n) });
  const msgs: ChatMessage[] = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];
  const names = new Map<string, string>();
  for (let i = 0; i < 6; i++) {
    msgs.push({ role: 'assistant', content: null, toolCalls: [{ id: `c${i}`, name: i % 2 ? 'web_fetch' : 'list_ideas', arguments: '{}' }] });
    msgs.push({ role: 'tool', toolCallId: `c${i}`, content: big(9_000) });
    names.set(`c${i}`, i % 2 ? 'web_fetch' : 'list_ideas');
  }
  const before = msgs.filter((m) => m.role === 'tool').reduce((s, m) => s + (m as any).content.length, 0);
  assert.ok(before > TOOL_CONTEXT_MAX_CHARS);
  const n = elideOldToolResults(msgs, (id) => names.get(id));
  assert.ok(n >= 3);
  const tools = msgs.filter((m) => m.role === 'tool') as Array<{ content: string }>;
  const after = tools.reduce((s, m) => s + m.content.length, 0);
  assert.ok(after <= TOOL_CONTEXT_TARGET_CHARS, String(after));
  assert.match(tools[0].content, /"elided":true,"tool":"list_ideas","chars":9011/);
  assert.ok(!tools[5].content.includes('elided') && !tools[4].content.includes('elided'), 'the newest of each tool stays');
  assert.equal(elideOldToolResults(msgs, (id) => names.get(id)), 0, 'under the cap: nothing changes, the cache holds');
});

test('the loop elides before the step that would carry too much; an aborted run stops before the next step', async () => {
  const fat = defineTool({
    name: 'fat', description: 'big read', kind: 'read', roles: ['executor'], input: z.object({ i: z.number() }),
    execute: async ({ i }) => ({ i, text: 'б'.repeat(7_500) }),
  });
  const done = defineTool({ name: 'done', description: 't', kind: 'terminal', roles: ['executor'], input: z.object({}), execute: async () => ({ ok: true }) });
  const turns = [...Array.from({ length: 7 }, (_, i) => ({ calls: [{ name: 'fat', args: { i } }] })), { calls: [{ name: 'done', args: {} }] }];
  const llm = new FakeLlm(turns);
  const l = new AgentLoop({ llm, recorder: new MemoryRecorder(), budget: new FakeBudget(), enabled: () => true });
  const res = await l.run({ role: 'executor', channelKey: 'ch', model, system: 's', user: 'u', tools: [fat, done], maxSteps: 10 });
  assert.equal(res.status, 'ok');
  const lastReq = llm.requests.at(-1)!.messages.filter((m) => m.role === 'tool') as Array<{ content: string }>;
  assert.ok(lastReq.some((m) => m.content.includes('"elided":true')));
  assert.ok(lastReq.reduce((s, m) => s + m.content.length, 0) <= TOOL_CONTEXT_MAX_CHARS);

  const ctl = new AbortController();
  const llm2 = new FakeLlm([{ calls: [{ name: 'fat', args: { i: 1 } }] }, { calls: [{ name: 'done', args: {} }] }]);
  const seen: any[] = [];
  const l2 = new AgentLoop({ llm: { chat: async (r) => { seen.push(r); ctl.abort(); return llm2.chat(r); } }, recorder: new MemoryRecorder(), budget: new FakeBudget(), enabled: () => true });
  const r2 = await l2.run({ role: 'checker', channelKey: 'ch', model, system: 's', user: 'u', tools: [fat, done], cache: false, signal: ctl.signal });
  assert.equal(r2.status, 'error');
  assert.match(r2.error!, /aborted/);
  assert.equal(llm2.requests.length, 1);
  assert.equal(seen[0].cache, false);
  assert.equal(seen[0].signal, ctl.signal);
});

test('Anthropic: cache: false sends no breakpoints; tools TTL 1h only when configured', () => {
  const req = { model: 'claude-sonnet-5-5', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'u' }] as ChatMessage[], tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }] };
  const c = new AnthropicClient({ apiKey: 'k' });
  const cached = JSON.stringify(c.body(req));
  assert.equal((cached.match(/cache_control/g) ?? []).length, 3);
  assert.ok(!JSON.stringify(c.body({ ...req, cache: false })).includes('cache_control'));
  const hour = new AnthropicClient({ apiKey: 'k', toolsCacheTtl: '1h' }).body(req) as any;
  assert.deepEqual(hour.tools[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.deepEqual(hour.system[0].cache_control, { type: 'ephemeral' });
});

test('OpenRouter: Claude / Gemini get cache marks (system + newest message), others and cache: false do not; cache writes logged', async () => {
  assert.ok(needsCacheMarks('anthropic/claude-sonnet-5.5') && needsCacheMarks('google/gemini-3-pro'));
  assert.ok(!needsCacheMarks('z-ai/glm-5.3-flash'));
  const marked = withCacheMarks([{ role: 'system', content: 'sys' }, { role: 'user', content: 'u' }, { role: 'assistant', content: null }, { role: 'tool', tool_call_id: 'x', content: '{}' }]);
  assert.deepEqual(marked[0].content, [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }]);
  assert.equal(marked[1].content, 'u', 'only the newest message carries the rolling mark');
  assert.deepEqual(marked[3].content, [{ type: 'text', text: '{}', cache_control: { type: 'ephemeral' } }]);

  const bodies: any[] = [];
  const rows: any[] = [];
  const usage = { start: () => ({ ok: (t: any) => rows.push(t), fail: () => {} }) } as any;
  const http = { post: async (_u: string, body: any) => { bodies.push(body); return { data: { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5, cost: 0.001, prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 30 } } } }; } };
  const c = new OpenRouterClient({ apiKey: 'k', http, usage, sleep: async () => {} });
  const msgs: ChatMessage[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'u' }];
  await c.chat({ model: 'anthropic/claude-sonnet-5.5', messages: msgs });
  await c.chat({ model: 'z-ai/glm-5.3-flash', messages: msgs });
  await c.chat({ model: 'anthropic/claude-sonnet-5.5', messages: msgs, cache: false });
  assert.ok(JSON.stringify(bodies[0]).includes('cache_control'));
  assert.ok(!JSON.stringify(bodies[1]).includes('cache_control'));
  assert.ok(!JSON.stringify(bodies[2]).includes('cache_control'));
  assert.equal(rows[0].tokensCachedWrite, 30);
  assert.equal(rows[0].tokensCachedRead, 60);
});

test('Haiku 5.5 above 100K prompt tokens pays the long-prompt tier (5×), in the ledger price and the static fallback', () => {
  const row = { provider: 'anthropic', model: 'claude-haiku-5-5', inPerM: 0.1, outPerM: 0.5, cachedReadPerM: 0.01, cachedWritePerM: 0.125, perRequestUsd: null, effectiveFrom: '2026-10-01' };
  const small = { tokensIn: 100_000, tokensOut: 1_000, tokensCachedRead: 0, tokensCachedWrite: 0 };
  const big = { ...small, tokensIn: 100_001 };
  assert.equal(costFromPrice(row, small), 0.0105);
  assert.equal(costFromPrice(row, big), Math.round(5 * (100_001 * 0.1 + 1_000 * 0.5) / 1e6 * 1e6) / 1e6);
  assert.equal(longPromptMultiplier('anthropic/claude-haiku-5.5', 150_000), 5);
  assert.equal(longPromptMultiplier('claude-sonnet-5-5', 150_000), 1);
  assert.equal(staticCost('claude-haiku-5-5', big), costFromPrice(row, big));
});

test('step caps hold the same on both workspaces: maxSteps counts model turns, plus one grace turn after a blocked last call', async () => {
  const read = defineTool({ name: 'look', description: 'r', kind: 'read', roles: ['idea_reviewer'], input: z.object({}), execute: async () => ({ ok: true }) });
  const done = defineTool({ name: 'done', description: 't', kind: 'terminal', roles: ['idea_reviewer'], input: z.object({}), execute: async () => ({ ok: true }) });
  for (const workspace of ['openrouter', 'anthropic'] as const) {
    const llm = new FakeLlm(Array.from({ length: 40 }, () => ({ calls: [{ name: 'look', args: {} }, { name: 'look', args: {} }] })));
    const recorder = new MemoryRecorder();
    const l = new AgentLoop({ llm, recorder, budget: new FakeBudget(), enabled: () => true });
    const m = resolveModel('idea_reviewer', () => undefined, null, { workspace });
    const res = await l.run({ role: 'idea_reviewer', channelKey: 'ch', model: m, system: 's', user: 'u', tools: [read, done], maxSteps: 6 });
    assert.equal(res.status, 'max_steps', workspace);
    assert.equal(llm.requests.length, 7, `${workspace}: 6 turns + 1 grace`);
    // editor_runs.steps counts tool steps too — 2 calls a turn make ~3× the turn count (the "50 steps on a cap of 25").
    assert.ok(res.totals.steps > llm.requests.length);
  }
});
