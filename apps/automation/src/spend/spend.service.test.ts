/**
 * Spec 029 T5 unit tests: ranges, cap states, period Δ, chart pivot, CSV cells,
 * validation and the owner edits over a fake repository (no DB, no network).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { addDays, daysBetween, presetRange, previousRange, resolveRange } from './spend-range';
import {
  SpendService, blockingNow, budgetStatuses, capState, csvCell, csvLine, periodTotals, pivotDaily, type SpendServiceDeps,
} from './spend.service';
import { likePrefix, filterSql, type Agg } from './spend.repository';
import { successRate } from './overview-agents';

const NOW = new Date('2026-10-06T09:00:00Z'); // 12:00 Kyiv

test('ranges are inclusive Kyiv days; custom ranges are validated and capped at 366 days', () => {
  assert.deepEqual(presetRange('today', '2026-10-06'), { from: '2026-10-06', to: '2026-10-06', days: 1 });
  assert.deepEqual(presetRange('7d', '2026-10-06'), { from: '2026-09-30', to: '2026-10-06', days: 7 });
  assert.deepEqual(presetRange('30d', '2026-10-06'), { from: '2026-09-07', to: '2026-10-06', days: 30 });
  assert.deepEqual(presetRange('mtd', '2026-10-06'), { from: '2026-10-01', to: '2026-10-06', days: 6 });
  assert.deepEqual(previousRange(presetRange('7d', '2026-10-06')), { from: '2026-09-23', to: '2026-09-29', days: 7 });
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(daysBetween('2025-01-01', '2025-12-31'), 365);
  assert.deepEqual(resolveRange({ from: '2026-01-01', to: '2026-01-31' }, '2026-10-06'), { from: '2026-01-01', to: '2026-01-31', days: 31 });
  assert.ok('error' in resolveRange({ from: '2025-01-01', to: '2026-01-03' }, '2026-10-06'));
  assert.ok('error' in resolveRange({ from: '2026-02-30', to: '2026-03-01' }, '2026-10-06'));
  assert.ok('error' in resolveRange({ from: '2026-03-02', to: '2026-03-01' }, '2026-10-06'));
  assert.ok('error' in resolveRange({ range: 'year' }, '2026-10-06'));
  assert.equal((resolveRange({}, '2026-10-06') as any).days, 7);
});

test('capState: 70 % warning, 90 % danger, 100 % blocked (enforce) or over (alert-only)', () => {
  assert.equal(capState(0.5, null, true), 'none');
  assert.equal(capState(1, 3, true), 'ok');
  assert.equal(capState(2.1, 3, true), 'warning');
  assert.equal(capState(2.7, 3, true), 'danger');
  assert.equal(capState(3, 3, true), 'blocked');
  assert.equal(capState(3.5, 3, false), 'over');
  assert.equal(capState(0, 0, true), 'blocked');
  assert.equal(successRate(8, 11, 1), 80);
  assert.equal(successRate(0, 2, 2), null);
});

const slice = (feature: string, provider: string, usd: number, resourceRef: string | null = null) => ({ feature, provider, usd, resourceRef, rootAgentId: null });

test('budgetStatuses match caps like the gate: global, editor. prefix, provider, per-resource default and own rows', () => {
  const rows = [
    { id: 1, scope_kind: 'global', scope_key: '', daily_usd: 3, monthly_usd: 50, alert_pct: 80, enforce: true, seeded_from: 'AI_DAILY_BUDGET_USD' },
    { id: 2, scope_kind: 'feature_prefix', scope_key: 'editor.', daily_usd: 2, monthly_usd: null, alert_pct: 80, enforce: true, seeded_from: 'EDITOR_DAILY_BUDGET_USD' },
    { id: 3, scope_kind: 'resource', scope_key: '*', daily_usd: 0.3, monthly_usd: null, alert_pct: 80, enforce: true, seeded_from: 'EDITOR_CHANNEL_DAILY_BUDGET_USD' },
    { id: 4, scope_kind: 'resource', scope_key: 'telegram:@big', daily_usd: 1, monthly_usd: null, alert_pct: 80, enforce: true, seeded_from: null },
    { id: 5, scope_kind: 'provider', scope_key: 'anthropic', daily_usd: 0.5, monthly_usd: null, alert_pct: 80, enforce: false, seeded_from: null },
  ];
  const today = [
    slice('editor.executor', 'openrouter', 0.35, 'telegram:@a'),
    slice('editor.planner', 'openrouter', 0.1, 'telegram:@b'),
    slice('editor.executor', 'openrouter', 0.8, 'telegram:@big'),
    slice('strategy.recipes.translate', 'anthropic', 0.6, 'strategy:7'),
  ];
  const month = [slice('editor.executor', 'openrouter', 10, 'telegram:@a')];
  const s = budgetStatuses(rows, today, month);
  const by = (id: number) => s.find((x) => x.id === id)!;
  assert.equal(by(1).spentTodayUsd, 1.85);
  assert.equal(by(1).spentMonthUsd, 11.85);
  assert.equal(by(1).label, 'Total AI spend');
  assert.equal(by(2).spentTodayUsd, 1.25);
  assert.equal(by(2).state, 'ok');
  // @big has its own row, so the default cap covers @a (0.35 ≥ 0.3 → blocked) and @b.
  assert.equal(by(3).spentTodayUsd, 0.35);
  assert.deepEqual(by(3).resources, [{ ref: 'telegram:@a', spentUsd: 0.35, capUsd: 0.3, blocked: true }]);
  assert.equal(by(4).spentTodayUsd, 0.8);
  assert.equal(by(4).state, 'warning');
  assert.equal(by(5).state, 'over', 'alert-only rows are over, never blocked');
  const blocking = blockingNow(s, [{ agentId: 'x', handle: 'cook', capUsd: 0.1, spentUsd: 0.2, pct: 200, state: 'blocked' }]);
  assert.deepEqual(blocking.map((b) => `${b.kind}:${b.id}`), ['resource:telegram:@a', 'agent:x']);
});

const agg = (o: Partial<Agg>): Agg => ({
  key: '', calls: 0, errors: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0, costUsd: 0, estimatedUsd: 0, unpricedCalls: 0, shadowUsd: 0, avgLatencyMs: null, noUsageCalls: null, ...o,
});

test('periodTotals sums a range and compares it with the previous one', () => {
  const byDay = new Map<string, Agg>([
    ['2026-10-06', agg({ costUsd: 1, tokensIn: 100, tokensOut: 10, calls: 2 })],
    ['2026-10-05', agg({ costUsd: 0.5, tokensIn: 50, calls: 1 })],
    ['2026-09-29', agg({ costUsd: 2, tokensIn: 300, calls: 3 })],
  ]);
  const today = periodTotals(byDay, presetRange('today', '2026-10-06'));
  assert.equal(today.usd, 1);
  assert.equal(today.prev.usd, 0.5);
  assert.equal(today.deltaPct, 100);
  const w = periodTotals(byDay, presetRange('7d', '2026-10-06'));
  assert.equal(w.usd, 1.5);
  assert.equal(w.prev.usd, 2);
  assert.equal(w.deltaPct, -25);
  assert.equal(periodTotals(new Map(), presetRange('30d', '2026-10-06')).deltaPct, null);
});

test('pivotDaily fills every day and folds the tail into "other"', () => {
  const r = presetRange('7d', '2026-10-06');
  const parts = ['a', 'b', 'c', 'd'].map((stack, i) => ({ day: '2026-10-05', stack, usd: 4 - i }));
  const p = pivotDaily(parts, r, 3);
  assert.deepEqual(p.series, ['a', 'b', 'other']);
  assert.equal(p.days.length, 7);
  assert.deepEqual(p.days[5], { day: '2026-10-05', total: 10, values: { a: 4, b: 3, other: 3 } });
  assert.deepEqual(p.days[0].values, {});
});

test('CSV cells are quoted and formula-safe; filters escape LIKE wildcards', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(csvCell(-1.5), '-1.5');
  assert.equal(csvCell(null), '');
  assert.equal(csvLine(['x', 1, true]), 'x,1,true\r\n');
  assert.equal(likePrefix('strategy.a_b%'), 'strategy.a\\_b\\%%');
  const params: unknown[] = ['d1', 'd2'];
  assert.equal(filterSql({ agent: 'none', feature: 'editor.', provider: 'openrouter', shadow: true }, 'rollup', params),
    ' AND root_agent_id IS NULL AND feature LIKE $3 AND provider = $4');
  assert.deepEqual(params, ['d1', 'd2', 'editor.%', 'openrouter']);
});

function fakeDeps(over: Partial<SpendServiceDeps['repo']> = {}) {
  const calls: string[] = [];
  const store = { prices: [] as any[], budgets: new Map<number, any>(), usage: [] as any[] };
  const repo: any = {
    aggregate: async (source: string, _r: any, groupBy: string | null) => { calls.push(`aggregate:${source}:${groupBy}`); return groupBy ? [agg({ key: 'k', costUsd: 1, calls: 1 })] : [agg({ costUsd: 1, calls: 1 })]; },
    daily: async () => [],
    rollupByDay: async () => [],
    rawPage: async () => [],
    agentHandles: async () => new Map(),
    todaySlices: async () => [],
    monthSlicesBeforeToday: async () => [],
    agentCaps: async () => [],
    listPrices: async () => store.prices,
    unpricedModels: async () => [],
    upsertPrice: async (p: any) => { store.prices.push(p); return { created: true }; },
    deletePrice: async () => false,
    repriceCandidates: async (_d: number, after: number) => store.usage.filter((u) => u.id > after),
    applyReprice: async (u: any[]) => { for (const x of u) Object.assign(store.usage.find((r) => r.id === x.id), { costUsd: x.costUsd, costSource: x.costSource }); return u.length; },
    listBudgets: async () => [...store.budgets.values()],
    getBudget: async (id: number) => store.budgets.get(id) ?? null,
    upsertBudget: async (b: any) => ({ id: b.id ?? 9, created: b.id == null }),
    deleteBudget: async (id: number) => store.budgets.delete(id),
    callsBeforeLedger: async () => 0,
    ...over,
  };
  const inval = { prices: 0, budgets: 0 };
  const rollups: number[] = [];
  const price = { provider: 'anthropic', model: 'claude-haiku-4-5', inPerM: 1, outPerM: 5, cachedReadPerM: 0.1, cachedWritePerM: 1.25, perRequestUsd: null, effectiveFrom: '2026-01-01' };
  const svc = new SpendService({
    repo,
    prices: { price: async (_p: string, m: string) => (m.startsWith('claude-haiku') ? price : null), invalidate: () => { inval.prices++; } },
    budgets: { invalidate: () => { inval.budgets++; } },
    rollup: { rollup: async (d: number) => { rollups.push(d); return 0; } },
    retentionDays: 90,
    now: () => NOW,
  });
  return { svc, calls, store, inval, rollups };
}

test('breakdown reads the rollup over 2 days, raw for short, per-run and shadow views', async () => {
  const { svc, calls } = fakeDeps();
  await svc.breakdown({ range: '7d', groupBy: 'feature' });
  await svc.breakdown({ range: 'today', groupBy: 'feature' });
  await svc.breakdown({ from: '2026-10-05', to: '2026-10-06', groupBy: 'model' });
  await svc.breakdown({ range: '30d', groupBy: 'run' });
  const r = await svc.breakdown({ range: '30d', groupBy: 'agent', shadow: '1' });
  assert.deepEqual(calls.filter((c) => !c.endsWith(':null')), [
    'aggregate:rollup:feature', 'aggregate:raw:feature', 'aggregate:raw:model', 'aggregate:raw:run', 'aggregate:raw:agent',
  ]);
  assert.equal(r.source, 'raw');
  assert.equal(r.partial, false);
  const old = await svc.breakdown({ from: '2026-01-01', to: '2026-01-31', groupBy: 'run' });
  assert.equal(old.partial, true, 'raw rows older than the retention are gone');
});

test('validation: bad groupBy, range, filters and bodies are 400s with issues', async () => {
  const { svc } = fakeDeps();
  const bad = async (p: Promise<unknown>, code = 400) => {
    await assert.rejects(p, (e: any) => (code === 400 ? e instanceof BadRequestException : e instanceof ConflictException));
  };
  await bad(svc.breakdown({ groupBy: 'week' }));
  await bad(svc.breakdown({ range: 'year' }));
  await bad(svc.breakdown({ from: '2026-01-01' }));
  await bad(svc.breakdown({ agent: 'not-a-uuid' }));
  await bad(svc.breakdown({ provider: 'gemini' }));
  await bad(svc.summary({ range: 'year' }));
  await bad(svc.putPrice({ provider: 'tool', model: 'x', inPerM: 1, outPerM: 1 }));
  await bad(svc.putPrice({ provider: 'openai', model: 'gpt 4o', inPerM: 1, outPerM: 1 }));
  await bad(svc.putPrice({ provider: 'openai', model: 'gpt-4o', inPerM: -1, outPerM: 1 }));
  await bad(svc.putPrice({ provider: 'openai', model: 'gpt-4o', inPerM: 1, outPerM: 1, apiKey: 'x' }));
  await bad(svc.putBudget({ scopeKind: 'global', scopeKey: 'x', dailyUsd: 1 }));
  await bad(svc.putBudget({ scopeKind: 'provider', scopeKey: 'gemini', dailyUsd: 1 }));
  await bad(svc.putBudget({ scopeKind: 'resource', scopeKey: 'nope', dailyUsd: 1 }));
  await bad(svc.putBudget({ scopeKind: 'feature_prefix', scopeKey: 'Editor', dailyUsd: 1 }));
  await bad(svc.putBudget({ scopeKind: 'feature_prefix', scopeKey: 'strategy.', dailyUsd: null }));
  await bad(svc.putBudget({ scopeKind: 'global', dailyUsd: 1, alertPct: 0 }));
  await bad(svc.reprice({ days: 0 }));
  await bad(svc.reprice({ days: 89 }));
  await assert.rejects(svc.deletePrice({ provider: 'openai', model: 'gpt-4o', effectiveFrom: '2026-01-01' }), NotFoundException);
  const err = await svc.putPrice({ provider: 'openai' }).catch((e) => e);
  assert.ok(Array.isArray(err.getResponse().issues) && err.getResponse().issues.length > 0);
});

test('price and budget edits invalidate the running caches (no restart needed); built-in caps are protected', async () => {
  const { svc, store, inval } = fakeDeps();
  const r = await svc.putPrice({ provider: 'openai', model: 'gpt-4o-mini', inPerM: 0.15, outPerM: 0.6 });
  assert.equal(r.effectiveFrom, '2026-10-06');
  assert.equal(store.prices[0].cachedReadPerM, null);
  assert.equal(inval.prices, 1);

  store.budgets.set(1, { id: 1, scope_kind: 'global', scope_key: '', seeded_from: 'AI_DAILY_BUDGET_USD' });
  store.budgets.set(2, { id: 2, scope_kind: 'provider', scope_key: 'anthropic', seeded_from: null });
  assert.equal((await svc.putBudget({ id: 1, scopeKind: 'global', dailyUsd: 5, enforce: false })).ok, true);
  assert.equal(inval.budgets, 1);
  await assert.rejects(svc.putBudget({ id: 1, scopeKind: 'provider', scopeKey: 'openai', dailyUsd: 5 }), ConflictException);
  await assert.rejects(svc.putBudget({ id: 77, scopeKind: 'global', dailyUsd: 5 }), NotFoundException);
  await assert.rejects(svc.deleteBudget(1), ConflictException);
  assert.equal((await svc.deleteBudget(2)).ok, true);
  assert.equal(inval.budgets, 2);
});

test('reprice re-costs estimate/unpriced rows only, keeps a failed call without usage at 0, rebuilds the rollup', async () => {
  const { svc, store, rollups } = fakeDeps();
  const at = new Date('2026-10-05T10:00:00Z');
  store.usage.push(
    { id: 1, provider: 'anthropic', model: 'claude-haiku-4-5-20251001', kind: 'llm', at, status: 'ok', tokensIn: 1_000_000, tokensOut: 100_000, tokensCachedRead: 0, tokensCachedWrite: 0, costUsd: 9, costSource: 'estimate' },
    { id: 2, provider: 'anthropic', model: 'claude-haiku-4-5', kind: 'llm', at, status: 'ok', tokensIn: 1000, tokensOut: 0, tokensCachedRead: null, tokensCachedWrite: null, costUsd: null, costSource: 'unpriced' },
    { id: 3, provider: 'openai', model: 'mystery', kind: 'llm', at, status: 'ok', tokensIn: 10, tokensOut: 10, tokensCachedRead: null, tokensCachedWrite: null, costUsd: null, costSource: 'unpriced' },
    { id: 4, provider: 'anthropic', model: 'claude-haiku-4-5', kind: 'llm', at, status: 'timeout', tokensIn: null, tokensOut: null, tokensCachedRead: null, tokensCachedWrite: null, costUsd: 0, costSource: 'estimate' },
  );
  const r = await svc.reprice({ days: 7 });
  assert.equal(store.usage[0].costUsd, 1.5);
  assert.equal(store.usage[1].costUsd, 0.001);
  assert.equal(store.usage[1].costSource, 'estimate');
  assert.equal(store.usage[2].costSource, 'unpriced');
  assert.equal(store.usage[3].costUsd, 0);
  assert.equal(r.repriced, 2);
  assert.equal(r.stillUnpriced, 1);
  assert.equal(r.deltaUsd, -7.499);
  assert.deepEqual(rollups, [8]);
});

test('summary: periods, top lists, estimated note and the bars (total, agents, 3 most used)', async () => {
  const rows = [
    { id: 1, scope_kind: 'global', scope_key: '', daily_usd: 3, alert_pct: 80, enforce: true },
    { id: 2, scope_kind: 'feature_prefix', scope_key: 'editor.', daily_usd: 2, alert_pct: 80, enforce: true },
    { id: 3, scope_kind: 'provider', scope_key: 'anthropic', daily_usd: 1, alert_pct: 80, enforce: true },
    { id: 4, scope_kind: 'provider', scope_key: 'openai', daily_usd: 1, alert_pct: 80, enforce: true },
    { id: 5, scope_kind: 'provider', scope_key: 'xai', daily_usd: 1, alert_pct: 80, enforce: true },
    { id: 6, scope_kind: 'provider', scope_key: 'perplexity', daily_usd: 1, alert_pct: 80, enforce: true },
  ];
  const { svc } = fakeDeps({
    listBudgets: async () => rows,
    todaySlices: async () => [slice('dm.triage', 'anthropic', 1.2), slice('x', 'openai', 0.5), slice('y', 'xai', 0.2)],
    rollupByDay: async () => [{ ...agg({ costUsd: 2, calls: 4 }), day: '2026-10-06' }],
    aggregate: async (_s: string, _r: any, g: string | null) => {
      if (!g) return [agg({ costUsd: 10, estimatedUsd: 2, calls: 10, unpricedCalls: 0 })];
      if (g === 'agent') return [agg({ key: '', costUsd: 5 }), agg({ key: '11111111-1111-1111-1111-111111111111', costUsd: 3 })];
      return [agg({ key: 'dm.triage', costUsd: 1.2 })];
    },
    agentHandles: async () => new Map([['11111111-1111-1111-1111-111111111111', 'cook']]),
  });
  const s = await svc.summary({});
  assert.equal(s.range, '7d');
  assert.equal(s.periods.today.usd, 2);
  assert.deepEqual(s.topAgents.map((a) => a.handle), ['cook']);
  assert.equal(s.estimated.estimatedPct, 20);
  assert.equal(s.estimated.note, true);
  assert.deepEqual(s.budgets.map((b) => b.id), [1, 2, 3, 4, 5]);
  assert.equal(s.budgets[2].state, 'blocked');
  assert.deepEqual(s.blocking.map((b) => b.label), ['Provider anthropic']);
});

test('CSV export: grouped rows with the breakdown columns; raw rows page by page', async () => {
  const pages = [[{ id: 1, at: 'a', provider: 'openrouter', model: 'm', kind: 'llm', feature: 'editor.executor', costUsd: 0.5, shadow: false }], []];
  const { svc } = fakeDeps({ rawPage: async () => pages.shift() as any });
  const grouped: string[] = [];
  for await (const c of svc.exportCsv(svc.exportPlan({ range: '7d', groupBy: 'feature' }))) grouped.push(c);
  assert.match(grouped[0], /^group_by,key,label,calls,errors,tokens_in,tokens_out,tokens_cached,usd,pct_of_total/);
  assert.match(grouped[1], /^feature,k,k,1,0,0,0,0,1,100,/);
  const raw: string[] = [];
  for await (const c of svc.exportCsv(svc.exportPlan({ range: 'today', groupBy: 'raw' }), 1)) raw.push(c);
  assert.match(raw[0], /^id,at,provider,model/);
  assert.match(raw[1], /^1,a,openrouter,m,llm,editor.executor/);
  assert.equal(svc.exportPlan({ range: 'today' }).filename, 'ai-spend_2026-10-06_2026-10-06_day.csv');
  assert.throws(() => svc.exportPlan({ groupBy: 'nope' }), BadRequestException);
});
