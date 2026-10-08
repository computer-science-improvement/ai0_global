import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_EDITOR_MODEL, EDITOR_ROLES, envModelKey, estimateCostUsd, pickModel, pickReasoningEffort, resolveModel, type ModelSource,
} from './model-registry';

const noEnv = () => undefined;

test('defaults to glm-5.3-flash with role limits', () => {
  const p = resolveModel('executor', noEnv);
  assert.equal(p.model, DEFAULT_EDITOR_MODEL);
  assert.equal(p.source, 'default');
  assert.equal(p.inPerM, 0.15);
  assert.equal(p.maxTokens, 6000);
  assert.equal(p.reasoningEffort, 'low');
});

test('spec 035: with no config every role (incl. idea_reviewer) runs z-ai/glm-5.3-flash', () => {
  assert.equal(DEFAULT_EDITOR_MODEL, 'z-ai/glm-5.3-flash');
  for (const role of EDITOR_ROLES) {
    const p = resolveModel(role, noEnv);
    assert.equal(p.model, 'z-ai/glm-5.3-flash', role);
    assert.equal(p.source, 'default', role);
  }
  assert.equal(resolveModel('idea_reviewer', noEnv, null, { defaultModel: null }).model, 'z-ai/glm-5.3-flash');
});

test('env override beats default', () => {
  const p = resolveModel('planner', (k) => (k === 'EDITOR_MODEL_PLANNER' ? 'z-ai/glm-5.3' : undefined));
  assert.equal(p.model, 'z-ai/glm-5.3');
  assert.equal(p.source, 'env');
  assert.equal(p.outPerM, 3.39);
});

test('channel override beats env', () => {
  const p = resolveModel('planner', () => 'z-ai/glm-5.3', { planner: 'z-ai/glm-5.3-flashx' });
  assert.equal(p.model, 'z-ai/glm-5.3-flashx');
  assert.equal(p.source, 'channel');
});

test('precedence and source for every combination: agent → channel → env → global default → built-in', () => {
  const layers = ['agent', 'channel', 'env', 'default'] as const;
  for (let mask = 0; mask < 16; mask++) {
    const on = (i: number) => (mask & (1 << i)) !== 0;
    const env = (k: string) => (on(2) && k === envModelKey('reviewer') ? 'env/model' : undefined);
    const p = pickModel('reviewer', env, on(1) ? { reviewer: 'channel/model' } : null, {
      agentModel: on(0) ? 'agent/model' : null,
      defaultModel: on(3) ? 'default/model' : null,
    });
    const first = layers.findIndex((_, i) => on(i));
    const want: { model: string; source: ModelSource } = first === -1
      ? { model: DEFAULT_EDITOR_MODEL, source: 'default' }
      : { model: `${layers[first]}/model`, source: layers[first] };
    assert.deepEqual(p, want, `mask ${mask.toString(2)}`);
  }
});

test('blank values are ignored at every layer; a channel override for another role does not apply', () => {
  const p = pickModel('executor', () => '  ', { planner: 'x/planner', executor: ' ' }, { agentModel: '', defaultModel: '  ' });
  assert.deepEqual(p, { model: DEFAULT_EDITOR_MODEL, source: 'default' });
  assert.deepEqual(pickModel('executor', noEnv, null, { defaultModel: 'owner/pick' }), { model: 'owner/pick', source: 'default' });
});

test('unknown model falls back to default price', () => {
  const p = resolveModel('checker', () => 'some/unknown');
  assert.equal(p.model, 'some/unknown');
  assert.equal(p.inPerM, 0.15);
});

test('estimateCostUsd', () => {
  assert.equal(estimateCostUsd({ inPerM: 0.15, outPerM: 0.5 }, 1_000_000, 2_000_000), 1.15);
});

test('reasoning effort: role default, global env, per-role env', () => {
  assert.equal(resolveModel('planner', () => undefined).reasoningEffort, 'medium');
  assert.equal(resolveModel('planner', (k) => (k === 'EDITOR_REASONING' ? 'low' : undefined)).reasoningEffort, 'low');
  assert.equal(resolveModel('planner', (k) => ({ EDITOR_REASONING: 'low', EDITOR_REASONING_PLANNER: 'high' } as any)[k]).reasoningEffort, 'high');
  assert.equal(resolveModel('executor', () => 'bogus').reasoningEffort, 'low');
});

test('reasoning effort: the agent setting beats env and the role default', () => {
  const env = (k: string) => ({ EDITOR_REASONING_PLANNER: 'low' } as any)[k];
  assert.equal(resolveModel('planner', env, null, { reasoningEffort: 'high' }).reasoningEffort, 'high');
  assert.deepEqual(pickReasoningEffort('planner', env, null), { effort: 'low', source: 'env' });
  assert.deepEqual(pickReasoningEffort('planner', noEnv, 'bogus' as any), { effort: 'medium', source: 'default' });
  assert.deepEqual(pickReasoningEffort('planner', noEnv, 'low'), { effort: 'low', source: 'agent' });
});
