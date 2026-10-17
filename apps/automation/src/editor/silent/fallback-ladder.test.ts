// Spec 037 FR-010 (T10): the fallback ladder — reject → next candidate → lighter format → [evergreen seam] → skip,
// each step recorded on the slot; budget stop; only content failures climb it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorRunnerService } from '../roles/editor-runner.service';
import { SkillLibrary } from '../skills/skill-library';
import { makeCard } from '../post/testing/fixtures';
import { isToolError } from '../harness/tool';
import { classifyFailure, ladderPlan, lighterFormat, PublishProbe, type SlotFallback } from './fallback-ladder';
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

function setup(script: Behaviour[], o: { slot?: any; budget?: (n: number) => boolean; evergreen?: boolean; live?: any; card?: any } = {}) {
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
    ...(o.budget ? { budget: async () => (o.budget!(++budgetCalls) ? { ok: true as const } : { ok: false as const, reason: 'channel cap: $0.300 / $0.3' }) } : {}),
    ...(o.evergreen ? {
      fallbackEvergreen: async (req: any) => {
        evergreenCalls.push(req);
        Object.assign(st, { status: 'shadowed', error: null, critic: { verdict: 'pass', cost_usd: 0.001 } });
        return { runId: 'rE', status: 'ok', terminalTool: 'publish_post', totals: { steps: 1, promptTokens: 0, completionTokens: 0, costUsd: 0.005 } } as any;
      },
    } : {}),
    ...(o.live ? { live: { scan: async () => o.live } } : {}),
  });
  return { runner, st, runs, patches, evergreenCalls, card: makeCard(o.card ?? {}) };
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

test('ladder: the evergreen seam runs after the lighter format when wired', async () => {
  const s = setup([reject, reject, reject], { evergreen: true });
  await s.runner.runExecutor(baseSlot, s.card);
  assert.equal(s.evergreenCalls.length, 1);
  assert.equal(s.evergreenCalls[0].failure.kind, 'critic_reject');
  assert.deepEqual(s.evergreenCalls[0].steps.map((x: any) => x.step), ['initial', 'next_candidate', 'lighter_format']);
  const f = fallbackOf(s.st);
  assert.deepEqual([f.final?.outcome, f.final?.step], ['rescued', 'evergreen']);
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
