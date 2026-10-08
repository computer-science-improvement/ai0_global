// Run: npx tsx --test "apps/dashboard/src/**/*.test.ts" (from the repo root).
// Spec 035: pure helpers of the Models page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterModels, fmtContext, fmtPerM, groupAgents, ownCounts } from './models';
import type { AgentModelRow, CatalogModel } from '../api/models';

const M = (id: string, name = id): CatalogModel => ({ id, name, contextLength: null, inPerM: null, outPerM: null, supportsReasoning: false });

test('fmtPerM / fmtContext', () => {
  assert.equal(fmtPerM(0.15), '$0.15');
  assert.equal(fmtPerM(0.5), '$0.5');
  assert.equal(fmtPerM(0.0375), '$0.0375');
  assert.equal(fmtPerM(3.39), '$3.39');
  assert.equal(fmtPerM(12), '$12');
  assert.equal(fmtPerM(0), 'free');
  assert.equal(fmtPerM(null), '—');
  assert.equal(fmtContext(200_000), '200K');
  assert.equal(fmtContext(1_048_576), '1M');
  assert.equal(fmtContext(null), '');
});

test('filterModels: all terms must match id or name; id / slug prefix first', () => {
  const all = [M('openai/gpt-5-mini', 'OpenAI: GPT-5 Mini'), M('z-ai/glm-5.3-flash', 'Z.AI: GLM 5.3 Flash'), M('z-ai/glm-5.3'), M('thudm/glm-4')];
  assert.equal(filterModels(all, '').length, 4);
  assert.deepEqual(filterModels(all, 'glm').map((m) => m.id), ['z-ai/glm-5.3-flash', 'z-ai/glm-5.3', 'thudm/glm-4']);
  assert.deepEqual(filterModels(all, 'glm flash').map((m) => m.id), ['z-ai/glm-5.3-flash']);
  assert.deepEqual(filterModels(all, 'MINI').map((m) => m.id), ['openai/gpt-5-mini']);
  assert.deepEqual(filterModels(all, 'z-ai').map((m) => m.id), ['z-ai/glm-5.3-flash', 'z-ai/glm-5.3']);
  assert.deepEqual(filterModels(all, 'nothing'), []);
});

const row = (id: string, parentId: string | null = null, model: string | null = null): AgentModelRow => ({
  id, handle: id, name: id, emoji: null, kind: parentId ? 'planner' : 'orchestrator', role: 'planner', scope: 'resource',
  parentId, parentHandle: parentId, model, reasoningEffort: null,
  effective: { model: 'z-ai/glm-5.3-flash', source: 'default', inheritedFrom: null, reasoningEffort: 'low', reasoningSource: 'default' },
  price: null, channelKey: null,
});

test('groupAgents keeps the server order and nests role children; orphans become roots', () => {
  const g = groupAgents([row('m'), row('o1'), row('p1', 'o1'), row('e1', 'o1', 'x/y'), row('o2'), row('orphan', 'gone')]);
  assert.deepEqual(g.map((x) => [x.root.id, x.children.map((c) => c.id)]), [['m', []], ['o1', ['p1', 'e1']], ['o2', []], ['orphan', []]]);
  assert.deepEqual(ownCounts([row('a', null, 'x/y'), row('b')]), { models: 1, efforts: 0 });
});
