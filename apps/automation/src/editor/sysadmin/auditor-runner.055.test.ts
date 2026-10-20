import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../harness/agent-loop';
import { ToolRegistry } from '../harness/tool-registry';
import { FakeBudget, FakeLlm, MemoryRecorder } from '../harness/testing/fakes';
import { buildReadTools } from '../tools/read-tools';
import { AuditorRunner, skillSourceOf } from './auditor-runner';
import { buildAuditorTools } from './auditor-tools';
import { emptyFacts, type AuditFacts, type SkillFact } from './audit.types';

const NOW = new Date('2026-10-20T06:30:00Z');
const sk = (id: string, name: string, body: string): SkillFact => ({
  id, name, scope: 'global', agent: null, description: `About ${name}`, appliesTo: ['executor'], body, safety: false, locked: false,
});
// One skill names a tool that does not exist: the code finds it without any model.
const FACTS: AuditFacts = {
  ...emptyFacts(NOW),
  knownTools: new Set(['publish_post', 'load_skill']),
  skills: [sk('s1', 'format-a', 'Use `publish_post` and `get_magic_numbers` when writing the post for the channel today, always.'),
    sk('s2', 'auditor-workflow', 'WORKFLOW BODY')],
};
const AGENT: any = { id: 'ag1', handle: 'sysadmin', name: 'Sysadmin', kind: 'auditor', mode: 'live', model: null, reasoningEffort: null, dailyBudgetUsd: null };

function setup(o: { turns?: any[]; agent?: any; enabled?: boolean; env?: Record<string, string>; budget?: FakeBudget; facts?: AuditFacts } = {}) {
  const llm = new FakeLlm(o.turns ?? []);
  const recorder = new MemoryRecorder();
  const loop = new AgentLoop({ llm, recorder, budget: o.budget ?? new FakeBudget(), enabled: () => o.enabled ?? true });
  const skills = skillSourceOf(o.facts ?? FACTS);
  const registry = new ToolRegistry([
    ...buildReadTools({ pool: {} as any, readonly: {} as any, skills }),
    ...buildAuditorTools({ memory: { listActive: async () => [] }, card: async () => null }),
  ]);
  const seen: any[] = [];
  const runner = new AuditorRunner({
    loop: { run: async (i) => { seen.push(i); return loop.run(i); } },
    registry,
    runtime: { forAgent: async (a) => ({ agent: a, orchestrator: a, skills, paused: false }) as any },
    agents: { findTop: async () => (o.agent === undefined ? AGENT : o.agent) },
    load: async () => o.facts ?? FACTS,
    env: (k) => o.env?.[k],
    now: () => NOW,
  });
  return { runner, llm, recorder, seen };
}

test('the model reads, comments on a finding and adds its own; the code findings stay', async () => {
  const s = setup();
  // The key is a hash: read it from a dry run of the checks.
  const keys = (await s.runner.run()).findings.filter((f) => f.check === 'skill_unknown_tool').map((f) => f.key);
  assert.equal(keys.length, 1);
  const t = setup({ turns: [
    { calls: [{ name: 'load_skill', args: { name: 'format-a' } }] },
    { calls: [{ name: 'submit_audit', args: {
      summary: 'Один скіл посилається на неіснуючий інструмент.',
      comments: [{ key: keys[0], comment: 'Скіл не працюватиме.' }, { key: 'invented', comment: 'x' }],
      extra: [{ subject: 's1', area: 'skills', severity: 'warn', title: 'Contradicts the workflow', detail: 'Both say different things.' }],
    } }] },
  ] });
  const pass = await t.runner.run();
  assert.equal(pass.llm.status, 'ok');
  assert.equal(pass.summary, 'Один скіл посилається на неіснуючий інструмент.');
  assert.deepEqual(Object.keys(pass.comments), [keys[0]]);
  assert.deepEqual(pass.findings.map((f) => f.check).sort(), ['llm_judgement', 'skill_unknown_tool']);
  const run = t.seen[0];
  assert.equal(run.role, 'auditor');
  assert.deepEqual(run.tools.map((x: any) => x.name).sort(), ['inspect_channel_card', 'inspect_channel_memory', 'list_skills', 'load_skill', 'submit_audit']);
  assert.match(run.system, /WORKFLOW BODY/);
  assert.match(run.system, /skill_unknown_tool/);
  assert.ok(run.maxCostUsd > 0 && run.maxSteps <= 8);
  assert.equal(t.recorder.runs[0].status, 'ok');
});

test('load_skill reads any skill of the database by name for the auditor', async () => {
  const t = setup({ turns: [
    { calls: [{ name: 'load_skill', args: { name: 'format-a' } }] },
    { calls: [{ name: 'submit_audit', args: { summary: 'ok' } }] },
  ] });
  await t.runner.run();
  const step = t.recorder.steps.find((x) => x.tool === 'load_skill')!;
  assert.match(JSON.stringify(step.output), /get_magic_numbers/);
});

test('model off, no agent, agent off: the code findings are still the report, with a note', async () => {
  for (const [o, status] of [
    [{ env: { AUDITOR_LLM: 'off' } }, 'off'],
    [{ agent: null }, 'no_agent'],
    [{ agent: { ...AGENT, mode: 'off' } }, 'off'],
  ] as const) {
    const t = setup(o as any);
    const pass = await t.runner.run();
    assert.equal(pass.llm.status, status);
    assert.ok(pass.llm.note.length > 0);
    assert.equal(t.llm.requests.length, 0, 'no LLM call');
    assert.equal(pass.findings.filter((f) => f.check === 'skill_unknown_tool').length, 1);
    assert.deepEqual(pass.comments, {});
    assert.equal(pass.summary, null);
  }
});

test('no key (loop disabled) and an exhausted budget are clean skips', async () => {
  const off = await setup({ enabled: false }).runner.run();
  assert.equal(off.llm.status, 'off');
  const over = await setup({ budget: new FakeBudget([{ ok: false, scope: 'agent', spentUsd: 1, limitUsd: 1 }]) }).runner.run();
  assert.equal(over.llm.status, 'budget');
  assert.equal(over.findings.length, 1);
});

test('a model that ends without submit_audit or throws does not lose the findings', async () => {
  const noSubmit = await setup({ turns: [{ text: 'Все гаразд.' }] }).runner.run();
  assert.equal(noSubmit.llm.status, 'failed');
  assert.match(noSubmit.llm.note, /gave no summary/);
  assert.equal(noSubmit.findings.length, 1);
  const boom = await setup({ turns: [new Error('provider down')] }).runner.run();
  assert.equal(boom.llm.status, 'failed');
  assert.equal(boom.findings.length, 1);
});
