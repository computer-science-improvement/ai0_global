import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorRunnerService } from '../roles/editor-runner.service';
import { SkillLibrary } from '../skills/skill-library';
import { makeCard } from '../post/testing/fixtures';

// Spec 023 FR-005: the executor gets the series context; an exhausted required source skips by code (no LLM).

const NOW = new Date('2026-10-01T09:00:00Z');
const slot: any = { id: 's1', channelKey: '@chan', scheduledAt: NOW, format: 'photo', topic: 'Рецепт дня', angle: null, sourceHints: [], isExperiment: false, attempts: 1, seriesName: 'Рецепт дня' };

function setup(ctx: { note: string | null; skip?: string }) {
  const updates: any[] = [];
  const runs: any[] = [];
  const done: string[] = [];
  const runner = new EditorRunnerService({
    loop: { run: async (i: any) => { runs.push(i); return { runId: 'r1', status: 'ok', terminalTool: 'publish_post' } as any; } },
    registry: { forRole: () => [] as any },
    skills: new SkillLibrary(),
    plans: { reservedSlots: async () => [], getSlot: async () => ({ ...slot, status: 'published' }), updateSlot: async (id: string, p: any) => { updates.push([id, p]); } },
    memory: { listActive: async () => [] },
    env: () => undefined,
    notify: async () => {},
    now: () => NOW,
    seriesContext: async () => ctx,
    onSlotDone: async (s) => { done.push(s.id); },
  });
  return { runner, updates, runs, done };
}

test('a series slot: the series note reaches the executor prompt', async () => {
  const { runner, runs } = setup({ note: 'Це випуск серії «Рецепт дня». Джерело серії обовʼязкове: library:recipes.' });
  await runner.runExecutor(slot, makeCard());
  assert.equal(runs.length, 1);
  assert.match(runs[0].user, /Це випуск серії «Рецепт дня»/);
});

test('an exhausted required source: skipped by code, no LLM run, onSlotDone still called', async () => {
  const { runner, runs, updates, done } = setup({ note: null, skip: 'series "Рецепт дня": required source library:recipes has nothing left' });
  const r = await runner.runExecutor(slot, makeCard());
  assert.equal(runs.length, 0);
  assert.equal(r.status, 'disabled');
  assert.deepEqual(updates, [['s1', { status: 'skipped', error: 'series "Рецепт дня": required source library:recipes has nothing left' }]]);
  assert.deepEqual(done, ['s1']);
});
