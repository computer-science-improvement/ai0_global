import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeKpis, dayBefore, DailySeries, meanMetric, sumMetric } from './kpi-math';
import { fileDirective, isStructural, buildDirectiveTools } from './directive-tools';
import { ManagerRunner } from './manager-runner';
import type { Directive } from './directives.repository';

const TODAY = '2026-10-20';

/** Deterministic pseudo-noise in [-1, 1]. */
const noise = (i: number) => Math.sin(i * 12.9898) * 0.999;

function series(days: number, f: (daysAgo: number) => number | null): DailySeries {
  const m = new Map<string, number>();
  for (let i = 1; i <= days; i++) { const v = f(i); if (v != null) m.set(dayBefore(TODAY, i), v); }
  return m;
}

test('kpi math: windows, delta, z, anomaly, stale', () => {
  const flat = meanMetric(series(35, (i) => 1000 + noise(i) * 50), TODAY);
  assert.equal(flat.anomaly, false);
  assert.ok(Math.abs(flat.deltaPct!) < 5);
  const drop = meanMetric(series(35, (i) => (i <= 7 ? 600 : 1000) + noise(i) * 50), TODAY);
  assert.equal(drop.anomaly, true);
  assert.ok(drop.deltaPct! < -35 && drop.z! < -2);
  const sum = sumMetric(series(35, () => 10), TODAY);
  assert.equal(sum.value7d, 70);
  assert.equal(sum.baseline28d, 70);
  const stale = sumMetric(series(35, (i) => (i > 7 ? 5 : null)), TODAY, { skipMissing: true, staleIfNoRecent: true });
  assert.equal(stale.stale, true);
  assert.equal(stale.anomaly, false, 'stale metrics are never anomalies');
});

test('simulation: a noisy stable network raises no anomalies for 14 days; a sustained 30% drop is flagged within 4 days', () => {
  let falseAlarms = 0;
  for (let day = 0; day < 14; day++) {
    const today = dayBefore('2026-11-03', 13 - day);
    const s = new Map<string, number>();
    for (let i = 1; i <= 40; i++) s.set(dayBefore(today, i), 1000 * (1 + 0.1 * noise(i + day * 7)));
    if (meanMetric(s, today).anomaly) falseAlarms++;
  }
  assert.equal(falseAlarms, 0);
  let flaggedAfter: number | null = null;
  for (let after = 1; after <= 7 && flaggedAfter == null; after++) {
    const today = dayBefore('2026-11-03', 0);
    const s = new Map<string, number>();
    for (let i = 1; i <= 40; i++) s.set(dayBefore(today, i), (i <= after ? 700 : 1000) * (1 + 0.05 * noise(i)));
    if (meanMetric(s, today).anomaly) flaggedAfter = after;
  }
  assert.ok(flaggedAfter != null && flaggedAfter <= 4, `flagged after ${flaggedAfter}`);
});

test('computeKpis covers every metric', () => {
  const empty = new Map<string, number>();
  const k = computeKpis({ viewsPerPost: empty, engagementRate: empty, posts: empty, followerDelta: empty, joins: empty, revenue: empty }, TODAY);
  assert.deepEqual(Object.keys(k).sort(), ['engagement_rate', 'followers_growth', 'posts', 'revenue', 'transitions', 'views_per_post']);
});

test('structural classification is code, not the model', () => {
  assert.equal(isStructural('cross_promo', {}), true);
  assert.equal(isStructural('pause_resource', {}), true);
  assert.equal(isStructural('frequency', { change_pct: -30 }), true);
  assert.equal(isStructural('frequency', { change_pct: 20 }), false);
  assert.equal(isStructural('format_shift', { add_platform: 'tiktok' }), true);
  assert.equal(isStructural('format_shift', {}), false);
});

function fakeRepo(o: Partial<{ open: boolean; rejectedAt: Date | null; runCount: number; openBinding: number; declined: any }> = {}) {
  const inserted: any[] = [];
  const updates: any[] = [];
  return {
    inserted, updates,
    repo: {
      openFor: async () => (o.open ? { status: 'new' } : null),
      lastRejected: async () => o.rejectedAt ?? null,
      countForRun: async () => o.runCount ?? 0,
      countOpenBinding: async () => o.openBinding ?? 0,
      lastDeclinedAdvice: async () => o.declined ?? null,
      insert: async (d: any) => { const x = { id: `d${inserted.length + 1}`, ...d, createdAt: new Date() }; inserted.push(x); return x; },
      update: async (id: string, p: any) => { updates.push([id, p]); return { id, ...p }; },
      get: async (id: string) => (id === 'dir1' ? { id, toAgentId: 'o1', status: 'new' } : null),
    } as any,
  };
}

const ORCH = { id: 'o1', handle: 'kira', kind: 'orchestrator', parentId: null, mode: 'live' } as any;
const deps = (repo: any, inbox: any[] = []) => ({
  repo, agents: { getByHandle: async (h: string) => (h.replace('@', '') === 'kira' ? ORCH : null), findTop: async () => null } as any,
  digest: { build: async () => ({}) as any, render: () => '{}' }, inbox: { post: async (i: any) => { inbox.push(i); return 1; } },
  memory: { listActive: async () => [{ id: 5, kind: 'rule', text: 'Без мемів', createdBy: 'owner' }] as any },
  actions: { propose: async () => ({}) as any }, channelKeyOf: async () => '@space',
});
const good = {
  to: '@kira', kind: 'format_shift' as const, binding: 'advice' as 'advice' | 'directive', body: 'Більше каруселей в Instagram', params: { format: 'ig_carousel', weight_delta: 0.2 },
  rationale: 'Каруселі дають на 60% більше переглядів за 28 днів', evidence: { views_per_post: { carousel: 1600, photo: 1000 } },
  expected: { metric: 'views_per_post' as const, direction: 'up' as const, min_change_pct: 10 }, review_in_days: 7,
};

test('file_directive rules: target, open duplicate, cooldown, evidence, expected, run cap; structural → owner', async () => {
  const ok = fakeRepo();
  const inbox: any[] = [];
  const r: any = await fileDirective(deps(ok.repo, inbox), good, { from: null, runId: 'r', shadow: false });
  assert.equal(r.ok, true);
  assert.equal(ok.inserted[0].status, 'new');
  assert.equal(inbox.length, 0);
  assert.equal(((await fileDirective(deps(fakeRepo().repo), { ...good, to: '@ghost' }, { from: null, runId: 'r', shadow: false })) as any).error, 'not_an_orchestrator');
  assert.equal(((await fileDirective(deps(fakeRepo({ open: true }).repo), good, { from: null, runId: 'r', shadow: false })) as any).error, 'directive_open');
  assert.equal(((await fileDirective(deps(fakeRepo({ rejectedAt: new Date() }).repo), good, { from: null, runId: 'r', shadow: false })) as any).error, 'cooldown');
  assert.equal(((await fileDirective(deps(fakeRepo().repo), { ...good, evidence: { note: 'просто так' } }, { from: null, runId: 'r', shadow: false })) as any).error, 'evidence_required');
  assert.equal(((await fileDirective(deps(fakeRepo().repo), { ...good, expected: undefined }, { from: null, runId: 'r', shadow: false })) as any).error, 'expected_required');
  assert.equal(((await fileDirective(deps(fakeRepo({ runCount: 3 }).repo), good, { from: null, runId: '00000000-0000-4000-8000-000000000001', shadow: false })) as any).error, 'too_many_directives');
  const s = fakeRepo();
  const sinbox: any[] = [];
  await fileDirective(deps(s.repo, sinbox), { ...good, kind: 'cross_promo', binding: 'directive', params: { source_ref: 'a', target_ref: 'b' } }, { from: null, runId: 'r', shadow: false });
  assert.equal(s.inserted[0].status, 'awaiting_owner');
  assert.equal(s.inserted[0].structural, true);
  assert.equal(sinbox[0].severity, 'action');
  const stale = await fileDirective(deps(fakeRepo().repo), good, {
    from: null, runId: 'r', shadow: false,
    digest: { resources: [{ ref: 'telegram:@space', agent: 'kira', kpis: { views_per_post: { stale: true } } }] } as any,
  });
  assert.equal((stale as any).error, 'stale_metric');
});

test('accept_directive refuses a conflict with an owner rule (contest it); reject_directive is gone, decline needs a reason kind', async () => {
  const f = fakeRepo();
  const tools = buildDirectiveTools(deps(f.repo) as any);
  const accept = tools.find((t) => t.name === 'accept_directive')!;
  const ctx = { runId: 'r', role: 'orchestrator' as const, channelKey: '@space', extras: { orchestrator: ORCH } };
  const r1: any = await accept.execute({ id: 'dir1', plan: 'Додам 2 каруселі завтра', conflicting_rule_ids: [5] }, ctx);
  assert.equal(r1.error, 'owner_rule_conflict');
  assert.match(r1.details, /contest_directive/);
  const r2: any = await accept.execute({ id: 'dir1', plan: 'Додам 2 каруселі завтра', conflicting_rule_ids: [] }, ctx);
  assert.equal(r2.ok, true);
  assert.equal(f.updates.at(-1)[1].status, 'accepted');
  assert.equal(tools.find((t) => t.name === 'reject_directive'), undefined, 'spec 025 FR-005: reject_directive is removed');
  const decline = tools.find((t) => t.name === 'decline_advice')!;
  assert.equal(decline.input.safeParse({ id: '00000000-0000-4000-8000-000000000001', reason_kind: 'mood', reason: 'не хочу і все тут' }).success, false);
  assert.equal(decline.input.safeParse({ id: '00000000-0000-4000-8000-000000000001', reason_kind: 'preference', reason: 'не пасує нашому тону' }).success, true);
});

function managerSetup(o: { lastHash?: string | null; anomalies?: boolean; due?: Directive[]; awaiting?: any[]; after?: number | null } = {}) {
  const reviews: any[] = [];
  const updates: any[] = [];
  const memory: any[] = [];
  const llmRuns: any[] = [];
  const dg = {
    hash: 'h1', today: TODAY, resources: [{ ref: 'telegram:@space', agent: 'kira', kpis: {}, anomalies: o.anomalies ? ['views_per_post'] : [] }],
    raw: new Map([['telegram:@space', { views_per_post: { value7d: o.after ?? 1300, stale: false } }]]),
  } as any;
  const runner = new ManagerRunner({
    loop: { run: async (i: any) => { llmRuns.push(i); return { runId: 'r', status: 'ok', terminalTool: 'submit_review', totals: {} as any }; } },
    registry: { forRole: () => [] },
    runtime: { forAgent: async () => ({ skills: { get: () => undefined, list: () => [] } }) as any },
    agents: { findTop: async () => ({ id: 'm', handle: 'manager', mode: 'live', status: 'active', schedule: { times: ['08:00'] } }) as any, get: async () => null, list: async () => [{ id: 'o1', handle: 'kira' }] as any },
    repo: {
      lastReview: async () => (o.lastHash !== undefined ? { verdict: 'continue', digestHash: o.lastHash, createdAt: new Date() } : null),
      addReview: async (r: any) => { reviews.push(r); },
      memory: async () => [],
      awaitingOwnerOlderThan: async () => o.awaiting ?? [],
      update: async (id: string, p: any) => { updates.push([id, p]); return null; },
      droppedInARow: async () => 0,
      unanswered: async () => [],
      expireShadowUnanswered: async () => 0,
      contestedOlderThan: async () => [],
      acceptedForExecution: async () => [],
      dueSeriesResumes: async () => [],
      awaitingVerification: async () => [],
      dueForEvaluation: async () => o.due ?? [],
      overlapping: async () => 0,
      addMemory: async (...a: any[]) => { memory.push(a); },
    } as any,
    digest: { build: async () => dg, render: () => '{}', snapshot: async () => 1 },
    inbox: { post: async () => 1 },
    env: () => undefined,
    timeoutApplyKinds: ['frequency'],
  });
  return { runner, reviews, updates, memory, llmRuns };
}

test('manager: an unchanged digest without anomalies is skipped without an LLM call', async () => {
  const s = managerSetup({ lastHash: 'h1' });
  const r: any = await s.runner.run({ id: 'm', handle: 'manager', mode: 'live' } as any);
  assert.equal(r.skipped, 'digest unchanged, no anomalies');
  assert.equal(s.llmRuns.length, 0);
  assert.equal(s.reviews[0].verdict, 'skipped');
  const a = managerSetup({ lastHash: 'h1', anomalies: true });
  await a.runner.run({ id: 'm', handle: 'manager', mode: 'live' } as any);
  assert.equal(a.llmRuns.length, 1, 'anomalies always get a look');
});

test('manager schedule: each due time once per day', () => {
  const s = managerSetup();
  const m = { schedule: { times: ['08:00', '13:00'] } } as any;
  const at = (h: string) => new Date(`2026-10-20T${h}:00+03:00`);
  assert.equal(s.runner.dueSlot(m, at('07:59')), null);
  assert.equal(s.runner.dueSlot(m, at('08:05')), '2026-10-20@08:00');
});

test('owner-card timeouts: default drop, configured kinds apply', async () => {
  const s = managerSetup({ awaiting: [{ id: 'a1', kind: 'cross_promo' }, { id: 'a2', kind: 'frequency' }] });
  const r = await s.runner.housekeeping();
  assert.equal(r.timedOut, 2);
  assert.deepEqual(s.updates.map((u) => [u[0], u[1].ownerDecision]), [['a1', 'timeout_dropped'], ['a2', 'timeout_applied']]);
});

test('evaluator: worked / hurt / no_effect against the baseline; lessons for the manager', async () => {
  const dir = (after: number): Directive => ({
    id: 'x', toAgentId: 'o1', kind: 'format_shift', expected: { metric: 'views_per_post', direction: 'up', min_change_pct: 10 },
    outcomeDetail: { before: { value: 1000 } }, body: 'Більше каруселей', status: 'applied', createdAt: new Date(), reviewAt: new Date(),
  } as any);
  for (const [after, outcome] of [[1300, 'worked'], [800, 'hurt'], [1050, 'no_effect']] as const) {
    const s = managerSetup({ due: [dir(after)], after });
    await s.runner.evaluate();
    assert.equal(s.updates[0][1].outcome, outcome, `${after}`);
    assert.equal(s.memory.length, outcome === 'no_effect' ? 0 : 1);
  }
});
