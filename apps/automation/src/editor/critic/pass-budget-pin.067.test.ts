/**
 * Spec 067 FR-003 / FR-004 (T3): one critic level per slot and the real pass cap, at the gate and the service.
 * (The runner side — budgets handed to each attempt, the level recorded on the step — is in silent/fallback-ladder.test.ts.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../harness/agent-loop';
import { FakeBudget, FakeLlm, MemoryRecorder } from '../harness/testing/fakes';
import { makeSpec } from '../post/testing/fixtures';
import { CRITIC_SCORE_KEYS, type CriticScores } from './critic';
import { CriticService } from './critic.service';
import { CriticGate, type CriticGateContext } from './critic-gate';

const all = (n: number): CriticScores => Object.fromEntries(CRITIC_SCORE_KEYS.map((k) => [k, n])) as CriticScores;
const answer = (verdict: string, args: Record<string, unknown> = {}) =>
  ({ calls: [{ name: 'submit_critique', args: { scores: all(5), verdict, notes: 'Добре.', ...args } }] });
const revise = (extra: Record<string, unknown> = {}) => answer('revise', { scores: { ...all(5), ai_likeness: 3 }, notes: 'Прибери штамп.', ...extra });
const FIXED = { previous_checks: [{ n: 1, fixed: true }] };

/** A high-risk draft (an external source and numbers) and a low-risk rewrite (a library fact, no numbers). */
const HIGH_SPEC = makeSpec({ origin: 'external', source: { url: 'https://techcrunch.com/a' } });
const HIGH_TEXT = 'Компанія заявила про 17 нових моделей.';
const LOW_SPEC = makeSpec({ origin: 'library', library_ref: 'data://facts/0', title: 'Перепис' });
const LOW_TEXT = 'Галюцинація — коли модель вигадує факт.';

function rig(turns: ConstructorParameters<typeof FakeLlm>[0], ctx: Partial<CriticGateContext> = {}) {
  const llm = new FakeLlm(turns);
  const loop = new AgentLoop({ llm, recorder: new MemoryRecorder(), budget: new FakeBudget(), enabled: () => true });
  const service = new CriticService({
    loop, env: (k) => (k === 'EDITOR_MODEL_CHECKER_LIGHT' ? 'light/model' : undefined),
    defaultModel: async () => 'z-ai/glm-5.3-flash', criticModel: async () => 'strong/model', now: () => new Date('2026-10-27T09:00:00Z'),
  });
  const updates: any[] = [];
  const gate = new CriticGate(
    { critic: service, plans: { updateSlot: async (_id: string, p: any) => { updates.push(p); } } },
    { slotId: 's1', channelKey: '@c', mode: 'live', resourceRef: 'telegram:@c', platform: 'telegram', voice: { style: { content_kind: 'news' } as any }, ...ctx },
  );
  const stored = () => updates.filter((u) => u.critic).at(-1)?.critic;
  return { llm, gate, updates, stored };
}
const post = (spec: unknown, text: string) => ({ text, spec, format: 'text', warnings: [] as Array<{ code: string; message: string }> });

// ── FR-003: sticky high ─────────────────────────────────────────────────────

test('067 pin: a high first pass keeps the strong model for the rewrite even when the rewrite is low risk; without the pin it flips to the light one', async () => {
  const pinned = rig([revise(), answer('pass', FIXED)]);
  assert.equal((await pinned.gate.check(post(HIGH_SPEC, HIGH_TEXT))).kind, 'revise');
  assert.equal((await pinned.gate.check(post(LOW_SPEC, LOW_TEXT))).kind, 'proceed');
  assert.deepEqual(pinned.llm.requests.map((r) => r.model), ['strong/model', 'strong/model']);
  const s = pinned.stored();
  assert.deepEqual([s.route.level, s.route.model], ['high', 'strong/model']);
  assert.deepEqual(s.route.factors.includes('pinned'), true, 'the stored level says it was held, not earned');
  assert.equal(s.history[0].route.level, 'high');

  // The control: the first pass was low, so the rewrite is read by the light model (the pin only ever holds a high level).
  const free = rig([revise(), answer('pass', FIXED)]);
  await free.gate.check(post(LOW_SPEC, LOW_TEXT));
  await free.gate.check(post(makeSpec({ origin: 'library', library_ref: 'data://facts/0', title: 'Другий' }), 'Інший факт без чисел.'));
  assert.deepEqual(free.llm.requests.map((r) => r.model), ['light/model', 'light/model']);
  assert.equal(free.stored().route.level, 'low');
});

test('067 pin: a level carried into the run (an earlier ladder step was high) starts the first pass at the strong model; a high draft gets no `pinned` factor', async () => {
  const carried = rig([answer('pass')], { pinLevel: 'high' });
  await carried.gate.check(post(LOW_SPEC, LOW_TEXT));
  assert.equal(carried.llm.requests[0].model, 'strong/model');
  const s = carried.stored();
  assert.deepEqual([s.route.level, s.route.factors.includes('pinned')], ['high', true]);

  const high = rig([answer('pass')], { pinLevel: 'high' });
  await high.gate.check(post(HIGH_SPEC, HIGH_TEXT));
  assert.equal(high.stored().route.level, 'high');
  assert.equal(high.stored().route.factors.includes('pinned'), false, 'it was high on its own');

  const none = rig([answer('pass')]);
  await none.gate.check(post(LOW_SPEC, LOW_TEXT));
  assert.equal(none.llm.requests[0].model, 'light/model');
});

test('067 pin: the pin is a level, not a model id — a changed owner critic model is still the one used', async () => {
  const llm = new FakeLlm([answer('pass')]);
  const loop = new AgentLoop({ llm, recorder: new MemoryRecorder(), budget: new FakeBudget(), enabled: () => true });
  const service = new CriticService({ loop, env: (k) => (k === 'EDITOR_MODEL_CHECKER_LIGHT' ? 'light/model' : undefined), defaultModel: async () => 'z-ai/glm-5.3-flash', criticModel: async () => 'owner/new-critic' });
  const gate = new CriticGate({ critic: service, plans: { updateSlot: async () => {} } },
    { slotId: 's1', channelKey: '@c', mode: 'live', resourceRef: 'telegram:@c', platform: 'telegram', voice: {}, pinLevel: 'high' });
  await gate.check(post(LOW_SPEC, LOW_TEXT));
  assert.equal(llm.requests[0].model, 'owner/new-critic');
});

// ── FR-004: the pass budget ─────────────────────────────────────────────────

test('067 budget 2 (the default): a first revise goes back for one rewrite; the second pass decides', async () => {
  // The rewrite did not fix the item of the first pass: the second look is a revise → a skip.
  const t = rig([revise(), revise({ notes: 'Досі штамп.', previous_checks: [{ n: 1, fixed: false }] })]);
  assert.equal((await t.gate.check(post(HIGH_SPEC, HIGH_TEXT))).kind, 'revise');
  const out = await t.gate.check(post(LOW_SPEC, LOW_TEXT));
  assert.equal(out.kind, 'halt');
  assert.match(t.updates.at(-1).error, /^critic_rejected: second revise — /);
  assert.match(t.stored().reason, /^second_revise: /);
  assert.equal(t.llm.requests.length, 2);
});

test('067 budget 1: a first revise is final — live and shadow skip with cap_revise and keep the verdict `revise`; approval proceeds with final: true; one critic run', async () => {
  for (const mode of ['live', 'shadow'] as const) {
    const t = rig([revise(), answer('pass')], { mode, passBudget: 1 });
    const out = await t.gate.check(post(HIGH_SPEC, HIGH_TEXT));
    assert.equal(out.kind, 'halt', mode);
    assert.equal(t.llm.requests.length, 1, 'no rewrite, no second pass');
    const last = t.updates.at(-1);
    assert.equal(last.status, 'skipped');
    assert.match(last.error, /^critic_rejected: cap_revise — revise \(ai_likeness 3\): Прибери штамп/);
    assert.equal(last.critic.verdict, 'revise', 'the ladder still reads it as a fixable revise');
    assert.match(last.critic.reason, /^cap_revise: /);
    assert.equal((out as any).result.critic_rejected, true);
  }
  const a = rig([revise()], { mode: 'approve', passBudget: 1 });
  const out = await a.gate.check(post(HIGH_SPEC, HIGH_TEXT));
  assert.equal(out.kind, 'proceed');
  assert.deepEqual([a.stored().verdict, a.stored().final, a.stored().pass], ['revise', true, 1]);
  assert.equal(a.llm.requests.length, 1);
});

test('067 budget 1: a reject is a reject, a pass is a pass, and an edit that does not match goes out as written (no rewrite is left)', async () => {
  const rej = rig([answer('reject', { scores: { ...all(5), sense: 1 }, notes: 'Не про тему.' })], { passBudget: 1 });
  assert.equal((await rej.gate.check(post(HIGH_SPEC, HIGH_TEXT))).kind, 'halt');
  assert.match(rej.updates.at(-1).error, /^critic_rejected: reject \(sense 1\)/);

  const ok = rig([answer('pass')], { passBudget: 1 });
  assert.equal((await ok.gate.check(post(HIGH_SPEC, HIGH_TEXT))).kind, 'proceed');

  const edit = rig([answer('pass_with_edits', { edits: [{ from: 'нема такого', to: 'немає того' }] })], { passBudget: 1 });
  const out = await edit.gate.check({ ...post(HIGH_SPEC, HIGH_TEXT), relint: async () => ({ ok: true }) });
  assert.equal(out.kind, 'proceed');
  assert.equal(edit.stored().edits_failed[0].found, 0);
});

test('067 budget: a nonsense value (0, NaN, a fraction) is a single pass at least', async () => {
  for (const passBudget of [0, -3, 0.5]) {
    const t = rig([revise()], { passBudget });
    assert.equal((await t.gate.check(post(HIGH_SPEC, HIGH_TEXT))).kind, 'halt', String(passBudget));
    assert.equal(t.llm.requests.length, 1);
  }
});
