/** Spec 040 FR-005: planner inputs — placeholders read as absent, idea slots write their idea, a repeated rejected plan. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { validatePlan } from './plan-rules';
import { makeCard } from '../post/testing/fixtures';
import { resolveSlotTopic } from '../live/live-slot';
import { validateNetworkPlan } from '../network/network-plan';
import { PlaybookSchema } from '../network/playbook';
import type { IdeaRow } from '../network/network.repository';
import { AgentLoop, dropPlaceholders } from '../harness/agent-loop';
import { defineTool } from '../harness/tool';
import { FakeBudget, FakeLlm, MemoryRecorder } from '../harness/testing/fakes';
import { resolveModel } from '../llm/model-registry';

const I1 = '00000000-0000-4000-8000-000000000001';
const NIL = '00000000-0000-0000-0000-000000000000';

test('dropPlaceholders: "" and the nil UUID go at any depth; untouched input is returned as is', () => {
  const x = { a: 1, b: '', c: NIL, d: [{ e: '', f: 'x' }], g: { h: NIL, i: 0 } };
  assert.deepEqual(dropPlaceholders(x), { a: 1, d: [{ f: 'x' }], g: { i: 0 } });
  const clean = { a: 1, d: [{ f: 'x' }] };
  assert.equal(dropPlaceholders(clean), clean);
});

test('the loop retries validation without placeholders; a required field left empty still fails', async () => {
  const seen: unknown[] = [];
  const t = defineTool({
    name: 'plan', description: 'x', kind: 'terminal', roles: ['planner'],
    input: z.object({ topic: z.string().min(1), idea_id: z.string().uuid().optional(), directive_id: z.string().uuid().optional(), note: z.string().optional() }),
    execute: async (i) => { seen.push(i); return { ok: true }; },
  });
  const llm = new FakeLlm([
    { calls: [{ name: 'plan', args: { topic: '', idea_id: '' } }] },
    { calls: [{ name: 'plan', args: { topic: 'Сатурн', idea_id: '', directive_id: NIL, note: '' } }] },
  ]);
  const recorder = new MemoryRecorder();
  const res = await new AgentLoop({ llm, recorder, budget: new FakeBudget(), enabled: () => true })
    .run({ role: 'planner', channelKey: 'ch', model: resolveModel('planner', () => undefined), system: 's', user: 'u', tools: [t] });
  assert.equal(res.status, 'ok');
  assert.equal((recorder.steps.find((x) => x.type === 'tool')!.output as any).error, 'invalid_args');
  assert.deepEqual(seen, [{ topic: 'Сатурн' }]);
});

test('a verbatim resubmission of a rejected plan: same_plan_rejected with the earlier errors as a numbered checklist', async () => {
  let runs = 0;
  const t = defineTool({
    name: 'submit_plan', description: 'x', kind: 'terminal', roles: ['planner'], repeatError: 'same_plan_rejected',
    input: z.object({ slots: z.array(z.string()) }),
    execute: async () => { runs++; return { error: 'plan_invalid', details: ['слот 1: тихі години', 'слот 2: інтервал < 60 хв'] }; },
  });
  const llm = new FakeLlm([
    { calls: [{ name: 'submit_plan', args: { slots: ['a', 'b'] } }] },
    { calls: [{ name: 'submit_plan', args: { slots: ['a', 'b'] } }] },
    { text: 'stop' }, { text: 'stop' },
  ]);
  const recorder = new MemoryRecorder();
  await new AgentLoop({ llm, recorder, budget: new FakeBudget(), enabled: () => true })
    .run({ role: 'planner', channelKey: 'ch', model: resolveModel('planner', () => undefined), system: 's', user: 'u', tools: [t] });
  assert.equal(runs, 1);
  const out = recorder.steps.filter((x) => x.type === 'tool')[1].output as any;
  assert.equal(out.error, 'same_plan_rejected');
  assert.deepEqual(out.checklist, ['1. слот 1: тихі години', '2. слот 2: інтервал < 60 хв']);
});

test('resolveSlotTopic: an idea slot without a topic is fixed on the idea; an explicit topic or topic_mode wins', () => {
  const idea = { title: 'Кільця Сатурна зникнуть у 2025' };
  assert.deepEqual(resolveSlotTopic({}, { label: 'слот 1', idea }), { ok: true, topic: 'Кільця Сатурна зникнуть у 2025', topicMode: 'fixed', live: null });
  assert.equal((resolveSlotTopic({ topic: 'Своя тема поста' }, { label: 'слот 1', idea }) as any).topic, 'Своя тема поста');
  assert.equal((resolveSlotTopic({ topic_mode: 'live' }, { label: 'слот 1', idea, cardFeeds: ['nasa'] }) as any).topicMode, 'live');
  // Without an idea nothing changes: no topic and no source is still the live-slot error.
  assert.equal(resolveSlotTopic({}, { label: 'слот 1' }).ok, false);
});

test('single-channel plan: an idea slot takes the idea\'s title, angle and sources', () => {
  const card = makeCard({ postsPerDayMin: 1, postsPerDayMax: 4, minGapMinutes: 60, quietStartHour: 23, quietEndHour: 8 });
  const ideas = new Map([[I1, { title: 'Кільця Сатурна зникнуть', angle: 'Чому так і коли', sources: ['https://nasa.gov/saturn'] }]]);
  const v = validatePlan({ rationale: 'Один пост з пулу ідей', slots: [{ time: '12:00', format: 'photo', idea_id: I1, source_hints: [], is_experiment: false }] as any },
    card, '2026-10-01', new Date('2026-10-01T04:00:00Z'), [], undefined, [], undefined, ideas);
  assert.equal(v.ok, true, JSON.stringify(v));
  if (!v.ok) return;
  assert.equal(v.slots[0].topic, 'Кільця Сатурна зникнуть');
  assert.equal(v.slots[0].angle, 'Чому так і коли');
  assert.deepEqual(v.slots[0].sourceHints, ['https://nasa.gov/saturn']);
});

test('network plan: an idea slot without a topic is fixed on the idea (no more "live-slot without a source")', () => {
  const idea: IdeaRow = {
    id: I1, agentId: 'o1', title: 'Кільця Сатурна', angle: 'Простими словами', sources: ['https://nasa.gov/x'], variants: [], why: null, evidence: null,
    origin: 'orchestrator', originRef: null, expiresAt: new Date(), status: 'accepted', revisions: 0, review: null, createdAt: new Date(), updatedAt: new Date(),
  };
  const v = validateNetworkPlan({ rationale: 'День мережі за рішеннями', slots: [{ resource_ref: 'telegram:@space', time: '10:00', format: 'photo', idea_id: I1, source_hints: [], reason: 'Причина з профілю ресурсу' }] as any }, {
    net: {
      orchestrator: { id: 'o1', handle: 'kira' } as any, anchorKey: '@space', groupId: 'g1', groupName: 'Космос', mode: 'independent',
      resources: [{ ref: 'telegram:@space', platform: 'telegram' } as any], playbookVersion: 1, telegramFormats: ['photo'],
      playbook: PlaybookSchema.parse({ platforms: [{ resource_ref: 'telegram:@space', role: 'core', formats: { photo: 1 }, per_day: { min: 0, max: 3 } }] }),
    },
    card: { channelKey: '@space', timezone: 'Europe/Kyiv', quietStartHour: 23, quietEndHour: 8, minGapMinutes: 60 } as any,
    planDate: '2026-10-05', weekday: 1, now: new Date('2026-10-05T05:00:00Z'), ideas: new Map([[I1, idea]]), reservedAt: [],
  });
  assert.equal(v.ok, true, v.ok ? '' : v.errors.join('\n'));
  if (!v.ok) return;
  assert.equal(v.slots[0].topic, 'Кільця Сатурна');
  assert.equal(v.slots[0].topicMode, undefined);
  assert.equal(v.slots[0].angle, 'Простими словами');
  assert.deepEqual(v.slots[0].sourceHints, ['https://nasa.gov/x']);
});
