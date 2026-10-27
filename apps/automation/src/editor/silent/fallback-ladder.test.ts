// Spec 037 FR-010 (T10): the fallback ladder — reject → next candidate → lighter format → [evergreen seam] → skip,
// each step recorded on the slot; budget stop; only content failures climb it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorRunnerService } from '../roles/editor-runner.service';
import { SkillLibrary } from '../skills/skill-library';
import { makeCard } from '../post/testing/fixtures';
import { isToolError } from '../harness/tool';
import { classifyFailure, isFixableRevise, isWrongTopic, ladderPlan, lighterFormat, passBudgetFor, pinLevelOf, PublishProbe, stepRecord, type SlotFallback } from './fallback-ladder';
import type { CriticGate } from '../critic/critic-gate';
import { skipGroupOf } from './skip-reasons';

const NOW = new Date('2026-10-12T09:00:00Z');
const baseSlot: any = { id: 's1', channelKey: '@chan', scheduledAt: NOW, kind: 'content', format: 'photo', topic: 'Тема', angle: null, sourceHints: [], isExperiment: false, attempts: 1 };

type Behaviour = (st: any, input: any) => any;
const reject: Behaviour = (st) => {
  Object.assign(st, { status: 'skipped', error: 'critic_rejected: reject (grounding 2): цифр немає в джерелі', critic: { verdict: 'reject', notes: 'цифр немає в джерелі', cost_usd: 0.002 } });
  return { ok: true, skipped: true, critic_rejected: true };
};
const shadow: Behaviour = (st) => {
  Object.assign(st, { status: 'shadowed', error: null, critic: { verdict: 'pass', notes: 'ok', cost_usd: 0.002 } });
  return { ok: true, shadow: true };
};
const lint: Behaviour = () => ({ error: 'lint_failed', details: [{ code: 'caption_too_long', message: 'задовго' }] });
const agentSkip: Behaviour = (st) => { Object.assign(st, { status: 'skipped', error: 'skipped by agent: нічого гідного' }); return { ok: true, skipped: true }; };

function setup(script: Behaviour[], o: { slot?: any; budget?: (n: number) => boolean; evergreen?: boolean; live?: any; card?: any; extraSteps?: number; critic?: boolean } = {}) {
  const st: any = { ...(o.slot ?? baseSlot), status: 'running', error: null, critic: null };
  const runs: any[] = [];
  const patches: any[] = [];
  let current: Behaviour = shadow;
  let budgetCalls = 0;
  const evergreenCalls: any[] = [];
  const publish = { name: 'publish_post', kind: 'terminal', description: '', input: {} as any, roles: ['executor'], execute: async (input: any) => current(st, input) };
  const runner = new EditorRunnerService({
    loop: {
      run: async (i: any) => {
        runs.push(i);
        current = script[runs.length - 1] ?? shadow;
        const tool = i.tools.find((t: any) => t.name === 'publish_post');
        const format = /Формат: (\w+)/.exec(i.user)?.[1] ?? 'text';
        const r = await tool.execute({ spec: { format, source: { url: `https://src.example/${runs.length}` } } }, {});
        return { runId: `r${runs.length}`, status: isToolError(r) ? 'max_steps' : 'ok', terminalTool: isToolError(r) ? undefined : 'publish_post', totals: { steps: 1, promptTokens: 0, completionTokens: 0, costUsd: 0.01 } } as any;
      },
    },
    registry: { forRole: () => [publish] as any },
    skills: new SkillLibrary(),
    plans: {
      reservedSlots: async () => [],
      getSlot: async () => ({ ...st }),
      updateSlot: async (_id: string, p: any) => { patches.push(p); Object.assign(st, p); },
    },
    memory: { listActive: async () => [] },
    env: () => undefined, notify: async () => {}, now: () => NOW,
    // The full ladder (spec 037); spec 053's default of one extra step has its own test.
    ladder: { maxExtraSteps: o.extraSteps ?? 3 },
    ...(o.budget ? { budget: async () => (o.budget!(++budgetCalls) ? { ok: true as const } : { ok: false as const, reason: 'channel cap: $0.300 / $0.3' }) } : {}),
    ...(o.evergreen ? {
      fallbackEvergreen: async (req: any) => {
        evergreenCalls.push(req);
        Object.assign(st, { status: 'shadowed', error: null, critic: { verdict: 'pass', cost_usd: 0.001 } });
        return { runId: 'rE', status: 'ok', terminalTool: 'publish_post', totals: { steps: 1, promptTokens: 0, completionTokens: 0, costUsd: 0.005 } } as any;
      },
    } : {}),
    ...(o.live ? { live: { scan: async () => o.live } } : {}),
    // Spec 067: with a critic wired the run gets a gate, whose context carries the slot's pass budget and pin level.
    ...(o.critic ? { critic: { service: { review: async () => ({ ok: false as const, error: 'x', runIds: [], costUsd: 0 }) } as any } } : {}),
  });
  const gates = () => runs.map((r) => (r.extras?.critic as CriticGate | undefined)?.c);
  return { runner, st, runs, patches, evergreenCalls, gates, card: makeCard(o.card ?? {}) };
}

const fallbackOf = (st: any): SlotFallback => st.fallback;

test('ladder: reject → next candidate → lighter format → skip with the recorded reason', async () => {
  const s = setup([reject, reject, reject]);
  await s.runner.runExecutor(baseSlot, s.card);
  assert.equal(s.runs.length, 3);
  // Step 2: the failure notes and the material to avoid; step 3: the lighter format the card allows (photo → text).
  assert.match(s.runs[1].user, /Запасний крок \(next_candidate\)/);
  assert.match(s.runs[1].user, /цифр немає в джерелі/);
  assert.match(s.runs[1].user, /https:\/\/src\.example\/1/);
  assert.match(s.runs[2].user, /Формат: text\./);
  assert.match(s.runs[2].user, /легшому форматі: text замість photo/);
  assert.equal(s.st.status, 'skipped');
  assert.match(s.st.error, /^critic_rejected:/);
  assert.equal(skipGroupOf(s.st.error), 'critic');
  const f = fallbackOf(s.st);
  assert.deepEqual(f.steps.map((x) => [x.step, x.format, x.outcome, x.verdict]), [
    ['initial', 'photo', 'critic_reject', 'reject'], ['next_candidate', 'photo', 'critic_reject', 'reject'], ['lighter_format', 'text', 'critic_reject', 'reject'],
  ]);
  assert.deepEqual(f.steps.map((x) => x.run_id), ['r1', 'r2', 'r3']);
  assert.equal(f.steps[0].cost_usd, 0.012, 'executor run + critic');
  assert.equal(f.steps[0].source_url, 'https://src.example/1');
  assert.deepEqual([f.final?.outcome, f.final?.code, f.final?.step], ['skipped', 'exhausted', 'lighter_format']);
  // Between steps the slot runs again, without the previous verdict.
  assert.ok(s.patches.some((p) => p.status === 'running' && p.critic === null));
});

test('ladder: the next candidate gets out → rescued, no further step', async () => {
  const s = setup([reject, shadow]);
  await s.runner.runExecutor(baseSlot, s.card);
  assert.equal(s.runs.length, 2);
  assert.equal(s.st.status, 'shadowed');
  const f = fallbackOf(s.st);
  assert.deepEqual(f.steps.map((x) => x.outcome), ['critic_reject', 'shadowed']);
  assert.deepEqual([f.final?.outcome, f.final?.code, f.final?.step], ['rescued', 'shadowed', 'next_candidate']);
});

test('ladder: a lint failure that ran the executor out of steps climbs the ladder (not the 15-min retry)', async () => {
  const s = setup([lint, shadow]);
  await s.runner.runExecutor(baseSlot, s.card);
  assert.equal(s.runs.length, 2);
  assert.match(s.runs[1].user, /пост не пройшов lint/);
  assert.match(s.runs[1].user, /caption_too_long/);
  const f = fallbackOf(s.st);
  assert.equal(f.steps[0].outcome, 'lint');
  assert.match(f.steps[0].reason!, /^lint_failed: caption_too_long/);
  assert.equal(s.st.status, 'shadowed');
});

test('ladder: the daily budget stops it before the next step (the failed reason stays, final code budget)', async () => {
  // Call 1 is the pre-run check (spec 046 FR-005): the first run fits, the ladder step does not.
  const s = setup([reject, shadow], { budget: (n) => n < 2 });
  await s.runner.runExecutor(baseSlot, s.card);
  assert.equal(s.runs.length, 1, 'no executor / critic call after the cap');
  assert.equal(s.st.status, 'skipped');
  assert.match(s.st.error, /^critic_rejected:/);
  const f = fallbackOf(s.st);
  assert.deepEqual([f.final?.code, f.final?.reason], ['budget', 'channel cap: $0.300 / $0.3']);
});

test('ladder: the budget is checked before each step; hit after the first extra step', async () => {
  const s = setup([reject, reject, shadow], { budget: (n) => n < 3 });
  await s.runner.runExecutor(baseSlot, s.card);
  assert.equal(s.runs.length, 2);
  assert.deepEqual(fallbackOf(s.st).steps.map((x) => x.step), ['initial', 'next_candidate']);
  assert.equal(fallbackOf(s.st).final?.code, 'budget');
});

test('046: a slot the budget cannot afford waits (planned, retry_at, attempt given back) — skipped when too late', async () => {
  const s = setup([shadow], { budget: () => false });
  await s.runner.runExecutor({ ...baseSlot, attempts: 1 }, s.card);
  assert.equal(s.runs.length, 0, 'no run starts');
  assert.equal(s.st.status, 'planned');
  assert.ok(s.st.retryAt instanceof Date && s.st.retryAt.getTime() > NOW.getTime());
  assert.equal(s.st.attempts, 0);
  assert.match(s.st.error, /^waiting for budget: channel cap/);
  const late = setup([shadow], { budget: () => false, slot: { ...baseSlot, scheduledAt: new Date(NOW.getTime() - 6 * 3600_000) } });
  await late.runner.runExecutor(late.st, late.card);
  assert.equal(late.st.status, 'skipped');
  assert.match(late.st.error, /^budget: /);
});

test('ladder: a run that hit a cap stops it too', async () => {
  const s = setup([reject]);
  const card = s.card;
  // The loop reports budget_exceeded for the initial run.
  const run = (s.runner as any).d.loop.run;
  (s.runner as any).d.loop.run = async (i: any) => ({ ...(await run(i)), status: 'budget_exceeded', error: 'channel cap' });
  await s.runner.runExecutor(baseSlot, card);
  assert.equal(s.runs.length, 1);
  assert.equal(fallbackOf(s.st).final?.code, 'budget');
});

test('ladder: no new step long after the slot time', async () => {
  const s = setup([reject, shadow], { slot: { ...baseSlot, scheduledAt: new Date(NOW.getTime() - 2 * 3600_000) } });
  await s.runner.runExecutor({ ...baseSlot, scheduledAt: new Date(NOW.getTime() - 2 * 3600_000) }, s.card);
  assert.equal(s.runs.length, 1);
  assert.equal(fallbackOf(s.st).final?.code, 'too_late');
});

test('ladder: the evergreen seam runs after the other steps when wired (within the critic pass cap)', async () => {
  const s = setup([reject, reject], { evergreen: true, card: { formats: { photo: 1 } } });
  await s.runner.runExecutor(baseSlot, s.card);
  assert.equal(s.evergreenCalls.length, 1);
  assert.equal(s.evergreenCalls[0].failure.kind, 'critic_reject');
  assert.deepEqual(s.evergreenCalls[0].steps.map((x: any) => x.step), ['initial', 'next_candidate']);
  const f = fallbackOf(s.st);
  assert.deepEqual([f.final?.outcome, f.final?.step], ['rescued', 'evergreen']);
});

test('046: no new step after 3 critic passes on the slot (a revise + rewrite counts 2)', async () => {
  const s = setup([reject, reject, reject], { evergreen: true });
  await s.runner.runExecutor(baseSlot, s.card);
  assert.equal(s.evergreenCalls.length, 0);
  const f = fallbackOf(s.st);
  assert.deepEqual(f.steps.map((x) => [x.step, x.critic_passes]), [['initial', 1], ['next_candidate', 1], ['lighter_format', 1]]);
  assert.deepEqual([f.final?.outcome, f.final?.code], ['skipped', 'critic_cap']);
  const revised: Behaviour = (st) => {
    Object.assign(st, { status: 'skipped', error: 'critic_rejected: reject', critic: { verdict: 'reject', notes: 'n', cost_usd: 0.002, history: [{ verdict: 'revise' }] } });
    return { ok: true, failed: 'critic_rejected' } as any;
  };
  // Spec 067 FR-004: what the scripted attempts report is 2 + 2; the real gate gets a budget of 1 for the second (see the 067 tests below).
  const r = setup([revised, revised, shadow]);
  await r.runner.runExecutor(baseSlot, r.card);
  assert.equal(r.runs.length, 2);
  assert.equal(fallbackOf(r.st).final?.code, 'critic_cap');
});

const revisedTwice: Behaviour = (st) => {
  Object.assign(st, { status: 'skipped', error: 'critic_rejected: second revise — revise: n', critic: { verdict: 'revise', notes: 'n', cost_usd: 0.002, history: [{ verdict: 'revise' }] } });
  return { ok: true, failed: 'critic_rejected' } as any;
};
/** One critic pass that ended in a (final) revise: what a gate with a budget of 1 stores. */
const cappedRevise: Behaviour = (st) => {
  Object.assign(st, { status: 'skipped', error: 'critic_rejected: cap_revise — revise: n', critic: { verdict: 'revise', notes: 'n', reason: 'cap_revise: model_revise', cost_usd: 0.002 } });
  return { ok: true, failed: 'critic_rejected' } as any;
};

test('067 FR-004: the cap of 3 holds — initial (revise + rewrite = 2 passes), then a ladder step (revise_source) with a budget of 1 = 3 critic runs, no fourth', async () => {
  const s = setup([revisedTwice, cappedRevise, shadow], { critic: true });
  await s.runner.runExecutor(baseSlot, s.card);
  assert.equal(s.runs.length, 2, 'no third attempt');
  assert.deepEqual(s.gates().map((c) => c?.passBudget), [2, 1]);
  const f = fallbackOf(s.st);
  assert.deepEqual(f.steps.map((x) => [x.step, x.critic_passes]), [['initial', 2], ['revise_source', 1]], 'a revise is fixable: the first step keeps the source');
  assert.deepEqual([f.final?.outcome, f.final?.code], ['skipped', 'critic_cap']);
  assert.equal(passBudgetFor(0), 2);
  assert.equal(passBudgetFor(1), 2);
  assert.equal(passBudgetFor(2), 1);
  assert.equal(passBudgetFor(3), 0);
  assert.equal(passBudgetFor(5), 0);
});

test('067 FR-004: a first attempt with one pass spent gets a budget of 2; the 15-minute retry after 2 passes gets 1; after 3 it is skipped as critic_cap', async () => {
  const one = setup([shadow], { critic: true });
  await one.runner.runExecutor(baseSlot, one.card);
  assert.deepEqual(one.gates().map((c) => c?.passBudget), [2], 'a fresh slot: revise + rewrite');
  const prior = (n: number) => ({ ...baseSlot, fallback: { steps: [{ step: 'initial', at: NOW.toISOString(), format: 'photo', outcome: 'ended', reason: null, verdict: null, run_id: 'r0', cost_usd: 0, critic_passes: n }], final: null } });
  const retry = setup([shadow], { critic: true });
  await retry.runner.runExecutor(prior(2), retry.card);
  assert.deepEqual(retry.gates().map((c) => c?.passBudget), [1]);
  const spent = setup([shadow], { critic: true });
  await spent.runner.runExecutor(prior(3), spent.card);
  assert.equal(spent.runs.length, 0);
  assert.match(spent.st.error, /^critic_cap: 3 critic passes/);
});

test('067 FR-003: the critic level is recorded on the step and pins the next ladder step and the retry', async () => {
  const high = (extra: object = {}): Behaviour => (st) => {
    Object.assign(st, { status: 'skipped', error: 'critic_rejected: reject (grounding 2): n', critic: { verdict: 'reject', notes: 'n', cost_usd: 0.002, route: { risk: 4, level: 'high', factors: ['numbers'], model: 'claude-sonnet-5-5' }, ...extra } });
    return { ok: true, skipped: true, critic_rejected: true };
  };
  const s = setup([high(), reject, shadow], { critic: true });
  await s.runner.runExecutor(baseSlot, s.card);
  assert.deepEqual(s.gates().map((c) => c?.pinLevel ?? null), [null, 'high', 'high'].slice(0, s.runs.length), 'the second run is pinned by the first');
  const f = fallbackOf(s.st);
  assert.deepEqual([f.steps[0].critic_level, f.steps[0].critic_model], ['high', 'claude-sonnet-5-5']);
  assert.equal(f.steps[1].critic_level, undefined, 'a step with no route on the verdict records none');
  // A retry reads the pin from the earlier attempt's step.
  const prior = { ...baseSlot, fallback: { steps: [{ step: 'initial', at: NOW.toISOString(), format: 'photo', outcome: 'ended', reason: null, verdict: 'revise', run_id: 'r0', cost_usd: 0, critic_passes: 1, critic_level: 'high' }], final: null } };
  const r = setup([shadow], { critic: true });
  await r.runner.runExecutor(prior, r.card);
  assert.deepEqual(r.gates().map((c) => c?.pinLevel), ['high']);
});

test('067 stepRecord / pinLevelOf: the level is high when any pass was (a pinned pass 2 is stored high too); low only when every route was low', () => {
  const at = new Date('2026-10-27T09:00:00Z');
  const slot = (critic: any) => ({ status: 'skipped', error: null, critic });
  const level = (critic: any) => stepRecord('initial', 'text', at, slot(critic), null, { runId: 'r1' }).critic_level;
  assert.equal(level({ verdict: 'revise', route: { level: 'high', model: 'm1' } }), 'high');
  assert.equal(level({ verdict: 'pass', route: { level: 'low', model: 'm2' }, history: [{ route: { level: 'high' } }] }), 'high', 'a high first pass pins the whole attempt');
  assert.equal(level({ verdict: 'pass', route: { level: 'low', model: 'm2' }, history: [{ route: { level: 'low' } }] }), 'low');
  assert.equal(level({ verdict: 'pass' }), undefined);
  assert.equal(level(null), undefined);
  assert.equal(stepRecord('initial', 'text', at, slot({ verdict: 'pass', route: { level: 'low', model: 'm2' } }), null, { runId: 'r1' }).critic_model, 'm2');
  assert.equal(pinLevelOf({ steps: [{}, { critic_level: 'low' }] }), null);
  assert.equal(pinLevelOf({ steps: [{ critic_level: 'low' }, { critic_level: 'high' }] }), 'high');
  assert.equal(pinLevelOf(null), null);
});

test('046: a live (news) slot never falls back to an evergreen post', async () => {
  const live = { sources: ['https://feed.example/rss'], brief: 'Новини', max_age_hours: 12, origin: 'planner' };
  const s = setup([reject, reject], { evergreen: true, card: { formats: { photo: 1 } }, slot: { ...baseSlot, topicMode: 'live', liveSpec: live } });
  await s.runner.runExecutor(s.st, s.card);
  assert.equal(s.evergreenCalls.length, 0);
  assert.equal(s.st.status, 'skipped');
});

test('ladder: no lighter format allowed → next candidate, then skip', async () => {
  const s = setup([reject, reject], { card: { formats: { photo: 1 } } });
  await s.runner.runExecutor(baseSlot, s.card);
  assert.equal(s.runs.length, 2);
  assert.deepEqual(fallbackOf(s.st).steps.map((x) => x.step), ['initial', 'next_candidate']);
  assert.equal(s.st.status, 'skipped');
});

test('ladder: a live slot takes the next fresh item; none left → no_candidate, then the lighter format', async () => {
  const live = { sources: ['https://feed.example/rss'], brief: 'Новини', max_age_hours: 12, origin: 'planner' };
  const slot = { ...baseSlot, topicMode: 'live', liveSpec: live };
  const scan = { items: [{ title: 'A', url: 'https://src.example/1', ageHours: 1 }], feedsRead: 1, feedsFailed: 0, otherSources: [], dropped: { old: 0, undated: 0, posted: 0, similar: 0 } };
  const s = setup([reject, shadow], { slot, live: scan });
  await s.runner.runExecutor(slot, s.card);
  const f = fallbackOf(s.st);
  assert.deepEqual(f.steps.map((x) => [x.step, x.outcome]), [['initial', 'critic_reject'], ['next_candidate', 'no_candidate'], ['lighter_format', 'shadowed']]);
  assert.equal(s.runs.length, 2);
  assert.match(s.runs[1].user, /Формат: text\./);

  // With another fresh item, the next candidate runs on it (the failed one is filtered out of the list).
  const scan2 = { ...scan, items: [...scan.items, { title: 'B', url: 'https://src.example/other', ageHours: 2 }] };
  const s2 = setup([reject, shadow], { slot, live: scan2 });
  await s2.runner.runExecutor(slot, s2.card);
  assert.equal(s2.runs.length, 2);
  assert.match(s2.runs[1].user, /src\.example\/other/);
  const list = (s2.runs[1].user.split('Свіжі неопубліковані')[1] ?? '').split('Запасний крок')[0];
  assert.match(list, /src\.example\/other/);
  assert.doesNotMatch(list, /src\.example\/1\b/, 'the failed item is not offered again');
  assert.equal(fallbackOf(s2.st).final?.step, 'next_candidate');
});

test('ladder: only content failures — an editorial skip, a critic outage, a cap stay as they were', async () => {
  for (const b of [
    agentSkip,
    (st: any) => { Object.assign(st, { status: 'failed', error: 'critic_failed: timeout', critic: { verdict: 'error' } }); return { ok: true, failed: 'critic_failed' }; },
    () => ({ error: 'daily_cap_reached', details: '5/5' }),
  ]) {
    const s = setup([b]);
    await s.runner.runExecutor(baseSlot, s.card);
    assert.equal(s.runs.length, 1);
    assert.equal(s.st.fallback, undefined);
  }
  // The executor's skip after a critic `revise` is a critic rejection: it climbs.
  const s = setup([(st) => { Object.assign(st, { status: 'skipped', error: 'skipped by agent: не врятувати', critic: { verdict: 'revise', notes: 'штампи' } }); return { ok: true }; }, shadow]);
  await s.runner.runExecutor(baseSlot, s.card);
  assert.equal(s.runs.length, 2);
  assert.equal(fallbackOf(s.st).steps[0].outcome, 'critic_reject');
});

test('ladder: switched off, promo and reserved slots never climb', async () => {
  const s = setup([reject]);
  (s.runner as any).d.ladder = { enabled: false };
  await s.runner.runExecutor(baseSlot, s.card);
  assert.equal(s.runs.length, 1);
  const p = setup([reject], { slot: { ...baseSlot, promo: { kind: 'cross' } } });
  await p.runner.runExecutor({ ...baseSlot, promo: { kind: 'cross' } }, p.card);
  assert.equal(p.runs.length, 1);
});

test('pure: classify, lighter formats, plan', () => {
  const probe = new PublishProbe();
  probe.last = { code: 'too_similar', details: 'схожість 0.7' };
  probe.source = 'https://x.example/a';
  const f = classifyFailure({ status: 'running', error: null }, probe);
  assert.deepEqual([f?.kind, f?.code, f?.reason, f?.sourceUrl], ['guard', 'too_similar', 'too_similar: схожість 0.7', 'https://x.example/a']);
  assert.equal(classifyFailure({ status: 'running', error: null }, { last: { code: 'quiet_hours', details: null }, source: null }), null);
  assert.equal(classifyFailure({ status: 'published', error: null }, null), null);
  assert.equal(lighterFormat('longread', new Set(['photo', 'text'])), 'text');
  assert.equal(lighterFormat('carousel', new Set(['text'])), 'text');
  assert.equal(lighterFormat('ig_carousel', new Set(['ig_photo', 'ig_carousel'])), 'ig_photo');
  assert.equal(lighterFormat('text', new Set(['text', 'photo'])), null);
  assert.deepEqual(ladderPlan({ format: 'text', allowed: new Set(['text']), evergreen: false }).map((x) => x.step), ['next_candidate']);
  assert.deepEqual(ladderPlan({ format: 'carousel', allowed: new Set(['photo']), evergreen: true }).map((x) => `${x.step}:${x.format}`),
    ['next_candidate:carousel', 'lighter_format:photo', 'evergreen:photo']);
});

// ── spec 053 FR-007: fewer re-runs ──────────────────────────────────────────

test('053: by default one ladder step after the first attempt; a lint failure tries the lighter format first', async () => {
  const s = setup([reject, reject, reject], { extraSteps: 1 });
  await s.runner.runExecutor(baseSlot, s.card);
  assert.equal(s.runs.length, 2, 'the first attempt and one step');
  assert.equal(s.st.status, 'skipped');
  assert.deepEqual(fallbackOf(s.st).steps.map((x) => x.step), ['initial', 'next_candidate']);
  assert.equal(fallbackOf(s.st).final!.code, 'exhausted');
  assert.deepEqual(ladderPlan({ format: 'photo', allowed: new Set(['photo', 'text']), evergreen: false, failure: 'lint' }).map((x) => x.step), ['lighter_format', 'next_candidate']);
  assert.deepEqual(ladderPlan({ format: 'photo', allowed: new Set(['photo', 'text']), evergreen: false, failure: 'critic_reject' }).map((x) => x.step), ['next_candidate', 'lighter_format']);
});

test('053: no 15-minute retry after a content failure; a crash still retries', async () => {
  const content = setup([lint, lint]);
  (content.runner as any).d.ladder = { enabled: false };
  await content.runner.runExecutor(baseSlot, content.card);
  assert.equal(content.st.status, 'failed');
  assert.match(content.st.error, /^lint_failed: caption_too_long/);
  assert.equal(content.patches.some((p: any) => p.status === 'planned'), false);

  const crash = setup([() => ({ error: 'http_502', details: 'upstream' })]);
  await crash.runner.runExecutor(baseSlot, crash.card);
  assert.equal(crash.st.status, 'planned');
  assert.ok(crash.st.retryAt);
});

test('053: critic passes count across the retry — a slot that used them is skipped before another run', async () => {
  const spent = setup([shadow]);
  const slot = { ...baseSlot, fallback: { steps: [{ step: 'initial', critic_passes: 2 }, { step: 'next_candidate', critic_passes: 1 }], final: null } };
  Object.assign(spent.st, { fallback: slot.fallback });
  await spent.runner.runExecutor(slot, spent.card);
  assert.equal(spent.runs.length, 0, 'no executor run');
  assert.equal(spent.st.status, 'skipped');
  assert.match(spent.st.error, /critic_cap: 3 critic passes/);

  // A run the critic read that then crashed goes into the trace, so the retry counts its passes.
  const read = setup([(st) => { Object.assign(st, { critic: { verdict: 'revise', notes: 'штампи', history: [{}] } }); return { error: 'http_502', details: 'upstream' }; }]);
  await read.runner.runExecutor(baseSlot, read.card);
  assert.equal(read.st.status, 'planned');
  assert.equal(fallbackOf(read.st).steps.at(-1)!.critic_passes, 2);
});

// ── spec 063 FR-002: a fixable revise keeps its source ────────────────────────

const secondRevise = (grounding: number, notes: string): Behaviour => (st) => {
  Object.assign(st, {
    status: 'skipped', error: `critic_rejected: second revise — revise: ${notes}`,
    critic: { verdict: 'revise', notes, scores: { grounding, sense: 4 }, cost_usd: 0.002, history: [{ verdict: 'revise' }] },
  });
  return { ok: true, skipped: true, critic_rejected: true };
};

test('063: a fixable revise re-runs the executor on the SAME source with the notes (nothing banned)', async () => {
  const s = setup([secondRevise(4, 'Прибери зайве питання в кінці.'), shadow]);
  const dead: string[] = [];
  (s.runner as any).d.deadSource = async (_slot: any, url: string) => { dead.push(url); return 1; };
  await s.runner.runExecutor(baseSlot, s.card);
  assert.equal(s.runs.length, 2);
  assert.match(s.runs[1].user, /Запасний крок \(revise_source\)/);
  assert.match(s.runs[1].user, /Прибери зайве питання/);
  assert.match(s.runs[1].user, /ЗАЛИШ ТОЙ САМИЙ матеріал/);
  assert.match(s.runs[1].user, /https:\/\/src\.example\/1/, 'the source is named');
  assert.doesNotMatch(s.runs[1].user, /Не бери повторно/);
  assert.doesNotMatch(s.runs[1].user, /НАСТУПНИЙ свіжий/);
  assert.deepEqual(fallbackOf(s.st).steps.map((x) => [x.step, x.outcome]), [['initial', 'critic_reject'], ['revise_source', 'shadowed']]);
  assert.equal(s.st.status, 'shadowed');
  assert.deepEqual(dead, []);
});

test('063: still bounded — one revise_source step, then the slot is skipped without banning the source', async () => {
  const s = setup([secondRevise(4, 'Штампи.'), secondRevise(4, 'Штампи.'), shadow], { extraSteps: 1 });
  const dead: string[] = [];
  (s.runner as any).d.deadSource = async (_slot: any, url: string) => { dead.push(url); return 1; };
  await s.runner.runExecutor(baseSlot, s.card);
  assert.equal(s.runs.length, 2);
  assert.equal(s.st.status, 'skipped');
  assert.deepEqual(dead, [], 'a revise never kills the source');
  assert.deepEqual(fallbackOf(s.st).steps.map((x) => x.step), ['initial', 'revise_source']);
});

test('063: a reject, a grounding of 2 or a wrong topic ban the source and take the next candidate', async () => {
  for (const b of [
    reject,
    secondRevise(2, 'Цифр немає в джерелі.'),
    secondRevise(4, 'Пост про іншу тему, ніж слот.'),
  ]) {
    const s = setup([b, shadow]);
    const dead: string[] = [];
    (s.runner as any).d.deadSource = async (_slot: any, url: string) => { dead.push(url); return 1; };
    await s.runner.runExecutor(baseSlot, s.card);
    assert.match(s.runs[1].user, /Запасний крок \(next_candidate\)/);
    assert.match(s.runs[1].user, /Не бери повторно: https:\/\/src\.example\/1/);
    assert.deepEqual(fallbackOf(s.st).steps.map((x) => x.step), ['initial', 'next_candidate']);
  }
  // A failed next candidate reports the first source dead.
  const s = setup([reject, reject], { extraSteps: 1 });
  const dead: string[] = [];
  (s.runner as any).d.deadSource = async (_slot: any, url: string) => { dead.push(url); return 1; };
  await s.runner.runExecutor(baseSlot, s.card);
  assert.deepEqual(dead.sort(), ['https://src.example/1', 'https://src.example/2']);
});

test('063: a live slot keeps its item on revise_source (the feeds are not re-read without it)', async () => {
  const live = { sources: ['https://feed.example/rss'], brief: 'Новини', max_age_hours: 12, origin: 'planner' };
  const slot = { ...baseSlot, topicMode: 'live', liveSpec: live };
  const scan = { items: [{ title: 'A', url: 'https://src.example/1', ageHours: 1 }], feedsRead: 1, feedsFailed: 0, otherSources: [], dropped: { old: 0, undated: 0, posted: 0, similar: 0 } };
  const s = setup([secondRevise(4, 'Штампи.'), shadow], { slot, live: scan });
  let scans = 0;
  (s.runner as any).d.live = { scan: async () => { scans++; return scan; } };
  await s.runner.runExecutor(slot, s.card);
  assert.equal(scans, 1, 'only the initial scan: revise_source does not rescan');
  assert.deepEqual(fallbackOf(s.st).steps.map((x) => [x.step, x.outcome]), [['initial', 'critic_reject'], ['revise_source', 'shadowed']]);
});

test('063 pure: isFixableRevise, wrong topic, plan', () => {
  assert.equal(isFixableRevise({ verdict: 'revise', notes: 'Прибери питання', scores: { grounding: 3 } }), true);
  assert.equal(isFixableRevise({ verdict: 'revise', notes: 'Прибери питання' }), true, 'no scores: the default for revise');
  assert.equal(isFixableRevise({ verdict: 'revise', notes: 'x', scores: { grounding: 2 } }), false);
  assert.equal(isFixableRevise({ verdict: 'reject', notes: 'x', scores: { grounding: 4 } }), false);
  assert.equal(isFixableRevise({ verdict: 'revise', notes: 'Пост не про тему слота' }), false);
  assert.equal(isFixableRevise({ verdict: 'revise', notes: 'ok' }, 'skipped by agent: wrong topic'), false);
  assert.equal(isFixableRevise(null), false);
  assert.equal(isWrongTopic('пост про іншу тему'), true);
  assert.equal(isWrongTopic('Пост про тему ШІ у школах, ок'), false);
  assert.deepEqual(ladderPlan({ format: 'photo', allowed: new Set(['photo', 'text']), evergreen: false, failure: 'critic_reject', fixable: true }).map((x) => x.step),
    ['revise_source', 'next_candidate', 'lighter_format']);
  const f = classifyFailure({ status: 'skipped', error: 'critic_rejected: second revise — revise: x', critic: { verdict: 'revise', notes: 'x', scores: { grounding: 4 } } }, null);
  assert.equal(f?.fixable, true);
  assert.equal(classifyFailure({ status: 'skipped', error: 'critic_rejected: reject: x', critic: { verdict: 'reject', notes: 'x' } }, null)?.fixable, false);
});
