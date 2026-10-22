/** Spec 064 FR-003 / FR-004 / FR-005 / FR-007: the loop's friction fixes — grace turns, host-keyed breaker, elision gist, result cap. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { AgentLoop, callHost } from './agent-loop';
import { defineTool, toToolSpec } from './tool';
import { FakeBudget, FakeLlm, MemoryRecorder } from './testing/fakes';
import { resolveModel } from '../llm/model-registry';
import { elideOldToolResults, TOOL_CONTEXT_MAX_CHARS } from './context-trim';
import { TOOL_RESULT_MAX_CHARS, toToolContent, truncateJson } from './truncate';
import { CLIP_MARK, clipLong, longText } from './clip-text';
import { SubmitPlanInput } from '../roles/plan-rules';
import { CritiqueInput } from '../critic/critic';
import type { ChatMessage } from '../llm/llm.types';

const model = resolveModel('planner', () => undefined);

function loop(llm: FakeLlm) {
  const recorder = new MemoryRecorder();
  return { l: new AgentLoop({ llm, recorder, budget: new FakeBudget(), enabled: () => true }), recorder };
}

// ── FR-003: grace turns on a terminal tool's error ────────────────────────────────────────────────────────────────

function submitter(okAtCall: number) {
  let n = 0;
  return defineTool({
    name: 'submit_plan', description: 't', kind: 'terminal', roles: ['planner'], input: z.object({ v: z.number() }),
    execute: async () => (++n >= okAtCall ? { ok: true } : { error: 'plan_invalid', details: ['fix the times'] }),
  });
}
const attempts = (k: number) => Array.from({ length: k }, (_, i) => ({ calls: [{ name: 'submit_plan', args: { v: i } }] }));

test('FR-003: a plan_invalid on the last turn leaves one more turn to fix it', async () => {
  const llm = new FakeLlm(attempts(3));
  const res = await loop(llm).l.run({ role: 'planner', channelKey: 'ch', model, system: 's', user: 'u', tools: [submitter(3)], maxSteps: 2 });
  assert.equal(res.status, 'ok');
  assert.equal(llm.requests.length, 3, 'two planned turns plus the granted one');
});

test('FR-003: at most two such turns per run, then the run ends max_steps', async () => {
  const llm = new FakeLlm(attempts(8));
  const res = await loop(llm).l.run({ role: 'planner', channelKey: 'ch', model, system: 's', user: 'u', tools: [submitter(99)], maxSteps: 2 });
  assert.equal(res.status, 'max_steps');
  assert.equal(llm.requests.length, 4, '2 + 2 granted');
});

test('FR-003: an error before the last turn grants nothing', async () => {
  const llm = new FakeLlm(attempts(3));
  const res = await loop(llm).l.run({ role: 'planner', channelKey: 'ch', model, system: 's', user: 'u', tools: [submitter(2)], maxSteps: 5 });
  assert.equal(res.status, 'ok');
  assert.equal(llm.requests.length, 2);
});

test('FR-003: series may be null in a slot; long free text is cut with a mark, not rejected', () => {
  const slot = { time: '10:00', format: 'text', topic: 'т'.repeat(450), series: null };
  const parsed = SubmitPlanInput.parse({ rationale: 'достатньо довге пояснення', slots: [slot] });
  assert.equal(parsed.slots[0].series, null);
  assert.equal(parsed.slots[0].topic!.length, 300);
  assert.ok(parsed.slots[0].topic!.endsWith(CLIP_MARK));
  assert.equal(SubmitPlanInput.parse({ rationale: 'достатньо довге пояснення', slots: [{ ...slot, topic: 'коротка тема', series: undefined }] }).slots[0].topic, 'коротка тема');
  // Too short is still an error (only the upper limit became a cut).
  assert.throws(() => SubmitPlanInput.parse({ rationale: 'достатньо довге пояснення', slots: [{ ...slot, topic: 'ab' }] }));
  const spec = toToolSpec(defineTool({ name: 'submit_plan', description: 'd', kind: 'terminal', roles: ['planner'], input: SubmitPlanInput, execute: async () => ({ ok: true }) }));
  assert.match(JSON.stringify(spec.parameters), /до 300 символів, довше буде обрізано/, 'the limit is in the tool description');
});

test('FR-003: critique notes and any longText are cut at their limit', () => {
  const scores = { ai_likeness: 4, sense: 4, voice: 4, grounding: 4, audience_asks: 4, format_fit: 4, language: 4 };
  const c = CritiqueInput.parse({ scores, verdict: 'pass', notes: 'н'.repeat(1200) });
  assert.equal(c.notes.length, 800);
  assert.ok(c.notes.endsWith(CLIP_MARK));
  assert.equal(longText(3, 10).parse('коротко'), 'коротко');
  assert.equal(clipLong('abc', 2).length <= 2 + CLIP_MARK.length, true);
});

test('FR-003: invalid_json says why; a nested JSON string that does not parse says why', async () => {
  const t = defineTool({ name: 'obj', description: 'd', kind: 'read', roles: ['planner'], input: z.object({ plan: z.object({ a: z.number() }) }), execute: async () => ({ ok: true }) });
  const llm = new FakeLlm([
    { calls: [{ name: 'obj', args: '{"plan": {' }] },
    { calls: [{ name: 'obj', args: { plan: '{"a": 1,, }' } }] },
    { text: 'done' },
  ]);
  const { l, recorder } = loop(llm);
  await l.run({ role: 'planner', channelKey: 'ch', model, system: 's', user: 'u', tools: [t] });
  const out = recorder.steps.filter((x) => x.type === 'tool').map((x) => x.output as any);
  assert.equal(out[0].error, 'invalid_json');
  assert.match(out[0].details, /JSON\.parse: .+/);
  assert.equal(out[1].error, 'invalid_args');
  assert.match(out[1].details[0].message, /does not parse: .+/);
});

// ── FR-004: the breaker keys web_fetch by host ────────────────────────────────────────────────────────────────────

test('FR-004: callHost reads the url of a fetch tool only', () => {
  assert.equal(callHost('web_fetch', '{"url":"https://www.Bad.test/x?y=1"}'), 'bad.test');
  assert.equal(callHost('fetch_feed', '{"url":"http://feed.test/rss"}'), 'feed.test');
  assert.equal(callHost('query_data', '{"url":"https://bad.test"}'), null);
  assert.equal(callHost('web_fetch', '{"url":"not a url"}'), null);
  assert.equal(callHost('web_fetch', 'garbage'), null);
});

test('FR-004: three errors on one host switch off web_fetch for that host only', async () => {
  const fetchTool = defineTool({
    name: 'web_fetch', description: 'd', kind: 'read', roles: ['executor'], input: z.object({ url: z.string().url() }),
    execute: async ({ url }) => (url.includes('bad.test') ? { error: 'host_blocked', details: 'bad.test: refused' } : { title: 'ok page' }),
  });
  const done = defineTool({ name: 'done', description: 't', kind: 'terminal', roles: ['executor'], input: z.object({}), execute: async () => ({ ok: true }) });
  const llm = new FakeLlm([
    { calls: [1, 2, 3].map((i) => ({ name: 'web_fetch', args: { url: `https://bad.test/${i}` } })) },
    { calls: [{ name: 'web_fetch', args: { url: 'https://bad.test/4' } }, { name: 'web_fetch', args: { url: 'https://good.test/a' } }] },
    { calls: [{ name: 'done', args: {} }] },
  ]);
  const { l, recorder } = loop(llm);
  const res = await l.run({ role: 'executor', channelKey: 'ch', model: resolveModel('executor', () => undefined), system: 's', user: 'u', tools: [fetchTool, done] });
  assert.equal(res.status, 'ok');
  const steps = recorder.steps.filter((x) => x.tool === 'web_fetch');
  assert.equal((steps[3].output as any).error, 'tool_dropped', 'bad.test is off');
  assert.match((steps[3].output as any).details, /off for bad\.test.*other sites still work/);
  assert.deepEqual(steps[4].output, { title: 'ok page' }, 'another host still answers');
  assert.deepEqual(recorder.runs[0].breaker!.toolsDropped, ['web_fetch@bad.test'], 'the tool itself stays on');
  // The tool stays on the list for the next request, and the model was told which host went.
  assert.ok(llm.requests[2].tools!.some((t) => t.name === 'web_fetch'));
  const note = llm.requests[1].messages.filter((m) => m.role === 'user').at(-1)!;
  assert.match(String(note.content), /web_fetch для bad\.test вимкнено/);
});

// ── FR-005: the elision stub keeps the gist ───────────────────────────────────────────────────────────────────────

test('FR-005: an elided result keeps the call arguments and a one-line gist', () => {
  const msgs: ChatMessage[] = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];
  const names = new Map<string, string>();
  const args = new Map<string, string>();
  const body = (i: number) => JSON.stringify({ title: `Стаття ${i}`, text: 'a'.repeat(9_000) });
  for (let i = 0; i < 6; i++) {
    const id = `c${i}`;
    msgs.push({ role: 'assistant', content: null, toolCalls: [{ id, name: i % 2 ? 'web_fetch' : 'fetch_feed', arguments: `{"url":"https://x.test/${i}"}` }] });
    msgs.push({ role: 'tool', toolCallId: id, content: i === 2 ? JSON.stringify({ text: `${'Початок статті. '.repeat(30)}`, pad: 'a'.repeat(9_000) }) : body(i) });
    names.set(id, i % 2 ? 'web_fetch' : 'fetch_feed');
    args.set(id, `{"url":"https://x.test/${i}"}`);
  }
  assert.ok(elideOldToolResults(msgs, (id) => names.get(id), { argsOf: (id) => args.get(id) }) >= 2);
  const tools = msgs.filter((m) => m.role === 'tool') as Array<{ content: string }>;
  const first = JSON.parse(tools[0].content);
  assert.equal(first.elided, true);
  assert.equal(first.args, '{"url":"https://x.test/0"}');
  assert.equal(first.gist, 'Стаття 0', 'the title when the result has one');
  assert.match(first.note, /Повторний виклик лише якщо потрібні деталі/);
  assert.doesNotMatch(first.note, /виклич інструмент знову/);
  const noTitle = JSON.parse(tools[2].content);
  assert.ok(noTitle.gist.startsWith('{"text":"Початок статті.'), 'else the start of the output');
  assert.ok(noTitle.gist.length <= 160);
});

test('FR-005: a run elides with args in the stub (the loop passes them)', async () => {
  const fat = defineTool({
    name: 'web_fetch', description: 'big read', kind: 'read', roles: ['executor'], input: z.object({ url: z.string().url() }),
    execute: async ({ url }) => ({ title: `Page ${url}`, text: 'б'.repeat(7_500) }),
  });
  const done = defineTool({ name: 'done', description: 't', kind: 'terminal', roles: ['executor'], input: z.object({}), execute: async () => ({ ok: true }) });
  const turns = [...Array.from({ length: 7 }, (_, i) => ({ calls: [{ name: 'web_fetch', args: { url: `https://p.test/${i}` } }] })), { calls: [{ name: 'done', args: {} }] }];
  const llm = new FakeLlm(turns);
  const res = await loop(llm).l.run({ role: 'executor', channelKey: 'ch', model: resolveModel('executor', () => undefined), system: 's', user: 'u', tools: [fat, done], maxSteps: 10 });
  assert.equal(res.status, 'ok');
  const stub = (llm.requests.at(-1)!.messages.filter((m) => m.role === 'tool') as Array<{ content: string }>).map((m) => m.content).find((c) => c.includes('"elided":true'))!;
  assert.match(stub, /"args":"\{\\"url\\":\\"https:\/\/p\.test\/0\\"\}"/);
  assert.match(stub, /"gist":"Page https:\/\/p\.test\/0"/);
  assert.ok(TOOL_CONTEXT_MAX_CHARS > 0);
});

// ── FR-007: the cap includes the wrapper ──────────────────────────────────────────────────────────────────────────

test('FR-007: a stored tool result, wrapper and escapes included, never exceeds the cap; dropped rows are counted', () => {
  const rows = Array.from({ length: 80 }, (_, i) => ({ id: i, title: `Пост "${i}"`, text: 'з "лапками" та \\ слешами '.repeat(8) }));
  const out = truncateJson({ ok: true, rows });
  assert.ok(JSON.stringify(out).length <= TOOL_RESULT_MAX_CHARS, String(JSON.stringify(out).length));
  const r = (out as any).rows as unknown[];
  assert.match(String(r.at(-1)), /^\[\d+ more items omitted\]$/);
  assert.equal(Number(/\d+/.exec(String(r.at(-1)))![0]) + r.length - 1, 80);
  // Not fittable by rows (one giant escaped string at the top level of a bare string): the wrapper itself is capped.
  const bare = truncateJson('"quoted" '.repeat(3000));
  assert.ok(JSON.stringify(bare).length <= TOOL_RESULT_MAX_CHARS, String(JSON.stringify(bare).length));
  assert.equal((bare as any).truncated, true);
  // Small values pass through untouched; the model-facing content is capped too, marker included.
  const small = { a: 1 };
  assert.equal(truncateJson(small), small);
  assert.ok(toToolContent('"q" '.repeat(5000), 500).length <= 500);
});
