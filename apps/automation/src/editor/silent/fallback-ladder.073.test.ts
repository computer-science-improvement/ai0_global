// Spec 073 T3 (FR-003): a locked slot keeps its format on the fallback ladder — a series instance, a pin, a quiz / poll built from a
// dataset row. It gets the second attempt (`revise_source`, `next_candidate`) and then it skips; never a "lighter" text post or an
// evergreen. And `quiz_answer_mismatch` no longer puts the row aside.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorRunnerService } from '../roles/editor-runner.service';
import { SkillLibrary } from '../skills/skill-library';
import { makeCard } from '../post/testing/fixtures';
import { isToolError } from '../harness/tool';
import { formatLocked, ladderPlan, shouldPassRow } from './fallback-ladder';

const NOW = new Date('2026-10-29T09:00:00Z');
const ROW = 'data://pdr_questions/7';
const baseSlot: any = { id: 's1', channelKey: '@chan', scheduledAt: NOW, kind: 'content', format: 'quiz', topic: 'ПДР', angle: null, sourceHints: [], isExperiment: false, attempts: 1 };

type Behaviour = (st: any, input: any) => any;
const reject: Behaviour = (st) => {
  Object.assign(st, { status: 'skipped', error: 'critic_rejected: reject (grounding 2): слабке', critic: { verdict: 'reject', notes: 'слабке', cost_usd: 0.002 } });
  return { ok: true, skipped: true, critic_rejected: true };
};
const revise: Behaviour = (st) => {
  Object.assign(st, { status: 'skipped', error: 'critic_rejected: second revise — revise: прибери питання', critic: { verdict: 'revise', notes: 'прибери питання', scores: { grounding: 4 }, cost_usd: 0.002 } });
  return { ok: true, skipped: true, critic_rejected: true };
};
const lint: Behaviour = () => ({ error: 'lint_failed', details: [{ code: 'caption_too_long', message: 'задовго' }] });
const quizMismatch: Behaviour = () => ({ error: 'quiz_answer_mismatch', details: 'ключ відповіді не збігається з рядком' });
const shadow: Behaviour = (st) => {
  Object.assign(st, { status: 'shadowed', error: null, critic: { verdict: 'pass', notes: 'ok', cost_usd: 0.002 } });
  return { ok: true, shadow: true };
};

function setup(script: Behaviour[], o: { slot?: any; evergreen?: boolean } = {}) {
  const st: any = { ...(o.slot ?? baseSlot), status: 'running', error: null, critic: null };
  const runs: any[] = [];
  const passed: any[] = [];
  const evergreenCalls: any[] = [];
  let current: Behaviour = shadow;
  const publish = { name: 'publish_post', kind: 'terminal', description: '', input: {} as any, roles: ['executor'], execute: async (input: any) => current(st, input) };
  const runner = new EditorRunnerService({
    loop: {
      run: async (i: any) => {
        runs.push(i);
        current = script[runs.length - 1] ?? shadow;
        const tool = i.tools.find((t: any) => t.name === 'publish_post');
        const format = /Формат: (\w+)/.exec(i.user)?.[1] ?? 'text';
        const r = await tool.execute({ spec: { format, library_ref: ROW, source: { url: `https://src.example/${runs.length}` } } }, {});
        return { runId: `r${runs.length}`, status: isToolError(r) ? 'max_steps' : 'ok', terminalTool: isToolError(r) ? undefined : 'publish_post', totals: { steps: 1, promptTokens: 0, completionTokens: 0, costUsd: 0.01 } } as any;
      },
    },
    registry: { forRole: () => [publish] as any },
    skills: new SkillLibrary(),
    plans: {
      reservedSlots: async () => [],
      getSlot: async () => ({ ...st }),
      updateSlot: async (_id: string, p: any) => { Object.assign(st, p); },
    },
    memory: { listActive: async () => [] },
    env: () => undefined, notify: async () => {}, now: () => NOW,
    ladder: { maxExtraSteps: 3 },
    passRow: async (r: any) => { passed.push(r); },
    ...(o.evergreen ? {
      fallbackEvergreen: async (req: any) => {
        evergreenCalls.push(req);
        Object.assign(st, { status: 'shadowed', error: null, critic: { verdict: 'pass', cost_usd: 0.001 } });
        return { runId: 'rE', status: 'ok', terminalTool: 'publish_post', totals: { steps: 1, promptTokens: 0, completionTokens: 0, costUsd: 0.005 } } as any;
      },
    } : {}),
  } as any);
  return { runner, st, runs, passed, evergreenCalls, card: makeCard({}) };
}

const formatsOf = (runs: any[]) => runs.map((r) => /Формат: (\w+)/.exec(r.user)?.[1]);
const stepsOf = (st: any) => (st.fallback?.steps ?? []).map((x: any) => x.step);

test('formatLocked: a series instance, a pin, a series hint and a dataset-row poll / quiz are locked; a plain slot is not', () => {
  assert.equal(formatLocked({ format: 'photo', seriesName: 'Вікторина' }), true);
  assert.equal(formatLocked({ format: 'photo', scheduleRuleId: 'rule-1' }), true);
  assert.equal(formatLocked({ format: 'photo', sourceHints: ['series:Вікторина'] }), true);
  assert.equal(formatLocked({ format: 'quiz', sourceHints: ['data://pdr_questions'] }), true);
  assert.equal(formatLocked({ format: 'poll', sourceHints: ['library://x'] }), true);
  assert.equal(formatLocked({ format: 'photo', sourceHints: ['data://pdr_questions'] }), false, 'only a poll / quiz is made from the row as its question');
  assert.equal(formatLocked({ format: 'quiz', sourceHints: ['https://news.example/a'] }), false);
  assert.equal(formatLocked({ format: 'photo', sourceHints: [], seriesName: null, scheduleRuleId: null }), false);
  assert.equal(formatLocked({ format: 'text' }), false);
});

test('ladderPlan: locked keeps the format — revise_source (when fixable) and next_candidate, no lighter format, no evergreen', () => {
  const allowed = new Set(['photo', 'text', 'quiz']);
  assert.deepEqual(ladderPlan({ format: 'quiz', allowed, evergreen: true, locked: true }).map((x) => `${x.step}:${x.format}`), ['next_candidate:quiz']);
  assert.deepEqual(ladderPlan({ format: 'quiz', allowed, evergreen: true, locked: true, fixable: true }).map((x) => `${x.step}:${x.format}`), ['revise_source:quiz', 'next_candidate:quiz']);
  assert.deepEqual(ladderPlan({ format: 'quiz', allowed, evergreen: true, locked: true, failure: 'lint' }).map((x) => x.step), ['next_candidate']);
  // Not locked: unchanged — the lighter format and the evergreen step are still there.
  const open = ladderPlan({ format: 'photo', allowed, evergreen: true }).map((x) => x.step);
  assert.ok(open.includes('lighter_format') || open.includes('evergreen'), 'an unlocked slot still has its lighter steps');
});

test('shouldPassRow: quiz_answer_mismatch no longer puts the row aside, at any step', () => {
  for (const step of ['initial', 'revise_source', 'next_candidate'] as const) {
    assert.equal(shouldPassRow({ kind: 'guard', code: 'quiz_answer_mismatch', libraryRef: ROW }, step), false, step);
  }
});

test('runner: a series quiz that keeps getting rejected retries as a quiz and then skips — never a text post, never an evergreen', async () => {
  const s = setup([reject, reject, reject, reject], { slot: { ...baseSlot, seriesName: 'Вікторина ПДР' }, evergreen: true });
  await s.runner.runExecutor(s.st, s.card);
  assert.deepEqual(formatsOf(s.runs).filter((f) => f !== 'quiz'), [], `every attempt is a quiz: ${formatsOf(s.runs)}`);
  assert.ok(s.runs.length <= 2, `initial + next_candidate at most, got ${s.runs.length}`);
  assert.equal(s.evergreenCalls.length, 0, 'no evergreen post for a series slot');
  assert.equal(s.st.status, 'skipped');
  assert.ok(!stepsOf(s.st).includes('lighter_format') && !stepsOf(s.st).includes('evergreen'));
});

test('runner: a quiz built from a dataset row stays a quiz when the answer key is wrong; the row is not put aside', async () => {
  const s = setup([quizMismatch, quizMismatch], { slot: { ...baseSlot, sourceHints: ['data://pdr_questions'] } });
  await s.runner.runExecutor(s.st, s.card);
  assert.deepEqual(formatsOf(s.runs).filter((f) => f !== 'quiz'), []);
  assert.deepEqual(s.passed, [], 'quiz_answer_mismatch: the row is fine, nothing is put aside');
  assert.notEqual(s.st.status, 'shadowed');
});

test('runner: an unlocked photo slot still falls to a lighter format (spec 037 behaviour kept)', async () => {
  const s = setup([reject, reject, reject], { slot: { ...baseSlot, format: 'photo', topic: 'Тема' } });
  await s.runner.runExecutor(s.st, s.card);
  assert.equal(s.runs.length, 3);
  assert.ok(formatsOf(s.runs).includes('text'), `the third step is the lighter format: ${formatsOf(s.runs)}`);
});

test('runner: every failure kind on a locked slot — fixable revise, non-fixable reject, lint, guard — climbs only revise_source / next_candidate and keeps the format', async () => {
  const locked = { ...baseSlot, seriesName: 'Вікторина ПДР' };
  const cases: Array<[string, Behaviour[]]> = [
    ['fixable revise', [revise, revise, revise, revise]],
    ['non-fixable reject', [reject, reject, reject, reject]],
    ['lint', [lint, lint, lint, lint]],
    ['guard', [quizMismatch, quizMismatch, quizMismatch, quizMismatch]],
  ];
  for (const [name, script] of cases) {
    const s = setup(script, { slot: locked, evergreen: true });
    await s.runner.runExecutor(s.st, s.card);
    assert.deepEqual(formatsOf(s.runs).filter((f) => f !== 'quiz'), [], `${name}: ${formatsOf(s.runs)}`);
    assert.deepEqual(stepsOf(s.st).filter((x: string) => x === 'lighter_format' || x === 'evergreen'), [], name);
    assert.equal(s.evergreenCalls.length, 0, name);
    assert.notEqual(s.st.status, 'shadowed', name);
  }
  // The fixable revise gets its second try as revise_source before next_candidate.
  const fix = setup([revise, revise, revise], { slot: locked });
  await fix.runner.runExecutor(fix.st, fix.card);
  assert.deepEqual(stepsOf(fix.st).slice(0, 2), ['initial', 'revise_source']);
});
