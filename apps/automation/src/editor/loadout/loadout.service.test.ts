import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { defineTool } from '../harness/tool';
import { ToolRegistry } from '../harness/tool-registry';
import { AgentLoop } from '../harness/agent-loop';
import { FakeBudget, FakeLlm, MemoryRecorder } from '../harness/testing/fakes';
import { resolveModel } from '../llm/model-registry';
import { intersectAllow, LoadoutService, NO_TOOL } from './loadout.service';
import { EditorRunnerService } from '../roles/editor-runner.service';
import { SkillLibrary } from '../skills/skill-library';
import { makeCard } from '../post/testing/fixtures';
import type { LoadoutMode } from './loadout.repository';

const mk = (name: string, roles: any[], kind: any = 'read', chatOnly = false) =>
  defineTool({ name, description: `${name} desc`, input: z.object({}), kind, roles, chatOnly, execute: async () => ({ ok: true }) });

const registry = () => new ToolRegistry([
  mk('read_a', ['executor']), mk('read_b', ['executor']), mk('read_c', ['executor']), mk('act_d', ['executor'], 'act'),
  mk('publish', ['executor'], 'terminal'), mk('skip', ['executor'], 'terminal'),
  mk('plan_x', ['planner']),
  mk('save_draft', ['composer']), mk('compose_only', ['composer'], 'act'), mk('chat_card', ['builder'], 'act', true), mk('build_a', ['builder']),
  mk('orch_a', ['orchestrator', 'composer']), mk('orch_b', ['orchestrator']),
]);

function service(mode: LoadoutMode, enabled: string[], fail = false) {
  return new LoadoutService({
    repo: {
      mode: async () => { if (fail) throw new Error('db down'); return mode; },
      enabledTools: async () => [...enabled].sort(),
    },
  });
}
const agent = (kind: any = 'executor') => ({ id: 'a1', kind, handle: 'ex' }) as any;
const names = (tools: Array<{ name: string }>) => tools.map((t) => t.name);

test('intersectAllow: null is no limit, an empty result is the none-marker, never []', () => {
  assert.equal(intersectAllow(null, null), null);
  assert.equal(intersectAllow([], undefined), null);
  assert.deepEqual(intersectAllow(['a', 'b'], null), ['a', 'b']);
  assert.deepEqual(intersectAllow(null, ['a']), ['a']);
  assert.deepEqual(intersectAllow(['a', 'b', 'c'], ['c', 'a', 'z']), ['a', 'c']);
  assert.deepEqual(intersectAllow(['a'], ['b']), [NO_TOOL]);
});

test('mode role: no allowlist, the role default as before', async () => {
  const s = service('role', ['read_a']);
  assert.equal(await s.toolsAllow('a1'), null);
  const allow = await s.allowFor(agent(), { role: 'executor', registry: registry() });
  assert.equal(allow, null);
  assert.deepEqual(names(registry().forRole('executor', intersectAllow(null, allow))), ['read_a', 'read_b', 'read_c', 'act_d', 'publish', 'skip']);
});

test('mode custom: only the enabled tools, the terminal tools stay', async () => {
  const s = service('custom', ['read_b', 'act_d']);
  assert.deepEqual(await s.toolsAllow('a1'), ['act_d', 'read_b']);
  const allow = await s.allowFor(agent(), { role: 'executor', registry: registry() });
  assert.deepEqual(names(registry().forRole('executor', allow)), ['read_b', 'act_d', 'publish', 'skip'], 'registry order, not the loadout order');
});

test('custom with nothing enabled offers the terminal tools only (not the whole role)', async () => {
  const allow = await service('custom', []).allowFor(agent(), { role: 'executor', registry: registry() });
  assert.deepEqual(allow, [NO_TOOL]);
  assert.deepEqual(names(registry().forRole('executor', allow)), ['publish', 'skip']);
});

test('intersection with the channel allowlist; null on either side is no limit', async () => {
  const loadout = await service('custom', ['read_a', 'read_b', 'act_d']).allowFor(agent(), { role: 'executor', registry: registry() });
  const reg = registry();
  assert.deepEqual(names(reg.forRole('executor', intersectAllow(['read_b', 'read_c'], loadout))), ['read_b', 'publish', 'skip']);
  assert.deepEqual(names(reg.forRole('executor', intersectAllow(null, loadout))), ['read_a', 'read_b', 'act_d', 'publish', 'skip']);
  assert.deepEqual(names(reg.forRole('executor', intersectAllow(['read_c'], null))), ['read_c', 'publish', 'skip']);
  assert.deepEqual(names(reg.forRole('executor', intersectAllow(['read_c'], loadout))), ['publish', 'skip'], 'disjoint: terminal only');
});

test('unknown names in the loadout (a renamed tool) are ignored', async () => {
  const allow = await service('custom', ['read_a', 'tool_that_was_renamed']).allowFor(agent(), { role: 'executor', registry: registry() });
  assert.deepEqual(names(registry().forRole('executor', allow)), ['read_a', 'publish', 'skip']);
});

test('stable order: the same loadout in any row order gives the same list', async () => {
  const a = await service('custom', ['act_d', 'read_a', 'read_c']).allowFor(agent(), { role: 'executor', registry: registry() });
  const b = await service('custom', ['read_c', 'read_a', 'act_d']).allowFor(agent(), { role: 'executor', registry: registry() });
  assert.deepEqual(names(registry().forRole('executor', a)), names(registry().forRole('executor', b)));
});

test('a run of another role than the agent\'s own is not narrowed (no child → the orchestrator plans)', async () => {
  const s = service('custom', ['orch_a']);
  assert.equal(await s.allowFor(agent('orchestrator'), { role: 'planner', registry: registry() }), null);
});

test('chat: the agent\'s own tools are narrowed, the composer\'s and the chat-only ones stay', async () => {
  const reg = registry();
  const s = service('custom', ['orch_a']);
  const allow = await s.allowFor(agent('orchestrator'), { role: 'composer', registry: reg, chat: true });
  assert.deepEqual(names(reg.forRole('composer', allow, { chat: true })), ['save_draft', 'compose_only', 'orch_a']);
  const allowB = await service('custom', ['build_a']).allowFor(agent('builder'), { role: 'builder', registry: reg, chat: true });
  assert.deepEqual(names(reg.forRole('builder', allowB, { chat: true })), ['chat_card', 'build_a']);
  const allowC = await service('custom', []).allowFor(agent('builder'), { role: 'builder', registry: reg, chat: true });
  assert.deepEqual(names(reg.forRole('builder', allowC, { chat: true })), ['chat_card']);
});

test('a loadout that cannot be read leaves the role default and logs', async () => {
  const logs: string[] = [];
  const s = new LoadoutService({
    repo: { mode: async () => { throw new Error('db down'); }, enabledTools: async () => [] },
    log: (m) => logs.push(m),
  });
  assert.equal(await s.allowFor(agent(), { role: 'executor', registry: registry() }), null);
  assert.match(logs[0], /db down/);
  assert.equal(await s.allowFor(null, { role: 'executor', registry: registry() }), null);
});

test('the editor runner gives the loop the loadout ∩ the channel allowlist, and the loop records what was offered', async () => {
  const reg = registry();
  const recorder = new MemoryRecorder();
  const llm = new FakeLlm([{ calls: [{ name: 'skip', args: {} }] }]);
  const loop = new AgentLoop({ llm, recorder, budget: new FakeBudget(), enabled: () => true });
  const runner = new EditorRunnerService({
    loop, registry: reg, skills: new SkillLibrary(),
    runtime: { forChannel: async () => ({ agent: agent(), orchestrator: null, skills: new SkillLibrary(), paused: false }) as any },
    loadout: service('custom', ['read_a', 'read_b', 'act_d']),
    plans: { reservedSlots: async () => [], getSlot: async () => ({ id: 's1', status: 'skipped' }) as any, updateSlot: async () => {} },
    memory: { listActive: async () => [] },
    env: () => undefined, notify: async () => {}, now: () => new Date('2026-10-01T09:00:00Z'),
  });
  const slot: any = { id: 's1', channelKey: '@chan', scheduledAt: new Date(), format: 'photo', topic: 't', angle: null, sourceHints: [], isExperiment: false, attempts: 1 };
  await runner.runExecutor(slot, makeCard({ toolsAllow: ['read_b', 'read_c'] }));
  assert.deepEqual(recorder.runs[0].toolsOffered, ['read_b', 'publish', 'skip']);
  assert.deepEqual(llm.requests[0].tools!.map((t: any) => t.name), ['read_b', 'publish', 'skip']);
});

test('AgentLoop writes the offered names once, at the start', async () => {
  const recorder = new MemoryRecorder();
  const loop = new AgentLoop({ llm: new FakeLlm([{ calls: [{ name: 'skip', args: {} }] }]), recorder, budget: new FakeBudget(), enabled: () => true });
  const tools = registry().forRole('executor', ['read_a']);
  await loop.run({ role: 'executor', channelKey: 'ch', model: resolveModel('executor', () => undefined), system: 's', user: 'u', tools });
  assert.deepEqual(recorder.runs[0].toolsOffered, ['read_a', 'publish', 'skip']);
});
