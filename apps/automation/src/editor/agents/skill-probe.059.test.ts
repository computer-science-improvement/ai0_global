/**
 * Spec 059 T2: the skill probe with fakes only — the decision table, the pairing and the random order mapped back, the
 * budget cut-off, the daily cap, the cases that adopt as before, and the Inbox note. No database, no network, no LLM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SlotPreview } from '../roles/preview-run';
import type { SkillOverride } from '../skills/skill-overlay';
import { AgentLoop } from '../harness/agent-loop';
import { FakeBudget, FakeLlm, MemoryRecorder } from '../harness/testing/fakes';
import {
  CRITIC_LADDER, decideProbe, probeNote, probeReasons, probeSettings, SkillProbe, sideOf, type SkillProbeDeps,
} from './skill-probe';
import { LlmPairwiseJudge, judgeUserPrompt, type JudgeInput, type PairwiseJudge } from './skill-probe-judge';
import { skillRelevance } from './skill-probe-samples';
import { settingDef, normalizeSetting } from '../../settings/catalog';
import { isKnownFeature } from '../../common/ai/usage/features';
import type { ProbeJudgement, ProbeRecord, ProbeSample, ProbeSide, SideCritic } from './skill-probe.types';

const NOW = new Date('2030-05-06T09:00:00Z');
const AGENT = { id: 'a1', handle: 'kira', parentId: null, scope: 'resource', scopeId: 'telegram:@k' } as any;

const side = (critic: SideCritic = 'pass', preview: string | null = 'текст'): ProbeSide => ({ critic, lint: 0, chars: preview?.length ?? 0, preview });
const sample = (better: ProbeJudgement['better'], o: { old?: SideCritic; new?: SideCritic } = {}): ProbeSample => ({
  slotId: 's', topic: 't', old: side(o.old), new: side(o.new), judge: { better, reasons: [`причина ${better}`], risks: [], by: 'judge' },
});

// ── the decision table ──────────────────────────────────────────────────────

test('decideProbe: adopt needs a win, no worse critic verdict and a majority of wins or ties', () => {
  assert.equal(decideProbe([sample('new'), sample('new'), sample('same')]).verdict, 'adopted');
  assert.equal(decideProbe([sample('new'), sample('same'), sample('old')]).verdict, 'adopted', '1 win + 1 tie of 3 is a majority of non-losses');
  assert.equal(decideProbe([sample('same'), sample('same'), sample('same')]).verdict, 'inconclusive', 'ties only: nothing was gained');
  assert.equal(decideProbe([sample('new'), sample('old'), sample('old')]).verdict, 'rejected', 'lost most pairs');
  assert.equal(decideProbe([sample('new', { old: 'pass', new: 'pass_with_edits' }), sample('new'), sample('new')]).verdict, 'inconclusive', 'one post rated lower by the critic');
});

test('decideProbe: a new reject or revise the old text did not get rejects the version', () => {
  const d = decideProbe([sample('new', { old: 'pass', new: 'revise' }), sample('new'), sample('new')]);
  assert.equal(d.verdict, 'rejected');
  assert.match(d.reason, /revise where the old text's post was pass/);
  // The same verdict on both sides is not the new text's fault.
  assert.equal(decideProbe([sample('same', { old: 'revise', new: 'revise' }), sample('new'), sample('new')]).verdict, 'adopted');
});

test('decideProbe: no usable pair is unprobed; a budget cut is inconclusive; one pair is enough', () => {
  assert.equal(decideProbe([], { dropped: 3 }).verdict, 'unprobed');
  assert.equal(decideProbe([], { cut: 'the probe budget $0.30 ran out' }).verdict, 'inconclusive');
  assert.equal(decideProbe([sample('new'), sample('new')], { cut: 'the probe budget $0.30 ran out' }).verdict, 'inconclusive');
  assert.equal(decideProbe([sample('new')]).verdict, 'adopted');
  assert.equal(decideProbe([sample('old')]).verdict, 'rejected');
  assert.ok(CRITIC_LADDER.pass > CRITIC_LADDER.pass_with_edits && CRITIC_LADDER.pass_with_edits > CRITIC_LADDER.revise && CRITIC_LADDER.revise > CRITIC_LADDER.reject);
});

const preview = (o: Partial<SlotPreview> = {}): SlotPreview => ({
  status: 'ready', platform: 'telegram', preview: 'пост', spec: null, critic: { verdict: 'pass' } as any, reason: null, warnings: [], runId: 'r', costUsd: 0.01,
  startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), ...o,
});

test('sideOf: a ready preview is a side, a post the critic stopped is evidence without text, anything else is dropped', () => {
  assert.deepEqual(sideOf(preview({ warnings: ['a', 'b'] })), { critic: 'pass', lint: 2, chars: 4, preview: 'пост' });
  assert.deepEqual(sideOf(preview({ status: 'rejected', preview: null, critic: { verdict: 'reject' } as any })), { critic: 'reject', lint: 0, chars: 0, preview: null });
  assert.equal(sideOf(preview({ status: 'failed', preview: null, critic: null })), null);
  assert.equal(sideOf(preview({ status: 'skipped', preview: null })), null);
  assert.equal(sideOf(preview({ critic: { verdict: 'error' } as any })), null);
  assert.equal(sideOf(preview({ preview: 'я'.repeat(2000) }))!.preview!.length, 600);
});

test('probeSettings: defaults, clamps, junk falls back', () => {
  assert.deepEqual(probeSettings(() => undefined), { perDay: 3, samples: 3, budgetUsd: 0.3 });
  const env: Record<string, string> = { SKILL_PROBE_PER_DAY: '99', SKILL_PROBE_SAMPLES: '0', SKILL_PROBE_BUDGET_USD: 'abc' };
  assert.deepEqual(probeSettings((k) => env[k]), { perDay: 20, samples: 1, budgetUsd: 0.3 });
  assert.equal(probeSettings((k) => (k === 'SKILL_PROBE_PER_DAY' ? '0' : undefined)).perDay, 0);
});

test('skillRelevance reads the format or platform a skill is about from its name', () => {
  assert.deepEqual(skillRelevance('format-photo-post'), { format: 'photo_post', platform: null });
  assert.deepEqual(skillRelevance('platform-instagram'), { format: null, platform: 'instagram' });
  assert.deepEqual(skillRelevance('seasonal-hooks'), { format: null, platform: null });
});

// ── the probe ───────────────────────────────────────────────────────────────

const WAITING = {
  id: 11, skillId: 'sk1', version: 3, body: 'НОВИЙ текст скіла', description: 'опис', appliesTo: ['executor'], author: 'agent', authorAgentId: 'a1',
  reason: 'перший рядок із сезоном дає більше переглядів', kpiBaseline: null, reviewAt: null, outcome: 'probing', outcomeDetail: null, probe: null,
  createdAt: new Date('2030-05-05T10:00:00Z'), agentId: 'a1', skillName: 'seasonal-hooks', liveVersion: 2,
} as any;

type Calls = { adopted: any[]; rejected: any[]; notes: any[]; remembered: any[]; runs: Array<{ slotId: string; override: SkillOverride | null; max: number }>; judged: JudgeInput[] };

function setup(o: {
  waiting?: any[]; settings?: Partial<ReturnType<typeof probeSettings>>; doneToday?: number; slots?: number; entryEnabled?: boolean;
  run?: (slotId: string, o: { override: SkillOverride | null; maxCostUsd: number }) => Promise<SlotPreview>;
  judge?: PairwiseJudge; rng?: () => number; adoptOk?: boolean;
} = {}) {
  const c: Calls = { adopted: [], rejected: [], notes: [], remembered: [], runs: [], judged: [] };
  const slots = Array.from({ length: o.slots ?? 3 }, (_, i) => ({ slotId: `s${i + 1}`, channelKey: '@k', topic: `тема ${i + 1}`, format: 'photo' }));
  const deps: SkillProbeDeps = {
    skills: {
      probing: async () => o.waiting ?? [WAITING],
      get: async () => ({ id: 'sk1', currentVersion: 2 }) as any,
      probesSince: async () => o.doneToday ?? 0,
      listForAgent: async () => [{ skill: { id: 'sk1', appliesTo: ['executor'] }, enabled: o.entryEnabled ?? true, inline: false }] as any,
      adoptVersion: async (skillId, version, a) => { c.adopted.push({ skillId, version, ...a }); return o.adoptOk === false ? null : ({ id: skillId }) as any; },
      rejectVersion: async (skillId, version, probe) => { c.rejected.push({ skillId, version, probe }); return true; },
    },
    agents: { get: async () => AGENT },
    inbox: { post: async (i: any) => { c.notes.push(i); return 1; } },
    settings: () => ({ perDay: 3, samples: 3, budgetUsd: 0.3, ...o.settings }),
    pick: async (_a, _n, limit) => slots.slice(0, limit),
    run: async (slotId, x) => {
      c.runs.push({ slotId, override: x.override, max: x.maxCostUsd });
      if (o.run) return o.run(slotId, x);
      return preview({ preview: x.override ? `НОВИЙ пост ${slotId}` : `старий пост ${slotId}`, costUsd: 0.02 });
    },
    judge: o.judge ?? {
      // Prefers whichever post is the new one, by its text, whatever side it is on.
      compare: async (i) => { c.judged.push(i); return { ok: true, verdict: { better: i.a.text.startsWith('НОВИЙ') ? 'A' : 'B', reasons: ['конкретніше'], risks: [] }, costUsd: 0.01 }; },
    },
    remember: async (agent, text, evidence) => { c.remembered.push({ agent, text, evidence }); },
    rng: o.rng ?? (() => 0.1),
    now: () => NOW,
  };
  return { probe: new SkillProbe(deps), c };
}

test('adopt: both texts run on every sample, the judge sees the posts in random order and the answer is mapped back to old / new', async () => {
  for (const rng of [() => 0.1, () => 0.9]) {
    const { probe, c } = setup({ rng });
    const r = await probe.run();
    assert.deepEqual(r, { adopted: 1, rejected: 0, inconclusive: 0, unprobed: 0, deferred: 0 });
    assert.equal(c.runs.length, 6, 'old + new on each of 3 slots');
    assert.deepEqual(c.runs.filter((x) => x.override).map((x) => x.override!.body), ['НОВИЙ текст скіла', 'НОВИЙ текст скіла', 'НОВИЙ текст скіла']);
    assert.equal(c.runs.filter((x) => !x.override).length, 3, 'the old run reads the live text');
    // The new post is A when the rng says old goes second, B otherwise.
    assert.ok(c.judged.every((j) => (rng() < 0.5 ? j.b.text.startsWith('НОВИЙ') : j.a.text.startsWith('НОВИЙ'))));
    assert.equal(c.adopted.length, 1);
    const rec: ProbeRecord = c.adopted[0].probe;
    assert.equal(rec.verdict, 'adopted');
    assert.deepEqual(rec.samples.map((s) => s.judge.better), ['new', 'new', 'new']);
    assert.deepEqual(c.adopted[0].from, ['probing']);
    assert.equal(c.adopted[0].reviewAt.toISOString(), '2030-05-13T09:00:00.000Z', '7 days of KPI review start now');
    assert.ok(rec.costUsd > 0.1);
    assert.equal(c.notes.length, 1);
    assert.equal(c.notes[0].kind, 'skill_probe');
    assert.match(c.notes[0].title, /passed the check and is live/);
    assert.match(c.notes[0].alert.title, /пройшов перевірку/);
    assert.deepEqual(c.remembered, []);
  }
});

test('reject: the version is rejected, an avoid line with evidence is remembered and the note offers the way back', async () => {
  const { probe, c } = setup({
    judge: { compare: async (i) => ({ ok: true, verdict: { better: i.a.text.startsWith('НОВИЙ') ? 'B' : 'A', reasons: ['новий штампований'], risks: ['ризик'] }, costUsd: 0.01 }) },
  });
  const r = await probe.run();
  assert.equal(r.rejected, 1);
  assert.equal(c.adopted.length, 0);
  assert.equal(c.rejected.length, 1);
  assert.equal(c.rejected[0].probe.verdict, 'rejected');
  assert.equal(c.remembered.length, 1);
  assert.match(c.remembered[0].text, /Не повторювати зміну скіла «seasonal-hooks»/);
  assert.equal(c.remembered[0].evidence.source, 'skill_probe');
  assert.equal(c.remembered[0].evidence.version, 3);
  assert.equal(c.remembered[0].evidence.losses, 3);
  assert.match(c.notes[0].title, /rejected by the check, v2 stays live/);
  assert.match(c.notes[0].body, /Adopt anyway/);
  assert.match(c.notes[0].alert.title, /відхилено перевіркою, діє v2/);
});

test('a critic reject on the new post alone rejects the version without asking the judge about that pair', async () => {
  const { probe, c } = setup({
    run: async (_s, x) => (x.override
      ? preview({ status: 'rejected', preview: null, critic: { verdict: 'reject' } as any, costUsd: 0.02 })
      : preview({ costUsd: 0.02 })),
  });
  const r = await probe.run();
  assert.equal(r.rejected, 1);
  assert.equal(c.judged.length, 0, 'code decided every pair: the new text produced no post');
  assert.ok(c.rejected[0].probe.samples.every((s: ProbeSample) => s.judge.by === 'code' && s.judge.better === 'old'));
});

test('budget: the probe stops when its cap is spent, with what it has; inconclusive means adopt as before', async () => {
  const { probe, c } = setup({ settings: { budgetUsd: 0.3 }, run: async (_s, x) => preview({ preview: x.override ? 'НОВИЙ' : 'старий', costUsd: 0.2 }) });
  const r = await probe.run();
  assert.equal(r.inconclusive, 1);
  assert.equal(c.runs.length, 2, 'the second slot never started');
  assert.ok(c.runs[0].max <= 0.3 && c.runs[1].max < c.runs[0].max, 'each run gets what is left');
  assert.equal(c.adopted.length, 1, 'inconclusive adopts');
  assert.match(c.adopted[0].probe.reason, /budget \$0\.30 ran out/);
  assert.match(c.notes[0].title, /inconclusive, the new text is live/);
});

test('daily cap: past SKILL_PROBE_PER_DAY probes today the version waits; within it, probes run oldest first', async () => {
  const capped = setup({ doneToday: 3 });
  assert.deepEqual(await capped.probe.run(), { adopted: 0, rejected: 0, inconclusive: 0, unprobed: 0, deferred: 1 });
  assert.equal(capped.c.runs.length, 0);
  assert.equal(capped.c.adopted.length + capped.c.rejected.length, 0);

  const second = { ...WAITING, id: 12, skillId: 'sk2', skillName: 'other' };
  const two = setup({ doneToday: 2, waiting: [WAITING, second] });
  const r = await two.probe.run();
  assert.equal(r.adopted, 1, 'the oldest takes the last free place today');
  assert.equal(r.deferred, 1);
  assert.equal(two.c.adopted[0].skillId, 'sk1');
});

test('probes off or budget 0: the edit is adopted as before, marked unprobed with the reason', async () => {
  for (const settings of [{ perDay: 0 }, { budgetUsd: 0 }]) {
    const { probe, c } = setup({ settings });
    const r = await probe.run();
    assert.equal(r.unprobed, 1);
    assert.equal(c.runs.length, 0);
    assert.equal(c.adopted[0].probe.verdict, 'unprobed');
    assert.match(c.adopted[0].probe.reason, /switched off|budget is 0/);
    assert.match(c.notes[0].title, /applied without a check/);
  }
});

test('nothing to probe on, or a writer that does not read the skill: adopted as before, unprobed', async () => {
  const none = setup({ slots: 0 });
  assert.equal((await none.probe.run()).unprobed, 1);
  assert.match(none.c.adopted[0].probe.reason, /no recent published or approved posts/);

  const off = setup({ entryEnabled: false });
  assert.equal((await off.probe.run()).unprobed, 1);
  assert.match(off.c.adopted[0].probe.reason, /writer does not read this skill/);
  assert.equal(off.c.runs.length, 0);
});

test('runs that throw or fail are dropped; a judge that does not answer counts the pair as a tie; all dropped is unprobed', async () => {
  const allFail = setup({ run: async () => { throw new Error('boom'); } });
  const r = await allFail.probe.run();
  assert.equal(r.unprobed, 1);
  assert.match(allFail.c.adopted[0].probe.reason, /no usable pair/);

  const mute = setup({ judge: { compare: async () => ({ ok: false, error: 'timeout', costUsd: 0.01 }) } });
  const m = await mute.probe.run();
  assert.equal(m.inconclusive, 1, 'ties only: nothing was gained, so the edit goes live as today');
  assert.match(mute.c.adopted[0].probe.samples[0].judge.reasons[0], /judge did not answer: timeout/);
});

test('a version decided meanwhile (adopt refused) sends no note; a failing note does not stop the probe', async () => {
  const gone = setup({ adoptOk: false });
  await gone.probe.run();
  assert.equal(gone.c.notes.length, 0);

  const c = setup();
  (c.probe as any).d.inbox = { post: async () => { throw new Error('inbox down'); } };
  assert.equal((await c.probe.run()).adopted, 1);
});

test('two overlapping runs do not probe the same version twice', async () => {
  const { probe, c } = setup();
  const [a, b] = await Promise.all([probe.run(), probe.run()]);
  assert.equal(a.adopted + b.adopted, 1);
  assert.equal(c.adopted.length, 1);
});

test('probeNote and probeReasons: wins carry the winner\'s reasons, Ukrainian alert on every verdict', () => {
  const rec: ProbeRecord = {
    verdict: 'adopted', reason: 'x', samples: [sample('new'), sample('old')], costUsd: 0.12, at: NOW.toISOString(),
  };
  assert.deepEqual(probeReasons(rec, 'new'), ['причина new', 'причина old']);
  for (const verdict of ['adopted', 'rejected', 'inconclusive', 'unprobed'] as const) {
    const n = probeNote({ id: 'a1', handle: 'kira' }, { id: 'sk1', name: 'seasonal-hooks' }, 3, 2, { ...rec, verdict }, 'бо так');
    assert.equal(n.refType, 'skill');
    assert.equal(n.refId, 'sk1');
    assert.ok(n.alert?.title && n.alert.body, verdict);
    assert.match(n.title, /@kira/);
  }
});

// ── the judge ───────────────────────────────────────────────────────────────

const judgeInput: JudgeInput = {
  skill: 'seasonal-hooks', topic: 'Туманність', platform: 'telegram', format: 'photo', context: 'Бриф: космос',
  a: { text: 'пост А', critic: 'pass', lint: 0, chars: 6 }, b: { text: 'пост Б', critic: 'revise', lint: 1, chars: 6 },
};

function judgeOf(turns: ConstructorParameters<typeof FakeLlm>[0]) {
  const llm = new FakeLlm(turns);
  const used: Array<{ feature?: string; role?: string; model: string }> = [];
  const real = new AgentLoop({ llm, recorder: new MemoryRecorder(), budget: new FakeBudget(), enabled: () => true });
  const loop = { run: async (i: any) => { used.push({ feature: i.usage?.feature, role: i.role, model: i.model?.model ?? i.model }); return real.run(i); } } as any;
  return { judge: new LlmPairwiseJudge({ loop, env: () => undefined, criticModel: async () => 'critic/model-x' }), llm, used };
}

test('LlmPairwiseJudge: one terminal tool on the critic model, spend as editor.probe, the posts and the signals in the prompt', async () => {
  const { judge, llm, used } = judgeOf([{ calls: [{ name: 'submit_comparison', args: { better: 'B', reasons: ['конкретніше'], risks: [] } }], cost: 0.004 }]);
  const r = await judge.compare(judgeInput, { channelKey: '@k', maxCostUsd: 0.1 });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual([r.verdict.better, r.verdict.reasons], ['B', ['конкретніше']]);
  assert.deepEqual(used, [{ feature: 'editor.probe', role: 'checker', model: 'critic/model-x' }]);
  const user = String(llm.requests[0].messages.find((m) => m.role === 'user')!.content);
  assert.match(user, /пост А/);
  assert.match(user, /вердикт критика revise/);
  assert.match(user, /seasonal-hooks/);
  assert.ok(!/старий|новий|old|new/i.test(judgeUserPrompt(judgeInput).replace(/seasonal-hooks/g, '')), 'the judge is not told which side is which');
});

test('LlmPairwiseJudge: an invalid or missing verdict is retried once, then ok:false — it never throws', async () => {
  const bad = judgeOf([
    { calls: [{ name: 'submit_comparison', args: { better: 'C' } }], cost: 0.001 },
    { calls: [{ name: 'submit_comparison', args: { better: 'X' } }], cost: 0.001 },
  ]);
  const r = await bad.judge.compare(judgeInput, { channelKey: '@k', maxCostUsd: 0.1 });
  assert.equal(r.ok, false);

  const retry = judgeOf([
    { calls: [{ name: 'submit_comparison', args: { better: 'nope' } }], cost: 0.001 },
    { calls: [{ name: 'submit_comparison', args: { better: 'same', reasons: [], risks: [] } }], cost: 0.001 },
  ]);
  const ok = await retry.judge.compare(judgeInput, { channelKey: '@k', maxCostUsd: 0.1 });
  assert.equal(ok.ok, true);
});

test('the three settings are in the catalog with the defaults the probe uses, and editor.probe is a known spend feature', () => {
  const defaults = probeSettings(() => undefined);
  for (const [key, want] of [['SKILL_PROBE_PER_DAY', defaults.perDay], ['SKILL_PROBE_SAMPLES', defaults.samples], ['SKILL_PROBE_BUDGET_USD', defaults.budgetUsd]] as const) {
    const d = settingDef(key);
    assert.ok(d, key);
    assert.equal(d!.apply, 'live');
    assert.equal(Number(d!.default), want);
    assert.deepEqual(normalizeSetting(d!, d!.default), { value: d!.default });
  }
  assert.ok('error' in normalizeSetting(settingDef('SKILL_PROBE_SAMPLES')!, '9'));
  assert.equal(isKnownFeature('editor.probe'), true);
});
