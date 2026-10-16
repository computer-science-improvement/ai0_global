/** Spec 040: the loop's per-run cost cap, circuit breaker and honest endings. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { AgentLoop } from './agent-loop';
import { defineTool } from './tool';
import { FakeBudget, FakeLlm, MemoryRecorder } from './testing/fakes';
import { resolveModel } from '../llm/model-registry';
import { failureText } from '../chat/editor-chat.service';

const model = resolveModel('composer', () => undefined);

const note = defineTool({
  name: 'note', description: 'writes a note', kind: 'act', roles: ['composer'],
  input: z.object({ text: z.string() }), execute: async () => ({ ok: true }),
});

function loop(llm: FakeLlm) {
  const recorder = new MemoryRecorder();
  return { l: new AgentLoop({ llm, recorder, budget: new FakeBudget(), enabled: () => true }), recorder };
}

test('FR-001: a run stops before the next LLM call once its own cost reaches maxCostUsd; the reply says what was done', async () => {
  const llm = new FakeLlm([
    { text: 'Дивлюсь розклад.', calls: [{ name: 'note', args: { text: 'a' } }], cost: 0.2 },
    { calls: [{ name: 'note', args: { text: 'b' } }], cost: 0.15 },
    { text: 'never' },
  ]);
  const { l, recorder } = loop(llm);
  const res = await l.run({ role: 'composer', channelKey: null, model, system: 's', user: 'u', tools: [note], maxCostUsd: 0.3 });
  assert.equal(res.status, 'budget_exceeded');
  assert.equal(llm.requests.length, 2);
  assert.match(res.error!, /^turn budget: \$0\.3500 >= \$0\.3/);
  assert.deepEqual(res.toolsOk, ['note', 'note']);
  assert.equal(res.lastText, 'Дивлюсь розклад.');
  assert.equal(recorder.runs[0].status, 'budget_exceeded');
  const text = failureText(res);
  assert.match(text, /per-turn chat cap \(\$0\.350 of \$0\.3\)/);
  assert.match(text, /Done in this turn: note\./);
  assert.match(text, /Where I stopped:\nДивлюсь розклад\./);
  assert.doesNotMatch(text, /Message not processed/);
});

test('FR-001: no cap (null or 0) never stops a run', async () => {
  for (const maxCostUsd of [null, 0]) {
    const llm = new FakeLlm([{ calls: [{ name: 'note', args: { text: 'a' } }], cost: 5 }, { text: 'done' }]);
    const res = await loop(llm).l.run({ role: 'composer', channelKey: null, model, system: 's', user: 'u', tools: [note], maxCostUsd });
    assert.equal(res.status, 'ok');
    assert.equal(res.finalText, 'done');
  }
});

test('FR-001: a budget verdict with a key names it in the run error', async () => {
  const llm = new FakeLlm([{ text: 'never' }]);
  const l = new AgentLoop({ llm, recorder: new MemoryRecorder(), budget: new FakeBudget([{ ok: false, scope: 'feature', spentUsd: 1.1, limitUsd: 1, key: 'editor.chat' }]), enabled: () => true });
  const res = await l.run({ role: 'composer', channelKey: null, model, system: 's', user: 'u', tools: [] });
  assert.equal(res.error, 'feature budget (editor.chat): $1.1000 >= $1');
  assert.match(failureText(res), /agents chat daily cap/);
});

const failing = defineTool({
  name: 'add_idea', description: 'always a duplicate', kind: 'act', roles: ['composer'],
  input: z.object({ title: z.string() }), execute: async ({ title }) => ({ error: 'duplicate_idea', details: `«${title}» is already in the pool` }),
});
let runs = 0;
const counted = defineTool({
  name: 'fetch', description: 'fails on a', kind: 'read', roles: ['composer'],
  input: z.object({ url: z.string(), n: z.number().optional() }),
  execute: async ({ url }) => { runs++; return url === 'a' ? { error: 'http_404' } : { ok: true }; },
});
const finishTool = defineTool({
  name: 'finish', description: 'terminal', kind: 'terminal', roles: ['composer'],
  input: z.object({ summary: z.string().min(5) }), execute: async () => ({ ok: true }),
});

test('FR-002: an identical failed call (keys in any order) is not run again; a changed call is', async () => {
  runs = 0;
  const llm = new FakeLlm([
    { calls: [{ name: 'fetch', args: { url: 'a', n: 1 } }] },
    { calls: [{ name: 'fetch', args: '{"n":1,"url":"a"}' }] },
    { calls: [{ name: 'fetch', args: { url: 'b', n: 1 } }] },
    { text: 'done' },
  ]);
  const { l, recorder } = loop(llm);
  const res = await l.run({ role: 'composer', channelKey: null, model, system: 's', user: 'u', tools: [counted] });
  assert.equal(res.status, 'ok');
  assert.equal(runs, 2, 'the repeat never reached the tool');
  const repeat = recorder.steps.filter((x) => x.type === 'tool')[1];
  assert.equal((repeat.output as any).error, 'repeated_failed_call');
  assert.match((repeat.output as any).details, /^http_404 — this exact call already failed/);
  assert.deepEqual(recorder.runs[0].breaker, { repeatBlocked: 1, toolsDropped: [] });
});

test('FR-002: the same (tool, code) three times drops the tool for the rest of the run, with one note to the model', async () => {
  const llm = new FakeLlm([
    { calls: [{ name: 'add_idea', args: { title: 'A' } }, { name: 'add_idea', args: { title: 'B' } }] },
    { calls: [{ name: 'add_idea', args: { title: 'C' } }] },
    { calls: [{ name: 'add_idea', args: { title: 'D' } }] },
    { calls: [{ name: 'finish', args: { summary: 'pool is full of these' } }] },
  ]);
  const { l, recorder } = loop(llm);
  const res = await l.run({ role: 'composer', channelKey: null, model, system: 's', user: 'u', tools: [failing, finishTool] });
  assert.equal(res.status, 'ok');
  assert.equal(res.terminalTool, 'finish');
  // Errors 1–2 in the first turn, the third in the second: from the third request on, add_idea is gone and the note says why.
  assert.deepEqual(llm.requests[1].tools!.map((t) => t.name), ['add_idea', 'finish']);
  assert.deepEqual(llm.requests[2].tools!.map((t) => t.name), ['finish']);
  const lastUser = llm.requests[2].messages.filter((m) => m.role === 'user').at(-1)!;
  assert.match(String(lastUser.content), /add_idea вимкнено до кінця цього прогону: 3 помилки «duplicate_idea»/);
  // A call to a dropped tool is answered without running it.
  assert.equal((recorder.steps.filter((x) => x.tool === 'add_idea').at(-1)!.output as any).error, 'tool_dropped');
  assert.deepEqual(recorder.runs[0].breaker, { repeatBlocked: 0, toolsDropped: ['add_idea'] });
});

test('FR-002: a terminal tool is never dropped, whatever its errors', async () => {
  const llm = new FakeLlm([
    { calls: [{ name: 'finish', args: { summary: 'x' } }] },
    { calls: [{ name: 'finish', args: { summary: 'y' } }] },
    { calls: [{ name: 'finish', args: { summary: 'z' } }] },
    { calls: [{ name: 'finish', args: { summary: 'finally ok' } }] },
  ]);
  const res = await loop(llm).l.run({ role: 'composer', channelKey: null, model, system: 's', user: 'u', tools: [finishTool], maxSteps: 6 });
  assert.equal(res.status, 'ok');
  assert.ok(llm.requests.every((r) => r.tools!.some((t) => t.name === 'finish')));
});

test('FR-003: a role with terminal tools that answers in text ends no_terminal, not ok', async () => {
  const llm = new FakeLlm([{ text: 'Я все зробив.' }, { text: 'Справді все.' }]);
  const { l, recorder } = loop(llm);
  const res = await l.run({ role: 'composer', channelKey: null, model, system: 's', user: 'u', tools: [finishTool] });
  assert.equal(res.status, 'no_terminal');
  assert.equal(recorder.runs[0].status, 'no_terminal');
  assert.equal(res.finalText, 'Справді все.');
});

test('FR-003: an empty 0-token completion is asked again once', async () => {
  const empty = new FakeLlm([{ text: null, cost: 0 }, { text: 'answer' }]);
  (empty as any).chat = ((orig) => async (req: any) => {
    const r = await orig(req);
    if (!r.message.content) r.usage.completionTokens = 0;
    return r;
  })(empty.chat.bind(empty));
  const res = await loop(empty).l.run({ role: 'composer', channelKey: null, model, system: 's', user: 'u', tools: [] });
  assert.equal(res.status, 'ok');
  assert.equal(res.finalText, 'answer');
  assert.equal(empty.requests.length, 2);
  assert.equal(empty.requests[1].messages.length, 2, 'the empty turn is not kept in the conversation');
});

test('FR-003: the chat never shows a raw status', () => {
  const zero = { steps: 1, promptTokens: 1, completionTokens: 0, costUsd: 0 };
  assert.equal(failureText({ runId: 'r', status: 'ok', totals: zero, finalText: '' }), 'The agent stopped without an answer (empty reply). Try again or rephrase.');
  assert.equal(failureText({ runId: 'r', status: 'ok', totals: zero, lastText: 'Ось що я знайшов: …' }), 'Ось що я знайшов: …');
  assert.match(failureText({ runId: 'r', status: 'error', totals: zero, error: 'fetch failed' }), /^The agent stopped without an answer \(fetch failed\)/);
  assert.doesNotMatch(failureText({ runId: 'r', status: 'no_terminal', totals: zero }), /no_terminal|Something went wrong/);
});
