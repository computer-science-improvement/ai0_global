// Spec 073 T11 (FR-010, A27, A30): a slot whose publish tool answered with a CONFIG failure (the series' format or source does not fit
// the post) ends skipped with that reason — no fallback step, no 15-minute retry, no row put aside. The owner is told once a day
// per channel and code; `onConfigSkip` fires once per config skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorRunnerService, executorToolNames, PLATFORM_ONLY, TELEGRAM_ONLY } from './editor-runner.service';
import { ToolRegistry } from '../harness/tool-registry';
import { buildReadTools } from '../tools/read-tools';
import { buildDataTools } from '../tools/data-tools';
import { buildHighlightsTools } from '../tools/highlights-tools';
import { buildApiTools } from '../tools/api-tools';
import { buildRoleTools } from '../tools/role-tools';
import { buildPlatformTools } from '../platform/platform-tools';
import { pdrCase, promptsCase, type OnboardingCase } from '../readiness/fixtures/onboarding-1027';
import { checkSlotConfig, SOURCE_READ_TOOLS } from '../readiness/slot-config';
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

interface SetupOpts {
  slot?: any; card?: any;
  /** Spec 073 T12: the config gate's ports. `context` gets the tools the gate computed; `patch` is applied to the slot like `patchSlotConfig` does. */
  gate?: { context: (tools: ReadonlySet<string> | null) => Promise<any> | any; patch?: false | 'throw' };
  /** A registry other than the two fake terminal tools (the real tool builders, see `realRegistry`). */
  registry?: any;
  loadoutAllow?: string[] | null;
}

function setup(scripts: Script[], o: SetupOpts = {}) {
  const st: any = { ...(o.slot ?? baseSlot), status: 'running', error: null, critic: null };
  const runs: any[] = [];
  const passed: any[] = [];
  const configSkips: Array<[string, string]> = [];
  const notes: string[] = [];
  const done: string[] = [];
  const seen: Array<ReadonlySet<string> | null> = [];
  const patches: Array<{ id: string; format?: string; sourceHints?: string[]; note: string }> = [];
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
        if (!script.length) {
          // No script: the run just publishes (the tool-set tests only read what the loop was handed).
          Object.assign(st, { status: 'published' });
          return { runId: `r${runs.length}`, status: 'ok', terminalTool: 'publish_post', totals: { steps: 1, promptTokens: 0, completionTokens: 0, costUsd: 0.01 } } as any;
        }
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
    registry: o.registry ?? { forRole: () => [publish, skipTool] as any },
    ...(o.loadoutAllow !== undefined ? { loadout: { allowFor: async () => o.loadoutAllow } } : {}),
    ...(o.gate ? {
      slotConfig: {
        context: async (_card: any, _slot: any, c: { tools: ReadonlySet<string> | null }) => { seen.push(c.tools); return o.gate!.context(c.tools); },
        patch: async (id: string, r: { format?: string; sourceHints?: string[]; note: string }) => {
          if (o.gate!.patch === 'throw') throw new Error('db down');
          if (o.gate!.patch === false || st.status !== 'running') return null;
          patches.push({ id, ...r });
          // Like patchSlotConfig: the given fields change, the note is appended to fallback.repairs, steps and final stay.
          if (r.format) st.format = r.format;
          if (r.sourceHints) st.sourceHints = r.sourceHints;
          st.fallback = { steps: st.fallback?.steps ?? [], final: st.fallback?.final ?? null, ...st.fallback, repairs: [...(st.fallback?.repairs ?? []), { at: clock.toISOString(), note: r.note }] };
          return { ...st };
        },
      },
    } : {}),
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
    runner, st, runs, passed, configSkips, notes, done, seen, patches, card: o.card ?? makeCard({ channelKey: '@chan', timezone: 'Europe/Kyiv' }),
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

// ── Spec 073 T12: the config gate (FR-009, A7, A12, A15, A32, A50) ──────────────────────────────────────

/** The real tool builders over stub deps: the tool NAMES and roles are the real ones (nothing is executed). */
function realRegistry(): ToolRegistry {
  const stub: any = { pool: { query: async () => ({ rows: [] }) }, env: () => undefined, actions: {}, plans: {}, memory: {}, channels: {}, publisher: {}, publish: {} };
  return new ToolRegistry([...buildReadTools(stub), ...buildDataTools(stub), ...buildHighlightsTools(stub), ...buildApiTools(stub), ...buildRoleTools(stub), ...buildPlatformTools(stub)]);
}
const namesOf = (run: any): string[] => run.tools.map((t: any) => t.name).sort();

/** The slot row the planner left for a case of the onboarding fixture. */
const slotOf = (c: OnboardingCase, over: Record<string, unknown> = {}): any => ({
  ...baseSlot, channelKey: c.channelKey, resourceRef: c.resourceRef, format: c.slot.format, seriesName: c.slot.seriesName, sourceHints: [...c.slot.sourceHints], ...over,
});
const cardOf = (c: OnboardingCase, over: Record<string, unknown> = {}) => makeCard({ ...c.card, timezone: 'Europe/Kyiv', ...over });
const withTools = (c: OnboardingCase, over: Record<string, unknown> = {}) => (tools: ReadonlySet<string> | null) => c.ctx({ ...(tools ? { tools } : {}), ...over });

test('A7/A15 a repairable slot is patched and goes on to the writer: one patch, one note in fallback.repairs, the writer gets the quiz', async () => {
  const c = pdrCase();
  const s = setup([], { slot: slotOf(c), card: cardOf(c), registry: realRegistry(), gate: { context: withTools(c) } });
  await s.runner.runExecutor(s.st, s.card);
  assert.equal(s.runs.length, 1, 'the writer ran once, after the repair');
  assert.deepEqual(s.patches, [{ id: 's1', format: 'quiz', note: 'config_format_mismatch: text → quiz' }]);
  assert.equal(s.st.format, 'quiz');
  assert.deepEqual(s.st.fallback.repairs, [{ at: NOW.toISOString(), note: 'config_format_mismatch: text → quiz' }]);
  assert.match(s.runs[0].user, /quiz/, 'the prompt is built from the patched row');
  assert.deepEqual(s.configSkips, []);
  assert.deepEqual(gear(s.notes), []);
});

test('A7 the source hints of @prompts are repaired to series + next row before the writer runs', async () => {
  const c = promptsCase();
  const s = setup([], { slot: slotOf(c), card: cardOf(c), registry: realRegistry(), gate: { context: withTools(c) } });
  await s.runner.runExecutor(s.st, s.card);
  assert.equal(s.runs.length, 1);
  assert.deepEqual(s.st.sourceHints, ['series:Prompt', 'data://nanobanana_prompts/503']);
  assert.equal(s.patches.length, 1);
  assert.equal(s.patches[0].note, 'config_source_mismatch: hints → series:Prompt, data://nanobanana_prompts/503');
});

test('A15 a gone series skips with its code at $0: no writer run, no row put aside, onConfigSkip fires, no owner note (not a miss)', async () => {
  const c = promptsCase();
  const s = setup([], { slot: slotOf(c, { seriesName: 'Removed' }), card: cardOf(c), registry: realRegistry(), gate: { context: withTools(c) } });
  const res = await s.runner.runExecutor(s.st, s.card);
  assert.equal(s.runs.length, 0, 'no model call');
  assert.equal(res.status, 'disabled');
  assert.equal(s.st.status, 'skipped');
  assert.match(s.st.error, /^config_series_gone: /);
  assert.deepEqual(s.configSkips, [[c.channelKey, 'config_series_gone']]);
  assert.deepEqual(gear(s.notes), [], 'the owner removed it themselves');
  assert.deepEqual(s.passed, []);
  assert.deepEqual(s.done, ['s1']);
});

test('A15 a problem that cannot be repaired ends the slot: the code leads the error, onConfigSkip fires per slot, the owner hears once a day', async () => {
  const c = promptsCase();
  // The channel allows only web_fetch: the library read tools are gone (F28).
  const card = cardOf(c, { toolsAllow: ['web_fetch'] });
  const hints = ['series:Prompt'];
  const s = setup([], { slot: slotOf(c, { sourceHints: hints }), card, registry: realRegistry(), gate: { context: withTools(c) } });
  await s.runner.runExecutor(s.st, s.card);
  assert.equal(s.runs.length, 0);
  assert.match(s.st.error, /^config_tools_missing: /);
  assert.deepEqual(s.configSkips, [[c.channelKey, 'config_tools_missing']]);
  assert.equal(gear(s.notes).length, 1);
  assert.match(gear(s.notes)[0], /^⚙️ @ai0_prompts_dev: /);
  assert.deepEqual(s.patches, [], 'nothing repairable, nothing written');
  // A second slot of the same channel on the same day: the hook fires again, the owner is not told again.
  s.next('s2', { channelKey: c.channelKey });
  Object.assign(s.st, slotOf(c, { id: 's2', sourceHints: hints }), { status: 'running', error: null, fallback: null });
  await s.runner.runExecutor(s.st, s.card);
  assert.deepEqual(s.configSkips.map((x) => x[1]), ['config_tools_missing', 'config_tools_missing']);
  assert.equal(gear(s.notes).length, 1, 'one note a day per channel and code');
});

test('L4 preflight_no_material from the gate is material, not config: it skips, but no onConfigSkip and no owner note', async () => {
  const c = pdrCase();
  const s = setup([], { slot: slotOf(c, { format: 'quiz' }), card: cardOf(c), registry: realRegistry(), gate: { context: withTools(c, { material: 'empty', nextRow: null }) } });
  await s.runner.runExecutor(s.st, s.card);
  assert.equal(s.runs.length, 0);
  assert.match(s.st.error, /^preflight_no_material: /);
  assert.deepEqual(s.configSkips, []);
  assert.deepEqual(gear(s.notes), []);
});

test('A15 a check that cannot run lets the slot go on: a null context, a throwing context and a throwing patch all fall through to the writer', async () => {
  const c = pdrCase();
  const base = { slot: slotOf(c), card: cardOf(c), registry: realRegistry() };
  const nul = setup([], { ...base, gate: { context: () => null } });
  await nul.runner.runExecutor(nul.st, nul.card);
  assert.equal(nul.runs.length, 1, 'nothing to check');
  assert.equal(nul.st.format, 'text', 'and nothing patched');
  const boom = setup([], { ...base, gate: { context: () => { throw new Error('db down'); } } });
  await boom.runner.runExecutor(boom.st, boom.card);
  assert.equal(boom.runs.length, 1, 'a read error never stops a slot');
  const patchBoom = setup([], { ...base, gate: { context: withTools(c), patch: 'throw' } });
  await patchBoom.runner.runExecutor(patchBoom.st, patchBoom.card);
  assert.equal(patchBoom.runs.length, 1, 'a failed write falls through too');
  assert.equal(patchBoom.configSkips.length, 0);
});

test('A15 a patch that finds the slot no longer running (null) leaves the problem standing: the slot is skipped with it', async () => {
  const c = pdrCase();
  const s = setup([], { slot: slotOf(c), card: cardOf(c), registry: realRegistry(), gate: { context: withTools(c), patch: false } });
  await s.runner.runExecutor(s.st, s.card);
  assert.equal(s.runs.length, 0);
  assert.match(s.st.error, /^config_format_mismatch: /);
  assert.deepEqual(s.configSkips, [[c.channelKey, 'config_format_mismatch']]);
});

test('A32 fallback.repairs survives the ladder: a repaired slot whose post then fails lint keeps its repair note next to the steps', async () => {
  const c = pdrCase();
  // The fake registry here has only the two terminal tools, so the check gets the fixture's default executor tools.
  const s = setup([lintFail, lintFail, lintFail], { slot: slotOf(c), card: cardOf(c), gate: { context: () => c.ctx() } });
  await s.runner.runExecutor(s.st, s.card);
  assert.ok(s.runs.length >= 2, 'the ladder ran');
  assert.ok(stepsOf(s.st).length >= 2);
  assert.deepEqual(s.st.fallback.repairs.map((r: any) => r.note), ['config_format_mismatch: text → quiz']);
  assert.equal(s.patches.length, 1, 'repaired once, not once per attempt');
});

test('A32 fallback.repairs survives a slot that goes back to planned for the next tick, whose second check finds nothing left to repair', async () => {
  const c = pdrCase();
  const noPublish: Script = async () => ({ error: 'timeout' });
  const s = setup([noPublish], { slot: slotOf(c), card: cardOf(c), gate: { context: () => c.ctx() } });
  await s.runner.runExecutor(s.st, s.card);
  assert.equal(s.runs.length, 1, 'the writer ran');
  assert.equal(s.st.status, 'planned', 'no terminal tool succeeded: the slot waits 15 minutes');
  assert.ok(s.st.retryAt, 'with a retry time');
  assert.deepEqual((s.st.fallback?.repairs ?? []).map((r: any) => r.note), ['config_format_mismatch: text → quiz']);
  // The tick picks the slot up again: it is a quiz now, so the check is clean and no second note is written.
  Object.assign(s.st, { status: 'running', error: null });
  await s.runner.runExecutor(s.st, s.card);
  assert.equal(s.patches.length, 1);
  assert.equal(s.st.fallback.repairs.length, 1);
});

// A50: what the check counts as available is exactly what the run hands the model.
async function toolsBoth(o: { ref: string; toolsAllow?: string[] | null; loadoutAllow?: string[] | null }) {
  const c = pdrCase();
  const s = setup([], {
    slot: slotOf(c, { resourceRef: o.ref }), card: cardOf(c, { toolsAllow: o.toolsAllow ?? null }), registry: realRegistry(),
    ...(o.loadoutAllow !== undefined ? { loadoutAllow: o.loadoutAllow } : {}), gate: { context: () => null },
  });
  await s.runner.runExecutor(s.st, s.card);
  assert.equal(s.runs.length, 1);
  assert.equal(s.seen.length, 1);
  return { run: namesOf(s.runs[0]), seen: [...(s.seen[0] ?? [])].sort() };
}

test('A50 a Telegram slot: the gate\'s tool set is the run\'s tool set, with and without a channel allowlist and a loadout', async () => {
  const ref = 'telegram:@pdr_dev_channel';
  for (const o of [
    { ref },
    { ref, toolsAllow: ['web_fetch', 'query_data'] },
    { ref, loadoutAllow: ['query_data', 'search_library', 'publish_post'] },
    { ref, toolsAllow: ['query_data', 'web_fetch'], loadoutAllow: ['query_data', 'search_library'] },
  ]) {
    const r = await toolsBoth(o);
    assert.deepEqual(r.seen, r.run, JSON.stringify(o));
    assert.ok(!r.seen.some((n) => PLATFORM_ONLY.has(n)), 'no platform tool on a Telegram slot');
    assert.ok(r.seen.includes('publish_post') && r.seen.includes('skip_slot'), 'the terminal tools stay');
  }
  const wide = await toolsBoth({ ref });
  for (const t of ['query_data', 'search_library', 'fetch_feed', 'web_fetch', 'fetch_api', 'get_network_highlights']) assert.ok(wide.seen.includes(t), t);
  const narrow = await toolsBoth({ ref, toolsAllow: ['web_fetch', 'query_data'] });
  assert.ok(narrow.seen.includes('query_data') && narrow.seen.includes('web_fetch'));
  assert.ok(!narrow.seen.includes('search_library') && !narrow.seen.includes('fetch_feed'));
});

test('A50 a platform slot: the same, with the Telegram-only tools left out', async () => {
  const ref = 'instagram:pdr_ig';
  for (const o of [
    { ref },
    { ref, toolsAllow: ['web_fetch', 'query_data'] },
    { ref, loadoutAllow: ['query_data', 'publish_platform_post'] },
  ]) {
    const r = await toolsBoth(o);
    assert.deepEqual(r.seen, r.run, JSON.stringify(o));
    assert.ok(!r.seen.some((n) => TELEGRAM_ONLY.has(n)), 'no Telegram tool on a platform slot');
    assert.ok(r.seen.includes('publish_platform_post') && r.seen.includes('skip_slot'));
  }
});

test('A50 executorToolNames is pure: the same registry and exclusions give the Telegram and the platform view of the executor', () => {
  const reg = realRegistry();
  const card = { toolsAllow: null };
  const tg = executorToolNames(card, { registry: reg, loadoutAllow: null, exclude: PLATFORM_ONLY });
  const pf = executorToolNames(card, { registry: reg, loadoutAllow: null, exclude: TELEGRAM_ONLY });
  assert.ok(tg.has('publish_post') && !tg.has('publish_platform_post'));
  assert.ok(pf.has('publish_platform_post') && !pf.has('publish_post'));
  // The writer never gets the card tools it does not need (spec 053), so the check does not count them either.
  assert.ok(!tg.has('sql_readonly') && !tg.has('get_channel_card'));
});

test('A12 a source-read tool of the right kind is enough: library passes with query_data or search_library alone; tools:null never skips', () => {
  const c = pdrCase();
  const slot = { ...c.slot, format: 'quiz' };
  const run = (tools: string[]) => checkSlotConfig(slot, c.ctx({ tools: new Set(tools) })).map((p) => p.code);
  assert.deepEqual([...SOURCE_READ_TOOLS.library].sort(), ['query_data', 'search_library']);
  assert.deepEqual(run(['query_data', 'publish_post']), []);
  assert.deepEqual(run(['search_library', 'publish_post']), []);
  assert.deepEqual(run(['web_fetch', 'publish_post']), ['config_tools_missing']);
  assert.deepEqual(run([]), ['config_tools_missing'], 'an allowlist that removed everything');
  assert.deepEqual(checkSlotConfig(slot, c.ctx({ tools: null })).map((p) => p.code), []);
});
