import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorRunnerService } from './editor-runner.service';
import { SkillLibrary } from '../skills/skill-library';
import { makeCard } from '../post/testing/fixtures';

const NOW = new Date('2026-10-01T09:00:00Z');

function setup(loopResult: any, slotAfter: any, cardOver: any = {}) {
  const updates: any[] = [];
  const notes: string[] = [];
  const runs: any[] = [];
  const runner = new EditorRunnerService({
    loop: { run: async (i: any) => { runs.push(i); return loopResult; } },
    registry: { forRole: (role: any) => [{ name: `${role}-tool` }] as any },
    skills: new SkillLibrary(),
    plans: {
      reservedSlots: async () => [],
      getSlot: async () => slotAfter,
      updateSlot: async (id: string, p: any) => { updates.push([id, p]); },
    },
    memory: { listActive: async () => [{ id: 1, kind: 'rule', text: 'Без політики', evidence: null, createdBy: 'owner', createdAt: NOW }] as any },
    env: () => undefined,
    notify: async (t) => { notes.push(t); },
    now: () => NOW,
  });
  return { runner, updates, notes, runs, card: makeCard(cardOver) };
}

const slot: any = { id: 's1', channelKey: '@chan', scheduledAt: NOW, format: 'photo', topic: 'Тема', angle: null, sourceHints: [], isExperiment: false, attempts: 1 };

test('executor: loop gets role tools, card extras, model and prompts with memory + workflow skill', async () => {
  const { runner, runs } = setup({ runId: 'r1', status: 'ok', terminalTool: 'publish_post' }, { ...slot, status: 'published' });
  await runner.runExecutor(slot, makeCard());
  const i = runs[0];
  assert.equal(i.role, 'executor');
  assert.equal(i.slotId, 's1');
  assert.equal(i.model.model, 'z-ai/glm-5.3-flash');
  assert.equal(i.extras.card.channelKey, '@chan');
  assert.match(i.system, /Без політики/);
  assert.match(i.system, /skill: editor-executor-workflow/);
  assert.match(i.system, /format-poll-quiz:/); // listed, not inlined
  assert.match(i.user, /Формат: photo/);
});

test('executor: no terminal → retry once in 15 min', async () => {
  const { runner, updates } = setup({ runId: 'r1', status: 'max_steps', error: 'no terminal' }, { ...slot, status: 'running', attempts: 1 });
  await runner.runExecutor(slot, makeCard());
  const last = updates.at(-1)[1];
  assert.equal(last.status, 'planned');
  assert.equal(last.scheduledAt.toISOString(), '2026-10-01T09:15:00.000Z');
});

test('executor: second failure, budget, or quiet retry → failed', async () => {
  for (const [res, after, cardOver] of [
    [{ runId: 'r', status: 'error' }, { ...slot, status: 'running', attempts: 2 }, {}],
    [{ runId: 'r', status: 'budget_exceeded' }, { ...slot, status: 'running', attempts: 1 }, {}],
    [{ runId: 'r', status: 'error' }, { ...slot, status: 'running', attempts: 1 }, { quietStartHour: 12, quietEndHour: 14 }],
  ] as any[]) {
    const { runner, updates, card } = setup(res, after, cardOver);
    await runner.runExecutor(slot, card);
    assert.equal(updates.at(-1)[1].status, 'failed');
  }
});

test('executor: terminal outcome leaves slot as the tool set it', async () => {
  const { runner, updates } = setup({ runId: 'r1', status: 'ok', terminalTool: 'skip_slot' }, { ...slot, status: 'skipped' });
  await runner.runExecutor(slot, makeCard());
  assert.deepEqual(updates, [['s1', { runId: 'r1' }]]);
});

test('planner: alerts when no plan submitted; passes planDate', async () => {
  const { runner, notes, runs } = setup({ runId: 'r', status: 'max_steps' }, null);
  await runner.runPlanner(makeCard());
  assert.equal(runs[0].extras.planDate, '2026-10-01');
  assert.match(notes[0], /не склав план/);
});

test('reviewer: forwards summary to owner', async () => {
  const { runner, notes } = setup({ runId: 'r', status: 'ok', terminalTool: 'finish_review', terminalResult: { summary: 'Вікторини працюють' } }, null);
  await runner.runReviewer(makeCard());
  assert.match(notes[0], /Вікторини працюють/);
});
