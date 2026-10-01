import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_EDITOR_MODEL, estimateCostUsd, resolveModel } from './model-registry';

const noEnv = () => undefined;

test('defaults to glm-5.3-flash with role limits', () => {
  const p = resolveModel('executor', noEnv);
  assert.equal(p.model, DEFAULT_EDITOR_MODEL);
  assert.equal(p.inPerM, 0.15);
  assert.equal(p.maxTokens, 3000);
});

test('env override beats default', () => {
  const p = resolveModel('planner', (k) => (k === 'EDITOR_MODEL_PLANNER' ? 'z-ai/glm-5.3' : undefined));
  assert.equal(p.model, 'z-ai/glm-5.3');
  assert.equal(p.outPerM, 3.39);
});

test('channel override beats env', () => {
  const p = resolveModel('planner', () => 'z-ai/glm-5.3', { planner: 'z-ai/glm-5.3-flashx' });
  assert.equal(p.model, 'z-ai/glm-5.3-flashx');
});

test('unknown model falls back to default price', () => {
  const p = resolveModel('checker', () => 'some/unknown');
  assert.equal(p.model, 'some/unknown');
  assert.equal(p.inPerM, 0.15);
});

test('estimateCostUsd', () => {
  assert.equal(estimateCostUsd({ inPerM: 0.15, outPerM: 0.5 }, 1_000_000, 2_000_000), 1.15);
});
