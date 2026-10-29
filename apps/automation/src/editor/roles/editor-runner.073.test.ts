// Spec 073 T11 (FR-010, A27, A30): a slot whose publish tool answered with a CONFIG failure (the series' format or source does not fit
// the post) ends skipped with that reason — no fallback step, no 15-minute retry, no row put aside. The owner is told once a day
// per channel and code; `onConfigSkip` fires once per config skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorRunnerService } from './editor-runner.service';
import { SkillLibrary } from '../skills/skill-library';
import { makeCard } from '../post/testing/fixtures';
import { isToolError } from '../harness/tool';
import { reasonFor } from '../reasons/catalogue';

const NOW = new Date('2026-10-29T09:00:00Z'); // 11:00 in Kyiv (UTC+2 after the clocks went back on 25 October)
const ROW = 'data://pdr_questions/7';
const baseSlot: any = {
  id: 's1', channelKey: '@chan', scheduledAt: NOW, kind: 'content', format: 'quiz', topic: 'ПДР', angle: null, sourceHints: [],
  isExperiment: false, attempts: 1, seriesName: 'Білет дня',
};

interface Hands { publish(): Promise<any>; skip(cause: string): Promise<any>; st: any }
/** One executor attempt: drives the publish / skip tools like the model would and returns the last tool result. */
type Script = (h: Hands) => Promise<any>;

/** The publish tool answers with `{ error: code, details }`. */
const fails = (code: string, details: unknown): Script => async (h) => { h.st.__next = { error: code, details }; return h.publish(); };
const cfg = (code = 'series_format_mismatch', details: unknown = 'серія «Білет дня» виходить у форматі quiz, а пост — text'): Script => fails(code, details);
const lintFail: Script = fails('lint_failed', [{ code: 'caption_too_long', message: 'задовго' }]);
const cfgThenSkip: Script = async (h) => { await cfg()(h); return h.skip('no_material'); };

function setup(scripts: Script[], o: { slot?: any; card?: any } = {}) {
  const st: any = { ...(o.slot ?? baseSlot), status: 'running', error: null, critic: null };
  const runs: any[] = [];
  const passed: any[] = [];
  const configSkips: Array<[string, string]> = [];
  const notes: string[] = [];
  const done: string[] = [];
  let clock = NOW;
  let script = scripts;
  const publish = {
    name: 'publish_post', kind: 'terminal', description: '', input: {} as any, roles: ['executor'],
    execute: async () => { const r = st.__next; st.__next = undefined; return r ?? { ok: true }; },
  };
  const skipTool = {
    name: 'skip_slot', kind: 'terminal', description: '', input: {} as any, roles: ['executor'],
    execute: async (input: any) => { Object.assign(st, { status: 'skipped', error: `skipped by agent: ${input.cause}: nothing` }); return { ok: true, skipped: true }; },
  };
  const runner = new EditorRunnerService({
    loop: {
      run: async (i: any) => {
        runs.push(i);
        const pub = i.tools.find((t: any) => t.name === 'publish_post');
        const skp = i.tools.find((t: any) => t.name === 'skip_slot');
        const hands: Hands = {
          st,
          publish: () => pub.execute({ spec: { format: 'text', library_ref: ROW, source: { url: `https://src.example/${runs.length}` } } }, {}),
          skip: (cause) => skp.execute({ cause }, {}),
        };
        const r = await (script[runs.length - 1] ?? script[script.length - 1])(hands);
        return { runId: `r${runs.length}`, status: isToolError(r) ? 'max_steps' : 'ok', terminalTool: isToolError(r) ? undefined : 'publish_post', totals: { steps: 1, promptTokens: 0, completionTokens: 0, costUsd: 0.01 } } as any;
      },
    },
    registry: { forRole: () => [publish, skipTool] as any },
    skills: new SkillLibrary(),
    plans: {
      reservedSlots: async () => [],
      getSlot: async () => ({ ...st }),
      updateSlot: async (_id: string, p: any) => { Object.assign(st, p); },
    },
    memory: { listActive: async () => [] },
    env: () => undefined,
    notify: async (t: string) => { notes.push(t); },
    now: () => clock,
    ladder: { maxExtraSteps: 3 },
    passRow: async (r: any) => { passed.push(r); },
    onConfigSkip: (channel: string, code: string) => { configSkips.push([channel, code]); },
    onSlotDone: async (s: any) => { done.push(s.id); },
  } as any);
  return {
    runner, st, runs, passed, configSkips, notes, done, card: o.card ?? makeCard({ channelKey: '@chan', timezone: 'Europe/Kyiv' }),
    /** The next slot of the same runner (the once-a-day map lives on the runner): fresh state, optionally another script / channel / day. */
    next: (id: string, o2: { scripts?: Script[]; channelKey?: string; at?: Date } = {}) => {
      Object.assign(st, { ...baseSlot, id, channelKey: o2.channelKey ?? baseSlot.channelKey, status: 'running', error: null, critic: null, fallback: null, retryAt: undefined });
      if (o2.scripts) script = o2.scripts;
      if (o2.at) clock = o2.at;
      runs.length = 0;
    },
  };
}

const stepsOf = (st: any): string[] => (st.fallback?.steps ?? []).map((x: any) => x.step);
const gear = (notes: string[]) => notes.filter((n) => n.startsWith('⚙️'));

test('A30 a config error followed by skip_slot: the slot error is the config reason, not the executor\'s skip text', async () => {
  const s = setup([cfgThenSkip]);
  await s.runner.runExecutor(s.st, s.card);
  assert.equal(s.runs.length, 1, 'one attempt, no ladder step');
  assert.equal(s.st.status, 'skipped');
  assert.match(s.st.error, /^series_format_mismatch: серія «Білет дня» виходить у форматі quiz, а пост — text/);
  assert.deepEqual(s.st.fallback.steps, [], 'no step is added: the digest\'s `laddered` counts slots with steps');
  assert.deepEqual(s.st.fallback.final, { outcome: 'skipped', code: 'config', step: 'initial', reason: s.st.error });
  assert.deepEqual(s.passed, [], 'the row is not put aside');
  assert.deepEqual(s.configSkips, [['@chan', 'series_format_mismatch']]);
  assert.deepEqual(s.done, ['s1'], 'onSlotDone runs once');
});

test('A30 a config error and then nothing: skipped, retryAt never set, no second attempt', async () => {
  const s = setup([cfg('series_source_mismatch', 'the post cites another dataset')]);
  const res = await s.runner.runExecutor(s.st, s.card);
  assert.equal(res.status, 'max_steps', 'the run result is the first attempt\'s');
  assert.equal(s.runs.length, 1);
  assert.equal(s.st.status, 'skipped');
  assert.equal(s.st.retryAt, undefined, 'no 15-minute retry');
  assert.match(s.st.error, /^series_source_mismatch: the post cites another dataset/);
  assert.deepEqual(s.passed, []);
  assert.deepEqual(s.configSkips, [['@chan', 'series_source_mismatch']]);
});

test('A30 a config error on a ladder step: skipped with that reason, the step is recorded as `config`, the row is not put aside', async () => {
  const s = setup([lintFail, cfg('series_format_mismatch', 'wrong format')]);
  await s.runner.runExecutor(s.st, s.card);
  assert.equal(s.runs.length, 2, 'the initial attempt and one ladder step');
  assert.deepEqual(stepsOf(s.st), ['initial', 'next_candidate']);
  assert.equal(s.st.fallback.steps[0].outcome, 'lint');
  assert.equal(s.st.fallback.steps[1].outcome, 'config');
  assert.equal(s.st.fallback.steps[1].reason, 'series_format_mismatch: wrong format');
  assert.deepEqual(s.st.fallback.final, { outcome: 'skipped', code: 'config', step: 'next_candidate', reason: 'series_format_mismatch: wrong format' });
  assert.equal(s.st.status, 'skipped');
  assert.equal(s.st.error, 'series_format_mismatch: wrong format', 'the error is the config reason, not the lint failure of the first attempt');
  assert.deepEqual(s.passed, []);
  assert.deepEqual(s.configSkips, [['@chan', 'series_format_mismatch']], 'once, from the ladder path');
  assert.equal(s.st.retryAt, undefined);
});

test('A30 a content failure is untouched: lint on every attempt still climbs the ladder and is not a config skip', async () => {
  const s = setup([lintFail, lintFail, lintFail]);
  await s.runner.runExecutor(s.st, s.card);
  assert.ok(s.runs.length >= 2, 'the ladder ran');
  assert.deepEqual(s.configSkips, []);
  assert.deepEqual(gear(s.notes), []);
  assert.notEqual(s.st.fallback?.final?.code, 'config');
});

test('A27 the owner is told once a day per channel and code, in Ukrainian, with the fix', async () => {
  const s = setup([cfg('series_format_mismatch')]);
  const entry = reasonFor('series_format_mismatch')!;
  assert.ok(entry, 'the catalogue has the code');
  await s.runner.runExecutor(s.st, s.card);
  assert.deepEqual(gear(s.notes), [`⚙️ @chan: ${entry.uk}${entry.fix ? `. ${entry.fix.uk}` : ''}`]);

  // The same code, the same local day, a second slot: no second note, but the hook still fires.
  s.next('s2');
  await s.runner.runExecutor(s.st, s.card);
  assert.equal(gear(s.notes).length, 1, 'once a day');
  assert.equal(s.configSkips.length, 2, 'onConfigSkip is called for every config skip');

  // Another code the same day: its own note.
  s.next('s3', { scripts: [cfg('series_source_mismatch', 'x')] });
  await s.runner.runExecutor(s.st, s.card);
  assert.equal(gear(s.notes).length, 2);
  const source = reasonFor('series_source_mismatch');
  assert.ok(gear(s.notes)[1].startsWith(`⚙️ @chan: ${source ? source.uk : 'series_source_mismatch'}`), gear(s.notes)[1]);

  // Another channel, the same code: its own note.
  s.next('s4', { scripts: [cfg('series_format_mismatch')], channelKey: '@other' });
  await s.runner.runExecutor(s.st, makeCard({ channelKey: '@other', timezone: 'Europe/Kyiv' }));
  assert.equal(gear(s.notes).length, 3);
  assert.ok(gear(s.notes)[2].startsWith('⚙️ @other: '), gear(s.notes)[2]);

  // The next local day: the first code tells again.
  s.next('s5', { scripts: [cfg('series_format_mismatch')], at: new Date('2026-10-30T09:00:00Z') });
  await s.runner.runExecutor(s.st, s.card);
  assert.equal(gear(s.notes).length, 4, 'a new day tells again');
});

test('A27 the day is the card\'s local day: 21:30Z and 22:30Z on the same UTC date are different days in Kyiv', async () => {
  const s = setup([cfg('series_format_mismatch')]);
  s.next('s1', { at: new Date('2026-10-28T21:30:00Z') }); // 23:30 on the 28th in Kyiv
  await s.runner.runExecutor(s.st, s.card);
  s.next('s2', { at: new Date('2026-10-28T22:30:00Z') }); // 00:30 on the 29th
  await s.runner.runExecutor(s.st, s.card);
  assert.equal(gear(s.notes).length, 2);
});

test('A27 config_series_gone is not a miss: it ends the slot but sends no owner note', async () => {
  const s = setup([cfg('config_series_gone', 'series "Білет дня" is switched off')]);
  await s.runner.runExecutor(s.st, s.card);
  assert.equal(s.st.status, 'skipped');
  assert.match(s.st.error, /^config_series_gone: /);
  assert.deepEqual(s.configSkips, [['@chan', 'config_series_gone']]);
  assert.deepEqual(gear(s.notes), []);
});

test('A27 a throwing onConfigSkip does not fail the slot, and a failing notify is swallowed', async () => {
  const t = setup([cfg('series_format_mismatch')]);
  (t.runner as any).d.onConfigSkip = () => { throw new Error('hook down'); };
  (t.runner as any).d.notify = async () => { throw new Error('telegram down'); };
  await t.runner.runExecutor(t.st, t.card);
  assert.equal(t.st.status, 'skipped');
  assert.match(t.st.error, /^series_format_mismatch/);
  assert.deepEqual(t.done, ['s1']);
});
