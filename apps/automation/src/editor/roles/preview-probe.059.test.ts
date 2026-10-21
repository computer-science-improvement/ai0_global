/**
 * Spec 059: the dry run a skill probe makes on a slot that was published already. The ledger guards (the post's own
 * text is in the ledger, its source is posted) stand aside, the proposed skill text is read for this run only, spend
 * is `editor.probe`, and nothing is stored. Scripted fake LLMs only, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../harness/agent-loop';
import { ToolRegistry } from '../harness/tool-registry';
import { FakeBudget, FakeLlm, MemoryRecorder } from '../harness/testing/fakes';
import { buildRoleTools } from '../tools/role-tools';
import { buildComposeTools } from '../tools/compose-tools';
import { CriticService } from '../critic/critic.service';
import { CRITIC_SCORE_KEYS, type CriticScores } from '../critic/critic';
import { SkillLibrary } from '../skills/skill-library';
import { makeCard, makeSpec } from '../post/testing/fixtures';
import { EditorRunnerService } from './editor-runner.service';
import { PROBE_FEATURE, PreviewSink } from './preview-run';
import { SkillOverlay } from '../skills/skill-overlay';

const NOW = new Date('2030-05-06T09:00:00Z');
const all = (n: number) => Object.fromEntries(CRITIC_SCORE_KEYS.map((k) => [k, n])) as CriticScores;
const pass = { calls: [{ name: 'submit_critique', args: { scores: all(5), verdict: 'pass', notes: 'Добре.' } }], cost: 0.002 };
const publishCall = { calls: [{ name: 'publish_post', args: { spec: makeSpec() } }], cost: 0.004 };

function harness(status: 'planned' | 'published') {
  const slot = {
    id: 's1', planId: 'p1', channelKey: '@chan', scheduledAt: new Date('2030-05-05T15:00:00Z'), kind: 'content', format: 'photo',
    topic: 'Туманність Кільце очима Вебба', angle: 'що видно на знімку', sourceHints: ['nasa.gov'], isExperiment: false, status,
    attempts: 1, runId: 'old', publishedPostId: 7, postSpec: null, renderedPreview: null, error: null,
  } as any;
  const writes: unknown[] = [];
  const sent: unknown[] = [];
  // The published post is in the ledger: its source is posted and its text is the corpus's newest entry.
  const rendered = 'Телескоп Вебб показав туманність Кільце\n\nНа знімку видно оболонки газу, які зоря скинула тисячі років тому.';
  const plans = {
    getSlot: async () => slot, updateSlot: async (...a: unknown[]) => { writes.push(a); },
    reservedSlots: async () => [], createPlan: async () => 'p', countPublishedSince: async () => 0, lastPostAt: async () => null,
    sourceAlreadyPosted: async () => true, recentTexts: async () => [rendered],
    insertPublication: async () => { writes.push('publication'); return 1; },
  };
  const registry = new ToolRegistry([
    ...buildComposeTools(),
    ...buildRoleTools({
      pool: { query: async () => ({ rows: [] }) } as any, plans, memory: { listActive: async () => [] } as any, channels: {} as any,
      publisher: { send: async (_k, m) => { sent.push(m); return { messageIds: [1] }; } }, recordPublish: () => {},
      notifyPreview: async () => {}, now: () => NOW,
    }).filter((t) => t.name !== 'get_channel_memory'),
  ]);
  const execLlm = new FakeLlm([publishCall]);
  const loop = new AgentLoop({ llm: execLlm, recorder: new MemoryRecorder(), budget: new FakeBudget(), enabled: () => true });
  const critic = new CriticService({
    loop: new AgentLoop({ llm: new FakeLlm([pass]), recorder: new MemoryRecorder(), budget: new FakeBudget(), enabled: () => true }),
    env: () => undefined, now: () => NOW,
  });
  const files = new SkillLibrary();
  const runner = new EditorRunnerService({
    loop, registry, skills: files, plans: plans as any, memory: { listActive: async () => [] }, env: () => undefined,
    notify: async () => {}, now: () => NOW,
    critic: { service: critic, inbox: async () => {} },
    runtime: { forChannel: async () => ({ agent: null, orchestrator: null, skills: files, paused: false }) } as any,
  });
  return { runner, slot, card: makeCard({ mode: 'live', quietStartHour: 0, quietEndHour: 0 }), writes, sent, execLlm };
}

test('a probe re-writes a published slot: the ledger guards stand aside, nothing is stored or sent', async () => {
  const h = harness('published');
  const p = await h.runner.runPreview(h.slot, h.card, { probe: true });
  assert.equal(p.status, 'ready', JSON.stringify(p));
  assert.match(p.preview!, /Телескоп Вебб показав туманність Кільце/);
  assert.deepEqual(h.writes, []);
  assert.deepEqual(h.sent, []);
});

test('an ordinary preview of the same slot is still guarded by the ledger', async () => {
  const planned = harness('planned');
  const p = await planned.runner.runPreview(planned.slot, planned.card);
  assert.notEqual(p.status, 'ready', 'source_already_posted / too_similar still apply to an ordinary preview');
  assert.deepEqual(planned.writes, []);
  assert.deepEqual(planned.sent, []);
});

test('the proposed skill text is read for this run only: the writer prompt carries the override, the live library is unchanged', async () => {
  const h = harness('published');
  const live = new SkillLibrary().get('editor-executor-workflow')!;
  const p = await h.runner.runPreview(h.slot, h.card, {
    probe: true,
    skillOverride: { name: 'editor-executor-workflow', description: live.description, appliesTo: live.appliesTo, body: 'ПРОБНИЙ ТЕКСТ СКІЛА 059' },
  });
  assert.equal(p.status, 'ready', JSON.stringify(p));
  const req = (h.execLlm as FakeLlm).requests[0];
  const system = String(req.messages.find((m) => m.role === 'system')?.content ?? '');
  assert.match(system, /ПРОБНИЙ ТЕКСТ СКІЛА 059/);
  assert.ok(!new SkillLibrary().get('editor-executor-workflow')!.body.includes('ПРОБНИЙ ТЕКСТ'));
});

test('PreviewSink: a probe carries its own cap, a plain preview does not', () => {
  assert.deepEqual([new PreviewSink().probe, new PreviewSink().maxCostUsd], [false, null]);
  const s = new PreviewSink(true, 0.12);
  assert.deepEqual([s.probe, s.maxCostUsd], [true, 0.12]);
  assert.equal(PROBE_FEATURE, 'editor.probe');
});

test('SkillOverlay: replaces one skill, adds an unknown one, keeps the others and the safety flag', () => {
  const base = new SkillLibrary();
  const name = 'anti-slop';
  const orig = base.get(name)!;
  const o = new SkillOverlay(base, { name, description: 'd', appliesTo: ['executor'], body: 'новий текст' });
  assert.equal(o.get(name)!.body, 'новий текст');
  assert.equal(!!o.get(name)!.safety, !!orig.safety);
  assert.equal(o.get('voice-core')!.body, base.get('voice-core')!.body);
  const added = new SkillOverlay(base, { name: 'brand-new', description: 'd', appliesTo: ['executor'], body: 'x' });
  assert.ok(added.list('executor').some((m) => m.name === 'brand-new'));
  assert.ok(!added.list('planner').some((m) => m.name === 'brand-new'));
  assert.equal(base.get('brand-new'), undefined);
  // A changed appliesTo decides which roles list the skill.
  const moved = new SkillOverlay(base, { name, description: 'd', appliesTo: ['planner'], body: 'x' });
  assert.ok(moved.list('planner').some((m) => m.name === name));
  assert.ok(!moved.list('executor').some((m) => m.name === name));
  // An always-in-context skill falls out of the inline set once its new text is too long.
  const withInline = { list: (r?: any) => base.list(r), get: (n: string) => base.get(n), inlineNames: () => [name, 'voice-core'] };
  const big = new SkillOverlay(withInline, { name, description: 'd', appliesTo: ['executor'], body: 'я'.repeat(20_000) });
  assert.deepEqual(big.inlineNames(), ['voice-core']);
  const small = new SkillOverlay(withInline, { name, description: 'd', appliesTo: ['executor'], body: 'коротко' });
  assert.deepEqual(small.inlineNames(), [name, 'voice-core']);
});
