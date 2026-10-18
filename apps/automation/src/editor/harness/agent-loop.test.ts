import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { AgentLoop, decodeJsonStrings } from './agent-loop';
import { defineTool } from './tool';
import { FakeBudget, FakeLlm, MemoryRecorder } from './testing/fakes';
import { resolveModel } from '../llm/model-registry';

const model = resolveModel('executor', () => undefined);

const echo = defineTool({
  name: 'echo', description: 'echo back', kind: 'read', roles: ['executor'],
  input: z.object({ text: z.string() }),
  execute: async ({ text }) => ({ echoed: text }),
});
const boom = defineTool({
  name: 'boom', description: 'throws', kind: 'read', roles: ['executor'],
  input: z.object({}), execute: async () => { throw new Error('kaput'); },
});
const slow = defineTool({
  name: 'slow', description: 'never resolves', kind: 'read', roles: ['executor'],
  input: z.object({}), execute: () => new Promise(() => {}),
});
let published: any[] = [];
const publish = defineTool({
  name: 'publish', description: 'terminal', kind: 'terminal', roles: ['executor'],
  input: z.object({ title: z.string().min(1) }),
  execute: async (i) => { if (i.title === 'bad') return { error: 'lint_failed' }; published.push(i); return { ok: true, id: 7 }; },
});

function loop(llm: FakeLlm, opts: { budget?: FakeBudget; enabled?: boolean; toolTimeoutMs?: number } = {}) {
  const recorder = new MemoryRecorder();
  const l = new AgentLoop({ llm, recorder, budget: opts.budget ?? new FakeBudget(), enabled: () => opts.enabled ?? true, toolTimeoutMs: opts.toolTimeoutMs });
  return { l, recorder };
}
const input = (extra: any = {}) => ({ role: 'executor' as const, channelKey: 'ch', model, system: 's', user: 'u', tools: [echo, boom, slow, publish], ...extra });

test('stops on successful terminal tool and records totals', async () => {
  published = [];
  const llm = new FakeLlm([
    { calls: [{ name: 'echo', args: { text: 'a' } }] },
    { calls: [{ name: 'publish', args: { title: 'Hello' } }] },
  ]);
  const { l, recorder } = loop(llm);
  const res = await l.run(input());
  assert.equal(res.status, 'ok');
  assert.equal(res.terminalTool, 'publish');
  assert.deepEqual(res.terminalResult, { ok: true, id: 7 });
  assert.equal(published.length, 1);
  assert.equal(recorder.runs[0].status, 'ok');
  assert.equal(recorder.runs[0].totals!.steps, 4); // 2 llm + 2 tool
  assert.equal(res.totals.promptTokens, 200);
  // tool result fed back to the model
  const second = llm.requests[1].messages;
  assert.equal(second[second.length - 1].role, 'tool');
  assert.match((second[second.length - 1] as any).content, /echoed/);
});

test('terminal tool returning an error does not end the run', async () => {
  const llm = new FakeLlm([
    { calls: [{ name: 'publish', args: { title: 'bad' } }] },
    { calls: [{ name: 'publish', args: { title: 'good' } }] },
  ]);
  const res = await loop(llm).l.run(input());
  assert.equal(res.status, 'ok');
  assert.equal(llm.requests.length, 2);
});

test('invalid args, invalid json, unknown tool and throwing tool are returned as errors', async () => {
  const llm = new FakeLlm([
    { calls: [
      { name: 'echo', args: { text: 5 } },
      { name: 'echo', args: '{not json' },
      { name: 'rm_rf', args: {} },
      { name: 'boom', args: {} },
    ] },
    { calls: [{ name: 'publish', args: { title: 'ok' } }] },
  ]);
  const { l, recorder } = loop(llm);
  const res = await l.run(input());
  assert.equal(res.status, 'ok');
  const errs = recorder.steps.filter((s) => s.type === 'tool' && s.isError).map((s) => (s.output as any).error);
  assert.deepEqual(errs, ['invalid_args', 'invalid_json', 'tool_not_allowed', 'tool_failed']);
});

test('tool timeout becomes tool_failed', async () => {
  const llm = new FakeLlm([
    { calls: [{ name: 'slow', args: {} }] },
    { calls: [{ name: 'publish', args: { title: 'ok' } }] },
  ]);
  const { l, recorder } = loop(llm, { toolTimeoutMs: 20 });
  await l.run(input());
  const step = recorder.steps.find((s) => s.tool === 'slow')!;
  assert.match((step.output as any).details, /timed out/);
});

test('max steps', async () => {
  // Spec 053: research on the last turn is answered `last_turn` and buys one grace turn.
  const llm = new FakeLlm(Array.from({ length: 4 }, () => ({ calls: [{ name: 'echo', args: { text: 'x' } }] })));
  const res = await loop(llm).l.run(input({ maxSteps: 3 }));
  assert.equal(res.status, 'max_steps');
  assert.equal(llm.requests.length, 4);
});

test('spec 053: the last turn keeps every tool (cache prefix), says in text that only a terminal tool counts', async () => {
  published = [];
  const llm = new FakeLlm([
    { calls: [{ name: 'echo', args: { text: 'x' } }] },
    { calls: [{ name: 'echo', args: { text: 'y' } }] },
    { calls: [{ name: 'publish', args: { title: 'Last' } }] },
  ]);
  const res = await loop(llm).l.run(input({ maxSteps: 3 }));
  assert.equal(res.status, 'ok');
  assert.equal(res.terminalTool, 'publish');
  assert.deepEqual(llm.requests[2].tools, llm.requests[0].tools, 'one tool list for the whole run');
  const last = llm.requests[2].messages.at(-1) as any;
  assert.equal(last.role, 'user');
  assert.match(last.content, /останній крок.*publish/i);
});

test('spec 053: research on the last turn is not run; one grace turn, then the run ends', async () => {
  published = [];
  const { l, recorder } = loop(new FakeLlm([
    { calls: [{ name: 'echo', args: { text: 'x' } }] },
    { calls: [{ name: 'echo', args: { text: 'late' } }] },
    { calls: [{ name: 'publish', args: { title: 'Grace' } }] },
  ]));
  const res = await l.run(input({ maxSteps: 2 }));
  assert.equal(res.status, 'ok');
  assert.equal(res.terminalTool, 'publish');
  const late = recorder.steps.find((x: any) => x.tool === 'echo' && (x.output as any)?.error);
  assert.equal((late!.output as any).error, 'last_turn');

  const never = loop(new FakeLlm(Array.from({ length: 4 }, () => ({ calls: [{ name: 'echo', args: { text: 'z' } }] }))));
  const r2 = await never.l.run(input({ maxSteps: 2 }));
  assert.equal(r2.status, 'max_steps');
  assert.equal(never.recorder.steps.filter((x: any) => x.type === 'llm').length, 3, '2 turns + 1 grace, never more');
});

test('a role without terminal tools keeps every tool on its last turn', async () => {
  const llm = new FakeLlm(Array.from({ length: 2 }, () => ({ calls: [{ name: 'echo', args: { text: 'x' } }] })));
  await loop(llm).l.run(input({ maxSteps: 2, tools: [echo] }));
  assert.deepEqual(llm.requests[1].tools!.map((t: any) => t.name), ['echo']);
});

test('budget exhausted mid-run stops before next LLM call', async () => {
  const llm = new FakeLlm([{ calls: [{ name: 'echo', args: { text: 'x' } }] }]);
  const budget = new FakeBudget([{ ok: true }, { ok: false, scope: 'channel', spentUsd: 0.6, limitUsd: 0.5 }]);
  const { l, recorder } = loop(llm, { budget });
  const res = await l.run(input());
  assert.equal(res.status, 'budget_exceeded');
  assert.equal(llm.requests.length, 1);
  assert.equal(recorder.runs[0].status, 'budget_exceeded');
});

test('text answer gets one nudge, then ends no_terminal with finalText (spec 040 FR-003: a role with terminal tools)', async () => {
  const llm = new FakeLlm([{ text: 'я думаю…' }, { text: 'все' }]);
  const res = await loop(llm).l.run(input());
  assert.equal(res.status, 'no_terminal');
  assert.equal(res.finalText, 'все');
  assert.equal(res.terminalTool, undefined);
  assert.match((llm.requests[1].messages.at(-1) as any).content, /publish/);
});

test('LLM failure ends the run as error without throwing', async () => {
  const llm = new FakeLlm([new Error('OpenRouter request failed (500)')]);
  const res = await loop(llm).l.run(input());
  assert.equal(res.status, 'error');
  assert.match(res.error!, /500/);
});

test('disabled harness does not start a run', async () => {
  const { l, recorder } = loop(new FakeLlm([]), { enabled: false });
  const res = await l.run(input());
  assert.equal(res.status, 'disabled');
  assert.equal(recorder.runs.length, 0);
});

test('tools are sent as JSON-schema specs', async () => {
  const llm = new FakeLlm([{ calls: [{ name: 'publish', args: { title: 'x' } }] }]);
  await loop(llm).l.run(input());
  const names = llm.requests[0].tools!.map((t) => t.name);
  assert.deepEqual(names, ['echo', 'boom', 'slow', 'publish']);
  assert.equal((llm.requests[0].tools![0].parameters as any).properties.text.type, 'string');
});

// ── multi-turn history and streaming events (spec 010 FR-002) ───────────────

test('history turns sit between the system prompt and the new user message', async () => {
  const llm = new FakeLlm([{ text: 'Готово' }]);
  const { l } = loop(llm);
  const res = await l.run(input({
    tools: [echo],
    history: [{ role: 'user', content: 'перше питання' }, { role: 'assistant', content: 'перша відповідь' }],
    user: 'друге питання',
  }));
  assert.equal(res.status, 'ok');
  assert.equal(res.finalText, 'Готово');
  const msgs = llm.requests[0].messages.map((m: any) => [m.role, m.content]);
  assert.deepEqual(msgs, [['system', 's'], ['user', 'перше питання'], ['assistant', 'перша відповідь'], ['user', 'друге питання']]);
});

test('history drops non-text turns and keeps only the last 20', async () => {
  const llm = new FakeLlm([{ text: 'ok' }]);
  const { l } = loop(llm);
  const history: any[] = Array.from({ length: 25 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
  history.push({ role: 'system', content: 'sneaky' }, { role: 'tool', toolCallId: 'x', content: 'y' });
  await l.run(input({ tools: [], history }));
  const msgs = llm.requests[0].messages;
  assert.equal(msgs.length, 1 + 20 + 1);
  assert.equal((msgs[1] as any).content, 'm5');
  assert.ok(msgs.slice(1, -1).every((m: any) => m.role === 'user' || m.role === 'assistant'));
});

test('onEvent streams text, tool calls and tool results; no terminal tools means text ends the run', async () => {
  const events: any[] = [];
  const llm = new FakeLlm([
    { text: 'Шукаю…', calls: [{ name: 'echo', args: { text: 'a' } }, { name: 'boom', args: {} }] },
    { text: 'Ось чернетка' },
  ]);
  const { l } = loop(llm);
  const res = await l.run(input({ tools: [echo, boom], onEvent: (e: any) => { events.push(e); } }));
  assert.equal(res.status, 'ok');
  assert.equal(res.finalText, 'Ось чернетка');
  assert.deepEqual(events.map((e) => e.type), ['llm_text', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'llm_text']);
  assert.deepEqual(events[1], { type: 'tool_call', name: 'echo', args: { text: 'a' } });
  assert.equal(events[2].ok, true);
  assert.match(events[2].summary, /echoed/);
  assert.deepEqual([events[4].name, events[4].ok], ['boom', false]);
  assert.match(events[4].summary, /tool_failed/);
});

test('a throwing onEvent never breaks the run', async () => {
  const llm = new FakeLlm([{ calls: [{ name: 'echo', args: { text: 'a' } }] }, { text: 'done' }]);
  const { l } = loop(llm);
  const res = await l.run(input({ tools: [echo], onEvent: () => { throw new Error('client gone'); } }));
  assert.equal(res.status, 'ok');
  assert.equal(res.finalText, 'done');
});

test('empty answer cut by max_tokens (reasoning ate the budget) is retried, not treated as final', async () => {
  const llm = new FakeLlm([
    { text: '', finish: 'length' },
    { calls: [{ name: 'publish', args: { title: 'ok' } }] },
  ]);
  const res = await loop(llm).l.run(input());
  assert.equal(res.status, 'ok');
  assert.equal(res.terminalTool, 'publish');
  assert.match((llm.requests[1].messages.at(-1) as any).content, /обірвалась/);
  assert.equal(llm.requests[0].reasoningEffort, 'low');
});

test('truncation retries are capped', async () => {
  const llm = new FakeLlm([{ text: '', finish: 'length' }, { text: '', finish: 'length' }, { text: '', finish: 'length' }, { text: 'все' }]);
  const res = await loop(llm).l.run(input());
  assert.equal(llm.requests.length, 4); // 2 truncation retries + 1 nudge + final
  assert.equal(res.status, 'no_terminal');
});

test('spec 034: a tool error with _grantSteps extends the run once (capped at 3 turns); a per-tool timeoutMs beats the default', async () => {
  let n = 0;
  const gated = defineTool({
    name: 'gated', description: 'terminal behind a critic', kind: 'terminal', roles: ['executor'], input: z.object({}),
    execute: async () => (++n <= 2 ? { error: 'critic_revise', _grantSteps: 99 } : { ok: true }),
  });
  const call = (name: string, args: unknown = {}) => ({ calls: [{ name, args }] });
  const llm = new FakeLlm([call('gated'), call('gated'), call('echo', { text: 'x' }), call('gated'), call('gated')]);
  const res = await loop(llm).l.run(input({ tools: [echo, gated], maxSteps: 1 }));
  // Turn 0 is the last one → an error with a grant → 3 more turns (capped); the second error grants nothing.
  assert.equal(llm.requests.length, 4);
  assert.equal(res.status, 'ok');
  assert.equal(res.terminalTool, 'gated');
  assert.deepEqual(llm.requests[2].tools!.map((t) => t.name), ['echo', 'gated']);
  assert.deepEqual(llm.requests[3].tools!.map((t) => t.name), ['echo', 'gated'], 'spec 053: the granted last turn keeps the list too');

  const patient = defineTool({
    name: 'patient', description: 'slow but allowed', kind: 'read', roles: ['executor'], input: z.object({}), timeoutMs: 500,
    execute: () => new Promise<any>((r) => setTimeout(() => r({ ok: true }), 40)),
  });
  const llm2 = new FakeLlm([call('patient'), call('publish', { title: 't' })]);
  const { l, recorder } = loop(llm2, { toolTimeoutMs: 10 });
  await l.run(input({ tools: [patient, publish] }));
  const step = recorder.steps.find((s) => s.tool === 'patient')!;
  assert.equal(step.isError, false, JSON.stringify(step.output));
});

test('spec 038: an Anthropic-workspace profile sends provider anthropic and checks provider caps for it; OpenRouter sends none', async () => {
  published = [];
  const providers: Array<string | undefined> = [];
  const budget = new FakeBudget();
  budget.check = async (...args: any[]) => { providers.push(args[3]); return { ok: true }; };
  const llm = new FakeLlm([{ calls: [{ name: 'publish', args: { title: 'A' } }] }, { calls: [{ name: 'publish', args: { title: 'B' } }] }]);
  const { l } = loop(llm, { budget });
  await l.run(input({ model: resolveModel('executor', () => undefined, null, { workspace: 'anthropic' }) }));
  await l.run(input());
  assert.deepEqual(llm.requests.map((r) => [r.model, r.provider]), [['claude-sonnet-5-5', 'anthropic'], ['z-ai/glm-5.3-flash', undefined]]);
  assert.deepEqual(providers, ['anthropic', 'openrouter']);
});

test('046: nested objects sent as JSON strings (even with a leaked tool-call tag) are read as objects', async () => {
  let got: any = null;
  const setup = defineTool({
    name: 'setup', description: 'nested', kind: 'terminal', roles: ['executor'],
    input: z.object({ summary: z.string(), schedule: z.object({ per_day: z.number(), hours: z.array(z.number()) }), note: z.string().optional() }),
    execute: async (i) => { got = i; return { ok: true }; },
  });
  const llm = new FakeLlm([{ calls: [{ name: 'setup', args: {
    summary: '{не JSON, а текст}', schedule: '{"per_day": 3, "hours": "[9, 19]"}</parameter>\n</invoke>', note: '',
  } }] }]);
  const res = await loop(llm).l.run(input({ tools: [setup] }));
  assert.equal(res.status, 'ok');
  assert.deepEqual(got, { summary: '{не JSON, а текст}', schedule: { per_day: 3, hours: [9, 19] } });
  const plain = { a: 'text', b: ['x'] };
  assert.equal(decodeJsonStrings(plain), plain, 'nothing to decode → the same object');
});
