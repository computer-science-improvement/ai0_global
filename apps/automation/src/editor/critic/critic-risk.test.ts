/** Spec 041 FR-007 (T7): the draft's risk routes the critic — light model for low risk, the strong one for high. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftRisk } from './critic-risk';
import { lightCheckerModel } from '../llm/model-registry';
import { CriticService } from './critic.service';
import { CriticGate } from './critic-gate';
import { AgentLoop } from '../harness/agent-loop';
import { FakeBudget, FakeLlm, MemoryRecorder } from '../harness/testing/fakes';
import { CRITIC_SCORE_KEYS } from './critic';
import { makeSpec } from '../post/testing/fixtures';

test('draftRisk: external news with numbers, quotes and names is high; an evergreen library post is low', () => {
  const news = draftRisk({
    spec: { origin: 'external', source: { url: 'https://techcrunch.com/x' } },
    text: 'За словами віцепрезидента Ларса Моравʼі, 10 прискорювачів працюють від 600 літрів повітря.', contentKind: 'news',
  });
  assert.equal(news.level, 'high');
  assert.deepEqual(news.factors, ['external_source', 'numbers', 'quotes', 'persons', 'news']);
  assert.equal(news.score, 7);
  const evergreen = draftRisk({ spec: { origin: 'library', library_ref: 'data://facts/0' }, text: 'Галюцинація — коли модель впевнено вигадує факт.' });
  assert.equal(evergreen.level, 'low');
  assert.equal(evergreen.score, -1);
  // An external post without numbers or quotes sits just below the line; a number tips it over.
  assert.equal(draftRisk({ spec: { origin: 'external', source: { url: 'https://x.com/a' } }, text: 'Steam тестує набори досягнень.' }).level, 'low');
  assert.equal(draftRisk({ spec: { origin: 'external', source: { url: 'https://x.com/a' } }, text: 'Steam тестує набори в 17 іграх.' }).level, 'high');
});

test('lightCheckerModel: Haiku in the Anthropic workspace, an env override, none on OpenRouter by default', () => {
  assert.equal(lightCheckerModel(() => undefined, 'anthropic'), 'claude-haiku-5-5');
  assert.equal(lightCheckerModel((k) => (k === 'EDITOR_ANTHROPIC_MODEL_CHECKER_LIGHT' ? 'claude-sonnet-5-5' : undefined), 'anthropic'), 'claude-sonnet-5-5');
  assert.equal(lightCheckerModel(() => undefined, 'openrouter'), null);
  assert.equal(lightCheckerModel((k) => (k === 'EDITOR_MODEL_CHECKER_LIGHT' ? 'z-ai/glm-5.3-flash' : undefined)), 'z-ai/glm-5.3-flash');
});

test('gate: a low-risk draft goes to the light model, a high-risk one to the owner\'s critic model; route and total cost on the slot', async () => {
  const pass = { calls: [{ name: 'submit_critique', args: { scores: Object.fromEntries(CRITIC_SCORE_KEYS.map((k) => [k, 5])), verdict: 'pass', notes: 'Добре.' } }] };
  const run = async (spec: unknown, text: string) => {
    const llm = new FakeLlm([pass]);
    const loop = new AgentLoop({ llm, recorder: new MemoryRecorder(), budget: new FakeBudget(), enabled: () => true });
    const service = new CriticService({
      loop, env: (k) => (k === 'EDITOR_MODEL_CHECKER_LIGHT' ? 'light/model' : undefined),
      defaultModel: async () => 'z-ai/glm-5.3-flash', criticModel: async () => 'strong/model', now: () => new Date('2026-10-17T09:00:00Z'),
    });
    const updates: any[] = [];
    const gate = new CriticGate({ critic: service, plans: { updateSlot: async (_id: string, p: any) => { updates.push(p); } } },
      { slotId: 's', channelKey: '@c', mode: 'live', resourceRef: 'telegram:@c', platform: 'telegram', voice: { style: { content_kind: 'news' } as any } });
    await gate.check({ text, spec, format: 'text', warnings: [] });
    return { model: llm.requests[0].model, stored: updates.at(-1).critic };
  };
  const low = await run({ origin: 'library', library_ref: 'data://facts/0' }, 'Галюцинація — коли модель вигадує факт.');
  assert.equal(low.model, 'light/model');
  assert.deepEqual([low.stored.route.level, low.stored.route.model], ['low', 'light/model']);
  const high = await run(makeSpec({ origin: 'external', source: { url: 'https://techcrunch.com/a' } }), 'Маск заявив: «виробництво почнеться у 2028 році».');
  assert.equal(high.model, 'strong/model');
  assert.equal(high.stored.route.level, 'high');
  assert.equal(typeof high.stored.cost_total_usd, 'number');
});
