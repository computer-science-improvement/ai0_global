import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { kyivDay } from '../common/ai/usage/kyiv-day';
import { costFromPrice } from '../common/ai/usage/price.service';
import type { PriceRow } from '../common/ai/usage/llm-prices.repository';
import { AGENTS_SCOPE, RESOURCE_DEFAULT_SCOPE } from '../common/ai/usage/llm-budgets.repository';
import {
  addDays, eachDay, presetRange, previousRange, resolveRange, RANGES, type DayRange, type RangeKey,
} from './spend-range';
import {
  GROUP_BYS, STACK_BYS, type Agg, type GroupBy, type SpendFilters, type SpendRepository, type SpendSlice, type Source, type StackBy,
} from './spend.repository';

export const PROVIDERS = ['openrouter', 'anthropic', 'openai', 'perplexity', 'xai', 'agent_sdk', 'tool'] as const;
/** Providers a price row can exist for (tool steps carry their own cost). */
const PRICED_PROVIDERS = ['openrouter', 'anthropic', 'openai', 'perplexity', 'xai', 'agent_sdk'] as const;

const badRequest = (e: z.ZodError) =>
  new BadRequestException({ error: 'invalid_request', issues: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const usd = (max: number) => z.number().finite().min(0).max(max);
const boolish = z.union([z.boolean(), z.enum(['1', '0', 'true', 'false'])]).transform((v) => v === true || v === '1' || v === 'true');

const FiltersSchema = z.object({
  agent:    z.union([z.uuid(), z.literal('none')]).optional(),
  feature:  z.string().trim().regex(/^[a-z0-9_.-]{1,80}\*?$/, 'a feature prefix such as editor. or strategy.recipes').transform((s) => s.replace(/\*$/, '')).optional(),
  provider: z.enum(PROVIDERS).optional(),
  shadow:   boolish.optional(),
});

const RangeQuery = z.object({ range: z.enum(RANGES).optional(), from: day.optional(), to: day.optional() });

const BreakdownQuery = RangeQuery.extend(FiltersSchema.shape).extend({
  groupBy: z.enum(GROUP_BYS).default('day'),
  stackBy: z.enum(STACK_BYS).default('provider'),
});

const ExportQuery = RangeQuery.extend(FiltersSchema.shape).extend({
  groupBy: z.enum([...GROUP_BYS, 'raw'] as const).default('day'),
});

const PriceBody = z.object({
  provider:        z.enum(PRICED_PROVIDERS),
  model:           z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._:/@-]+$/, 'letters, digits and . _ : / @ - only'),
  inPerM:          usd(1000),
  outPerM:         usd(1000),
  cachedReadPerM:  usd(1000).nullable().optional(),
  cachedWritePerM: usd(1000).nullable().optional(),
  perRequestUsd:   usd(10).nullable().optional(),
  effectiveFrom:   day.optional(),
  note:            z.string().trim().max(200).nullable().optional(),
}).strict();

const PriceKey = z.object({ provider: z.enum(PRICED_PROVIDERS), model: z.string().trim().min(1).max(120), effectiveFrom: day });

const SCOPE_KINDS = ['global', 'feature_prefix', 'provider', 'resource'] as const;
const RESOURCE_REF = /^(telegram|instagram|facebook|threads|tiktok|youtube|meta|strategy):[^\s]{1,120}$/;

const BudgetBody = z.object({
  id:         z.number().int().positive().optional(),
  scopeKind:  z.enum(SCOPE_KINDS),
  scopeKey:   z.string().trim().max(130).default(''),
  dailyUsd:   usd(1000).nullable(),
  monthlyUsd: usd(30000).nullable().optional(),
  alertPct:   z.number().int().min(1).max(100).default(80),
  enforce:    z.boolean().default(true),
}).strict().superRefine((b, ctx) => {
  const bad = (message: string) => ctx.addIssue({ code: 'custom', path: ['scopeKey'], message });
  if (b.scopeKind === 'global' && b.scopeKey !== '') bad('the global cap has an empty scope key');
  if (b.scopeKind === 'feature_prefix' && !/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*\.?$/.test(b.scopeKey)) bad('a feature prefix such as editor. or strategy.recipes');
  if (b.scopeKind === 'provider' && !(PROVIDERS as readonly string[]).includes(b.scopeKey)) bad(`one of ${PROVIDERS.join(', ')}`);
  if (b.scopeKind === 'resource' && b.scopeKey !== '*' && !RESOURCE_REF.test(b.scopeKey)) bad('* (every resource) or a resource ref such as telegram:@channel');
  if (b.dailyUsd == null && (b.monthlyUsd ?? null) == null) ctx.addIssue({ code: 'custom', path: ['dailyUsd'], message: 'set a daily or a monthly cap' });
});

const RepriceBody = z.object({ days: z.number().int().min(1) }).strict();

export type BudgetState = 'none' | 'ok' | 'warning' | 'danger' | 'over' | 'blocked';

export interface BudgetStatus {
  id:            number;
  scopeKind:     typeof SCOPE_KINDS[number];
  scopeKey:      string;
  label:         string;
  dailyUsd:      number | null;
  monthlyUsd:    number | null;
  alertPct:      number;
  enforce:       boolean;
  seededFrom:    string | null;
  updatedAt:     string | null;
  /** Today's spend under this cap (for the per-resource default: the highest resource). */
  spentTodayUsd: number;
  spentMonthUsd: number;
  pct:           number | null;
  state:         BudgetState;
  /** Per-resource caps: the resources at or over the cap today (blocked when enforce). */
  resources?:    Array<{ ref: string; spentUsd: number; capUsd: number; blocked: boolean }>;
}

export interface AgentCapStatus { agentId: string; handle: string; capUsd: number; spentUsd: number; pct: number; state: BudgetState }

export interface BlockingCap { kind: 'budget' | 'resource' | 'agent'; id: string; label: string; spentUsd: number; capUsd: number }

export interface SpendServiceDeps {
  repo:    Pick<SpendRepository,
    'aggregate' | 'daily' | 'rollupByDay' | 'rawPage' | 'agentHandles' | 'todaySlices' | 'monthSlicesBeforeToday' | 'agentCaps'
    | 'listPrices' | 'unpricedModels' | 'upsertPrice' | 'deletePrice' | 'repriceCandidates' | 'applyReprice'
    | 'listBudgets' | 'getBudget' | 'upsertBudget' | 'deleteBudget' | 'callsBeforeLedger'>;
  /** Price lookup (the same cache the ledger uses); invalidated on every price edit. */
  prices:  { price(provider: string, model: string, at?: Date): Promise<PriceRow | null>; invalidate(): void };
  /** The blocking caps' cache; invalidated on every budget edit so it applies without a restart. */
  budgets: { invalidate(): void };
  /** Recompute the rollup for the last N Kyiv days (after a reprice). */
  rollup:  { rollup(days: number): Promise<number> };
  /** Flush buffered ledger rows before a reprice. */
  flush?:  () => Promise<void>;
  /** Raw llm_usage retention (LLM_USAGE_RETENTION_DAYS, default 90). */
  retentionDays?: number;
  now?:    () => Date;
}

/** Ranges longer than this read the rollup (FR-007). */
export const RAW_MAX_DAYS = 2;
const ROW_LIMIT = 500;
const SERIES_LIMIT = 7;
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

export function budgetLabel(kind: string, key: string): string {
  if (kind === 'global') return 'Total AI spend';
  if (kind === 'feature_prefix' && key === AGENTS_SCOPE.scopeKey) return 'Agents (editor.*)';
  if (kind === 'feature_prefix') return `Feature ${key}*`;
  if (kind === 'provider') return `Provider ${key}`;
  return key === RESOURCE_DEFAULT_SCOPE.scopeKey ? 'Each resource (default)' : `Resource ${key}`;
}

/** Colour state of a daily cap: BR-CORE-34 thresholds (70 % / 90 %), then over or blocked at 100 %. */
export function capState(spent: number, cap: number | null, enforce: boolean): BudgetState {
  if (cap == null) return 'none';
  if (spent >= cap) return enforce ? 'blocked' : 'over';
  const pct = cap > 0 ? (spent / cap) * 100 : 0;
  return pct >= 90 ? 'danger' : pct >= 70 ? 'warning' : 'ok';
}

/** Spend under one cap row (the same matching as LlmBudgetService / BudgetService). */
function matches(kind: string, key: string, s: SpendSlice): boolean {
  if (kind === 'global') return true;
  if (kind === 'feature_prefix') return s.feature.startsWith(key);
  if (kind === 'provider') return s.provider === key;
  // Resource caps cover the agents' (editor.*) spend of that resource.
  return s.feature.startsWith('editor.') && s.resourceRef != null && (key === '*' || s.resourceRef === key);
}

const sumOf = (slices: SpendSlice[], pred: (s: SpendSlice) => boolean) => slices.reduce((t, s) => (pred(s) ? t + s.usd : t), 0);

/** Live state of every llm_budgets row (pure; exported for tests). */
export function budgetStatuses(rows: any[], today: SpendSlice[], monthBefore: SpendSlice[]): BudgetStatus[] {
  const ownResourceKeys = new Set(rows.filter((r) => r.scope_kind === 'resource' && r.scope_key !== '*').map((r) => r.scope_key));
  return rows.map((r) => {
    const kind = r.scope_kind as BudgetStatus['scopeKind'];
    const key = String(r.scope_key ?? '');
    const daily = r.daily_usd == null ? null : Number(r.daily_usd);
    const enforce = r.enforce !== false;
    let spentToday: number;
    let resources: BudgetStatus['resources'];
    if (kind === 'resource' && key === '*') {
      // The default cap applies to each resource without its own row; its bar shows the worst one.
      const per = new Map<string, number>();
      for (const s of today) if (matches(kind, key, s) && !ownResourceKeys.has(s.resourceRef!)) per.set(s.resourceRef!, (per.get(s.resourceRef!) ?? 0) + s.usd);
      const sorted = [...per.entries()].sort((a, b) => b[1] - a[1]);
      spentToday = sorted[0]?.[1] ?? 0;
      resources = daily == null ? [] : sorted.filter(([, v]) => v >= daily).map(([ref, v]) => ({ ref, spentUsd: round6(v), capUsd: daily, blocked: enforce }));
    } else {
      spentToday = sumOf(today, (s) => matches(kind, key, s));
    }
    const spentMonth = kind === 'resource' && key === '*' ? 0 : spentToday + sumOf(monthBefore, (s) => matches(kind, key, s));
    return {
      id: Number(r.id), scopeKind: kind, scopeKey: key, label: budgetLabel(kind, key),
      dailyUsd: daily, monthlyUsd: r.monthly_usd == null ? null : Number(r.monthly_usd), alertPct: Number(r.alert_pct ?? 80), enforce,
      seededFrom: r.seeded_from ?? null, updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
      spentTodayUsd: round6(spentToday), spentMonthUsd: round6(spentMonth),
      pct: daily != null && daily > 0 ? Math.round((spentToday / daily) * 1000) / 10 : daily === 0 ? 100 : null,
      state: capState(spentToday, daily, enforce),
      ...(resources ? { resources } : {}),
    };
  });
}

/** Everything that blocks calls right now. */
export function blockingNow(statuses: BudgetStatus[], agents: AgentCapStatus[]): BlockingCap[] {
  const out: BlockingCap[] = [];
  for (const b of statuses) {
    if (b.resources?.length) {
      for (const r of b.resources) if (r.blocked) out.push({ kind: 'resource', id: r.ref, label: `Resource ${r.ref}`, spentUsd: r.spentUsd, capUsd: r.capUsd });
    } else if (b.state === 'blocked') {
      out.push({ kind: 'budget', id: String(b.id), label: b.label, spentUsd: b.spentTodayUsd, capUsd: b.dailyUsd! });
    }
  }
  for (const a of agents) if (a.state === 'blocked') out.push({ kind: 'agent', id: a.agentId, label: `Agent @${a.handle}`, spentUsd: a.spentUsd, capUsd: a.capUsd });
  return out;
}

const emptyAgg = (): Agg => ({
  key: '', calls: 0, errors: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0, costUsd: 0, estimatedUsd: 0, unpricedCalls: 0, shadowUsd: 0, avgLatencyMs: null, noUsageCalls: null,
});

function addAgg(a: Agg, b: Agg): Agg {
  return {
    ...a, calls: a.calls + b.calls, errors: a.errors + b.errors, tokensIn: a.tokensIn + b.tokensIn, tokensOut: a.tokensOut + b.tokensOut,
    tokensCached: a.tokensCached + b.tokensCached, costUsd: a.costUsd + b.costUsd, estimatedUsd: a.estimatedUsd + b.estimatedUsd,
    unpricedCalls: a.unpricedCalls + b.unpricedCalls, shadowUsd: a.shadowUsd + b.shadowUsd,
  };
}

export interface PeriodTotals {
  from: string; to: string;
  usd: number; tokensIn: number; tokensOut: number; tokensCached: number; calls: number; errors: number;
  prev: { usd: number; tokensIn: number; tokensOut: number; tokensCached: number; calls: number };
  /** Δ USD against the previous period of the same length, in %; null when the previous period is 0. */
  deltaPct: number | null;
  deltaTokensPct: number | null;
}

const pctDelta = (cur: number, prev: number) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);

/** Totals of a day range and its previous period from rollup rows per day (pure). */
export function periodTotals(byDay: Map<string, Agg>, r: DayRange): PeriodTotals {
  const sum = (rr: DayRange) => eachDay(rr).reduce((t, d) => (byDay.has(d) ? addAgg(t, byDay.get(d)!) : t), emptyAgg());
  const cur = sum(r);
  const prev = sum(previousRange(r));
  const tok = (a: Agg) => a.tokensIn + a.tokensOut;
  return {
    from: r.from, to: r.to,
    usd: round6(cur.costUsd), tokensIn: cur.tokensIn, tokensOut: cur.tokensOut, tokensCached: cur.tokensCached, calls: cur.calls, errors: cur.errors,
    prev: { usd: round6(prev.costUsd), tokensIn: prev.tokensIn, tokensOut: prev.tokensOut, tokensCached: prev.tokensCached, calls: prev.calls },
    deltaPct: pctDelta(cur.costUsd, prev.costUsd),
    deltaTokensPct: pctDelta(tok(cur), tok(prev)),
  };
}

/** Pivot (day, stack, usd) parts into chart rows with the top series and an "other" bucket (pure). */
export function pivotDaily(parts: Array<{ day: string; stack: string; usd: number }>, r: DayRange, limit = SERIES_LIMIT) {
  const totals = new Map<string, number>();
  for (const p of parts) totals.set(p.stack, (totals.get(p.stack) ?? 0) + p.usd);
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
  const top = ranked.length > limit ? ranked.slice(0, limit - 1) : ranked;
  const series = ranked.length > limit ? [...top, 'other'] : top;
  const topSet = new Set(top);
  const byDay = new Map<string, Record<string, number>>();
  for (const p of parts) {
    const k = topSet.has(p.stack) ? p.stack : 'other';
    const row = byDay.get(p.day) ?? {};
    row[k] = round6((row[k] ?? 0) + p.usd);
    byDay.set(p.day, row);
  }
  const days = eachDay(r).map((d) => {
    const values = byDay.get(d) ?? {};
    return { day: d, total: round6(Object.values(values).reduce((a, b) => a + b, 0)), values };
  });
  return { series, days };
}

export interface BreakdownRow extends Agg {
  label:     string;
  pct:       number;
  estimated: boolean;
  runId?:    string;
}

const NONE_LABEL: Partial<Record<GroupBy, string>> = { agent: 'No agent', role: 'No role', resource: 'No resource', run: 'No run' };

/** CSV cell: quoted when needed; text that a spreadsheet would run as a formula is prefixed with '. */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const csvLine = (cells: unknown[]) => `${cells.map(csvCell).join(',')}\r\n`;

export const GROUP_CSV_HEADER = [
  'group_by', 'key', 'label', 'calls', 'errors', 'tokens_in', 'tokens_out', 'tokens_cached', 'usd', 'pct_of_total',
  'avg_latency_ms', 'estimated_usd', 'unpriced_calls', 'shadow_usd', 'estimated',
];
export const RAW_CSV_HEADER = [
  'id', 'at', 'provider', 'model', 'kind', 'feature', 'root_agent_id', 'agent_handle', 'role', 'run_id', 'step_idx', 'resource_ref',
  'tokens_in', 'tokens_out', 'tokens_cached_read', 'tokens_cached_write', 'usd', 'cost_source', 'latency_ms', 'attempts', 'status',
  'error_code', 'shadow',
];

/**
 * The spend reports and the owner's price and budget edits (spec 029 FR-009–FR-011).
 * Every query is zod-validated; reports over more than two days read the
 * rollup, shorter ones and per-run/shadow views read the raw ledger. Edits
 * invalidate the in-process caches so a new price or cap applies at once.
 */
export class SpendService {
  constructor(private readonly d: SpendServiceDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }
  private today(): string { return kyivDay(this.now()); }
  private get retentionDays(): number { return this.d.retentionDays ?? 90; }

  private range(q: { range?: string; from?: string; to?: string }): DayRange {
    const r = resolveRange(q, this.today());
    if ('error' in r) throw new BadRequestException({ error: 'invalid_range', details: r.error });
    return r;
  }

  /** First Kyiv day still fully covered by raw rows. */
  private rawFrom(): string { return addDays(this.today(), -(this.retentionDays - 1)); }

  pickSource(r: DayRange, groupBy: GroupBy | 'raw' | null, f: SpendFilters): Source {
    if (groupBy === 'run' || groupBy === 'raw' || f.shadow) return 'raw';
    return r.days > RAW_MAX_DAYS ? 'rollup' : 'raw';
  }

  // ── summary (Overview card) ──────────────────────────────────────────────

  async summary(raw: unknown) {
    const p = RangeQuery.pick({ range: true }).safeParse(raw ?? {});
    if (!p.success) throw badRequest(p.error);
    const rangeKey: RangeKey = p.data.range ?? '7d';
    const today = this.today();
    const range = presetRange(rangeKey, today);
    const byDayRows = await this.d.repo.rollupByDay(addDays(today, -59));
    const byDay = new Map(byDayRows.map((x) => [x.day, x as Agg]));
    const periods = {
      today: periodTotals(byDay, presetRange('today', today)),
      '7d':  periodTotals(byDay, presetRange('7d', today)),
      '30d': periodTotals(byDay, presetRange('30d', today)),
    };
    const [totalsRows, agents, features, budgets] = await Promise.all([
      this.d.repo.aggregate('rollup', range, null, {}),
      this.d.repo.aggregate('rollup', range, 'agent', {}, 6),
      this.d.repo.aggregate('rollup', range, 'feature', {}, 5),
      this.budgetsView(),
    ]);
    const totals = totalsRows[0] ?? emptyAgg();
    const handles = await this.d.repo.agentHandles(agents.map((a) => a.key).filter(Boolean));
    const estimatedShare = totals.costUsd > 0 ? totals.estimatedUsd / totals.costUsd : 0;
    const unpricedShare = totals.calls > 0 ? totals.unpricedCalls / totals.calls : 0;

    // Bars: the total cap, the agents' cap, then the 3 most-used other caps (FR-009).
    const total = budgets.rows.find((b) => b.scopeKind === 'global');
    const agentsCap = budgets.rows.find((b) => b.scopeKind === 'feature_prefix' && b.scopeKey === AGENTS_SCOPE.scopeKey);
    const others = budgets.rows
      .filter((b) => b !== total && b !== agentsCap && b.dailyUsd != null)
      .sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0) || b.spentTodayUsd - a.spentTodayUsd)
      .slice(0, 3);

    return {
      generatedAt: this.now().toISOString(), today, range: rangeKey, from: range.from, to: range.to,
      periods,
      shadowUsd: round6(totals.shadowUsd),
      estimated: {
        estimatedPct: Math.round(estimatedShare * 1000) / 10,
        unpricedPct:  Math.round(unpricedShare * 1000) / 10,
        unpricedCalls: totals.unpricedCalls,
        note: estimatedShare > 0.1 || unpricedShare > 0.1,
      },
      topAgents: agents.filter((a) => a.key !== '').slice(0, 5).map((a) => ({
        rootAgentId: a.key, handle: handles.get(a.key) ?? null, usd: round6(a.costUsd), calls: a.calls,
        tokens: a.tokensIn + a.tokensOut,
      })),
      topFeatures: features.map((f) => ({ feature: f.key, usd: round6(f.costUsd), calls: f.calls, tokens: f.tokensIn + f.tokensOut })),
      budgets: [total, agentsCap, ...others].filter((b): b is BudgetStatus => !!b),
      blocking: budgets.blocking,
    };
  }

  // ── breakdown (Spend page) ───────────────────────────────────────────────

  async breakdown(raw: unknown) {
    const p = BreakdownQuery.safeParse(raw ?? {});
    if (!p.success) throw badRequest(p.error);
    const q = p.data;
    const range = this.range(q);
    const filters: SpendFilters = { agent: q.agent, feature: q.feature, provider: q.provider, shadow: q.shadow };
    const source = this.pickSource(range, q.groupBy, filters);
    const [rowsRaw, totalsRows, parts] = await Promise.all([
      this.d.repo.aggregate(source, range, q.groupBy, filters, ROW_LIMIT + 1),
      this.d.repo.aggregate(source, range, null, filters),
      this.d.repo.daily(source, range, q.stackBy, filters),
    ]);
    const totals = totalsRows[0] ?? emptyAgg();
    const rows = await this.labelRows(q.groupBy, rowsRaw.slice(0, ROW_LIMIT), totals.costUsd);
    return {
      from: range.from, to: range.to, days: range.days, groupBy: q.groupBy, stackBy: q.stackBy, source,
      /** Raw rows older than the retention are gone: a raw-source report over them is partial. */
      partial: source === 'raw' && range.from < this.rawFrom(),
      retentionDays: this.retentionDays,
      truncated: rowsRaw.length > ROW_LIMIT,
      filters,
      totals: { ...totals, costUsd: round6(totals.costUsd), estimatedUsd: round6(totals.estimatedUsd), shadowUsd: round6(totals.shadowUsd) },
      rows,
      chart: pivotDaily(parts, range),
    };
  }

  private async labelRows(groupBy: GroupBy, rows: Agg[], totalUsd: number): Promise<BreakdownRow[]> {
    const handles = groupBy === 'agent' ? await this.d.repo.agentHandles(rows.map((r) => r.key).filter(Boolean)) : new Map<string, string>();
    return rows.map((r) => {
      let label = r.key || NONE_LABEL[groupBy] || '—';
      if (groupBy === 'agent' && r.key) label = handles.has(r.key) ? `@${handles.get(r.key)}` : 'Deleted agent';
      return {
        ...r, costUsd: round6(r.costUsd), estimatedUsd: round6(r.estimatedUsd), shadowUsd: round6(r.shadowUsd), label,
        pct: totalUsd > 0 ? Math.round((r.costUsd / totalUsd) * 1000) / 10 : 0,
        estimated: r.estimatedUsd > 0 || r.unpricedCalls > 0,
        ...(groupBy === 'run' && r.key ? { runId: r.key } : {}),
      };
    });
  }

  // ── CSV export ───────────────────────────────────────────────────────────

  /** Validate the export query (before any byte is written, so errors are proper 400s). */
  exportPlan(raw: unknown) {
    const p = ExportQuery.safeParse(raw ?? {});
    if (!p.success) throw badRequest(p.error);
    const q = p.data;
    const range = this.range(q);
    const filters: SpendFilters = { agent: q.agent, feature: q.feature, provider: q.provider, shadow: q.shadow };
    return { range, filters, groupBy: q.groupBy, filename: `ai-spend_${range.from}_${range.to}_${q.groupBy}.csv` };
  }

  /** CSV lines of a plan: grouped rows (same columns as the breakdown), or raw ledger rows page by page. */
  async *exportCsv(plan: ReturnType<SpendService['exportPlan']>, pageSize = 5000): AsyncGenerator<string> {
    const { range, filters, groupBy } = plan;
    if (groupBy === 'raw') {
      yield csvLine(RAW_CSV_HEADER);
      let after = 0;
      for (;;) {
        const page = await this.d.repo.rawPage(range, filters, after, pageSize);
        if (!page.length) return;
        let chunk = '';
        for (const r of page) {
          chunk += csvLine([
            r.id, r.at, r.provider, r.model, r.kind, r.feature, r.rootAgentId, r.agentHandle, r.role, r.runId, r.stepIdx, r.resourceRef,
            r.tokensIn, r.tokensOut, r.tokensCachedRead, r.tokensCachedWrite, r.costUsd, r.costSource, r.latencyMs, r.attempts, r.status,
            r.errorCode, r.shadow,
          ]);
        }
        yield chunk;
        after = page[page.length - 1].id;
        if (page.length < pageSize) return;
      }
    }
    const source = this.pickSource(range, groupBy, filters);
    const [rows, totalsRows] = await Promise.all([
      this.d.repo.aggregate(source, range, groupBy, filters, 100_000),
      this.d.repo.aggregate(source, range, null, filters),
    ]);
    const labelled = await this.labelRows(groupBy, rows, totalsRows[0]?.costUsd ?? 0);
    yield csvLine(GROUP_CSV_HEADER);
    let chunk = '';
    for (const r of labelled) {
      chunk += csvLine([
        groupBy, r.key, r.label, r.calls, r.errors, r.tokensIn, r.tokensOut, r.tokensCached, r.costUsd, r.pct,
        r.avgLatencyMs, r.estimatedUsd, r.unpricedCalls, r.shadowUsd, r.estimated,
      ]);
    }
    if (chunk) yield chunk;
  }

  // ── prices ───────────────────────────────────────────────────────────────

  async listPrices() {
    const [rows, unpriced] = await Promise.all([this.d.repo.listPrices(), this.d.repo.unpricedModels()]);
    const today = this.today();
    const current = new Set<string>();
    return {
      rows: rows.map((r: any) => {
        const k = `${r.provider}\u0000${r.model}`;
        // Rows come newest effective_from first per model: the first one already in effect is current.
        const isCurrent = !current.has(k) && r.effective_from <= today;
        if (isCurrent) current.add(k);
        return {
          provider: r.provider, model: r.model, inPerM: r.in_per_m, outPerM: r.out_per_m,
          cachedReadPerM: r.cached_read_per_m, cachedWritePerM: r.cached_write_per_m, perRequestUsd: r.per_request_usd,
          effectiveFrom: r.effective_from, note: r.note ?? null, updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
          current: isCurrent, scheduled: r.effective_from > today,
        };
      }),
      unpriced,
      repriceMaxDays: this.repriceMaxDays(),
    };
  }

  async putPrice(raw: unknown) {
    const p = PriceBody.safeParse(raw ?? {});
    if (!p.success) throw badRequest(p.error);
    const b = p.data;
    const effectiveFrom = b.effectiveFrom ?? this.today();
    if (effectiveFrom > addDays(this.today(), 366)) throw new BadRequestException({ error: 'invalid_request', details: 'effectiveFrom is more than a year ahead' });
    const res = await this.d.repo.upsertPrice({
      provider: b.provider, model: b.model, inPerM: b.inPerM, outPerM: b.outPerM, cachedReadPerM: b.cachedReadPerM ?? null,
      cachedWritePerM: b.cachedWritePerM ?? null, perRequestUsd: b.perRequestUsd ?? null, effectiveFrom, note: b.note ?? null,
    });
    this.d.prices.invalidate();
    return { ok: true, created: res.created, provider: b.provider, model: b.model, effectiveFrom };
  }

  async deletePrice(raw: unknown) {
    const p = PriceKey.safeParse(raw ?? {});
    if (!p.success) throw badRequest(p.error);
    const ok = await this.d.repo.deletePrice(p.data.provider, p.data.model, p.data.effectiveFrom);
    if (!ok) throw new NotFoundException({ error: 'not_found' });
    this.d.prices.invalidate();
    return { ok: true };
  }

  /** Reprice may only touch days whose raw rows are all still kept (the rollup of those days is rebuilt from them). */
  repriceMaxDays(): number { return Math.max(1, Math.min(90, this.retentionDays - 2)); }

  /**
   * Owner action "Reprice estimates for the last N days" (FR-005): re-cost
   * `estimate` and `unpriced` rows with the current price table, then rebuild
   * the rollup of those days. `provider` and `backfill` rows never change; a
   * failed call without usage keeps its zero cost.
   */
  async reprice(raw: unknown) {
    const p = RepriceBody.safeParse(raw ?? {});
    if (!p.success) throw badRequest(p.error);
    const max = this.repriceMaxDays();
    if (p.data.days > max) throw new BadRequestException({ error: 'invalid_request', details: `at most ${max} days (raw ledger retention)` });
    const days = p.data.days;
    await this.d.flush?.().catch(() => {});
    this.d.prices.invalidate();
    let after = 0;
    let scanned = 0;
    let changed = 0;
    let stillUnpriced = 0;
    let deltaUsd = 0;
    for (;;) {
      const batch = await this.d.repo.repriceCandidates(days, after, 2000);
      if (!batch.length) break;
      const updates: Array<{ id: number; costUsd: number | null; costSource: 'estimate' | 'unpriced' }> = [];
      for (const r of batch) {
        scanned++;
        if (r.status !== 'ok' && r.tokensIn == null && r.tokensOut == null) continue;
        const price = await this.d.prices.price(r.provider, r.model, r.at);
        const next = price
          ? { costUsd: costFromPrice(price, { tokensIn: r.tokensIn, tokensOut: r.tokensOut, tokensCachedRead: r.tokensCachedRead, tokensCachedWrite: r.tokensCachedWrite }), costSource: 'estimate' as const }
          : { costUsd: null, costSource: 'unpriced' as const };
        if (!price) stillUnpriced++;
        if (next.costSource === r.costSource && (next.costUsd ?? null) === (r.costUsd ?? null)) continue;
        deltaUsd += (next.costUsd ?? 0) - (r.costUsd ?? 0);
        updates.push({ id: r.id, ...next });
      }
      changed += await this.d.repo.applyReprice(updates);
      after = batch[batch.length - 1].id;
      if (batch.length < 2000) break;
    }
    // The cut-off "now − N days" falls inside day today−N, so that day is rebuilt too.
    const rollupDays = days + 1;
    await this.d.rollup.rollup(rollupDays);
    return { ok: true, days, scanned, repriced: changed, stillUnpriced, deltaUsd: round6(deltaUsd), rollupDays };
  }

  // ── budgets ──────────────────────────────────────────────────────────────

  async budgetsView() {
    const [rows, today, month, agentRows] = await Promise.all([
      this.d.repo.listBudgets(), this.d.repo.todaySlices(), this.d.repo.monthSlicesBeforeToday(), this.d.repo.agentCaps(),
    ]);
    const statuses = budgetStatuses(rows, today, month);
    const agentCaps: AgentCapStatus[] = agentRows.map((a) => ({
      agentId: a.id, handle: a.handle, capUsd: a.capUsd, spentUsd: round6(a.spentUsd),
      pct: a.capUsd > 0 ? Math.round((a.spentUsd / a.capUsd) * 1000) / 10 : 100,
      // Per-agent caps always block (BudgetService passes enforce = true).
      state: capState(a.spentUsd, a.capUsd, true),
    }));
    return { today: this.today(), rows: statuses, agentCaps, blocking: blockingNow(statuses, agentCaps) };
  }

  async putBudget(raw: unknown) {
    const p = BudgetBody.safeParse(raw ?? {});
    if (!p.success) throw badRequest(p.error);
    const b = p.data;
    if (b.id != null) {
      const cur = await this.d.repo.getBudget(b.id);
      if (!cur) throw new NotFoundException({ error: 'not_found' });
      if (cur.seeded_from && (cur.scope_kind !== b.scopeKind || cur.scope_key !== b.scopeKey)) {
        throw new ConflictException({ error: 'seeded_scope_locked', details: 'the scope of a built-in cap cannot change; edit its amounts or set enforce off' });
      }
    }
    let res: { id: number; created: boolean } | null;
    try {
      res = await this.d.repo.upsertBudget({
        id: b.id, scopeKind: b.scopeKind, scopeKey: b.scopeKey, dailyUsd: b.dailyUsd, monthlyUsd: b.monthlyUsd ?? null, alertPct: b.alertPct, enforce: b.enforce,
      });
    } catch (err: any) {
      if (err?.code === '23505') throw new ConflictException({ error: 'scope_exists', details: 'another cap already has this scope' });
      throw err;
    }
    if (!res) throw new NotFoundException({ error: 'not_found' });
    // The blocking gate re-reads caps on its next check: the edit applies without a restart.
    this.d.budgets.invalidate();
    return { ok: true, id: res.id, created: res.created };
  }

  async deleteBudget(id: number) {
    const cur = await this.d.repo.getBudget(id);
    if (!cur) throw new NotFoundException({ error: 'not_found' });
    if (cur.seeded_from) {
      throw new ConflictException({ error: 'seeded_row', details: 'built-in caps cannot be deleted (they are re-seeded at boot); set enforce off or raise the cap' });
    }
    await this.d.repo.deleteBudget(id);
    this.d.budgets.invalidate();
    return { ok: true };
  }

  /** ai_logs calls made before the ledger existed (no tokens, no cost). */
  async ledgerInfo() {
    return { callsBeforeLedger: await this.d.repo.callsBeforeLedger(), retentionDays: this.retentionDays };
  }
}
