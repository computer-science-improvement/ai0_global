import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, unauthorized } from './client';
import { API_BASE } from '../lib/env';

// AI spend analytics (spec 029): GET /api/spend/{summary,breakdown,prices,budgets,ledger},
// GET /api/spend/export.csv, PUT/DELETE prices and budgets, POST /api/spend/reprice,
// and GET /api/overview/agents for the Overview "Agents" card.

export type SpendRange = 'today' | '7d' | '30d' | 'mtd';
export type SpendGroupBy = 'day' | 'agent' | 'role' | 'resource' | 'provider' | 'model' | 'feature' | 'run';
export type SpendStackBy = 'provider' | 'feature';
export type SpendProvider = 'openrouter' | 'anthropic' | 'openai' | 'perplexity' | 'xai' | 'agent_sdk' | 'tool';
export type BudgetScopeKind = 'global' | 'feature_prefix' | 'provider' | 'resource';
export type BudgetState = 'none' | 'ok' | 'warning' | 'danger' | 'over' | 'blocked';

export const SPEND_PROVIDERS: SpendProvider[] = ['openrouter', 'anthropic', 'openai', 'perplexity', 'xai', 'agent_sdk', 'tool'];

export interface SpendPeriod {
  from: string; to: string;
  usd: number; tokensIn: number; tokensOut: number; tokensCached: number; calls: number; errors: number;
  prev: { usd: number; tokensIn: number; tokensOut: number; tokensCached: number; calls: number };
  deltaPct: number | null;
  deltaTokensPct: number | null;
}

export interface BudgetStatus {
  id:            number;
  scopeKind:     BudgetScopeKind;
  scopeKey:      string;
  label:         string;
  dailyUsd:      number | null;
  monthlyUsd:    number | null;
  alertPct:      number;
  enforce:       boolean;
  seededFrom:    string | null;
  updatedAt:     string | null;
  spentTodayUsd: number;
  spentMonthUsd: number;
  pct:           number | null;
  state:         BudgetState;
  resources?:    Array<{ ref: string; spentUsd: number; capUsd: number; blocked: boolean }>;
}

export interface BlockingCap { kind: 'budget' | 'resource' | 'agent'; id: string; label: string; spentUsd: number; capUsd: number }

export interface SpendSummary {
  generatedAt: string;
  today:       string;
  range:       SpendRange;
  from:        string;
  to:          string;
  periods:     { today: SpendPeriod; '7d': SpendPeriod; '30d': SpendPeriod };
  shadowUsd:   number;
  estimated:   { estimatedPct: number; unpricedPct: number; unpricedCalls: number; note: boolean };
  topAgents:   Array<{ rootAgentId: string; handle: string | null; usd: number; calls: number; tokens: number }>;
  topFeatures: Array<{ feature: string; usd: number; calls: number; tokens: number }>;
  budgets:     BudgetStatus[];
  blocking:    BlockingCap[];
}

export interface SpendAgg {
  key:           string;
  calls:         number;
  errors:        number;
  tokensIn:      number;
  tokensOut:     number;
  tokensCached:  number;
  costUsd:       number;
  estimatedUsd:  number;
  unpricedCalls: number;
  shadowUsd:     number;
  avgLatencyMs:  number | null;
  noUsageCalls:  number | null;
}

export interface SpendRow extends SpendAgg { label: string; pct: number; estimated: boolean; runId?: string }

export interface SpendFilters {
  agent?:    string;
  feature?:  string;
  provider?: SpendProvider;
  shadow?:   boolean;
}

export interface SpendQuery extends SpendFilters {
  range?:   SpendRange;
  from?:    string;
  to?:      string;
  groupBy:  SpendGroupBy;
  stackBy?: SpendStackBy;
}

export interface SpendBreakdown {
  from: string; to: string; days: number;
  groupBy: SpendGroupBy; stackBy: SpendStackBy;
  source: 'rollup' | 'raw';
  partial: boolean;
  retentionDays: number;
  truncated: boolean;
  totals: SpendAgg;
  rows: SpendRow[];
  chart: { series: string[]; days: Array<{ day: string; total: number; values: Record<string, number> }> };
}

export interface PriceRow {
  provider: SpendProvider; model: string; inPerM: number; outPerM: number;
  cachedReadPerM: number | null; cachedWritePerM: number | null; perRequestUsd: number | null;
  effectiveFrom: string; note: string | null; updatedAt: string | null; current: boolean; scheduled: boolean;
}

export interface PricesResponse {
  rows: PriceRow[];
  unpriced: Array<{ provider: string; model: string; calls: number; lastAt: string }>;
  repriceMaxDays: number;
}

export interface PriceInput {
  provider: SpendProvider; model: string; inPerM: number; outPerM: number;
  cachedReadPerM?: number | null; cachedWritePerM?: number | null; perRequestUsd?: number | null;
  effectiveFrom?: string; note?: string | null;
}

export interface AgentCapStatus { agentId: string; handle: string; capUsd: number; spentUsd: number; pct: number; state: BudgetState }

export interface BudgetsResponse { today: string; rows: BudgetStatus[]; agentCaps: AgentCapStatus[]; blocking: BlockingCap[] }

export interface BudgetInput {
  id?: number; scopeKind: BudgetScopeKind; scopeKey: string; dailyUsd: number | null; monthlyUsd?: number | null;
  alertPct?: number; enforce?: boolean;
}

export interface RepriceResult { ok: true; days: number; scanned: number; repriced: number; stillUnpriced: number; deltaUsd: number; rollupDays: number }

export interface AgentsOverview {
  generatedAt: string;
  agents: { total: number; byMode: { off: number; shadow: number; approve: number; live: number }; paused: number };
  runs: { today: number; d7: number; ok7d: number; finished7d: number; disabled7d: number; errors7d: number; budgetExceeded7d: number; successRate7d: number | null };
  posts: { today: { published: number; shadowed: number }; d7: { published: number; shadowed: number }; awaitingApproval: number };
  directives: { open: number; awaitingOwner: number; applied30d: number; worked30d: number };
}

const KEY = ['spend'] as const;

/** The query string of a breakdown/export request (empty values dropped). */
export function spendParams(q: Omit<Partial<SpendQuery>, 'groupBy'> & { groupBy?: SpendGroupBy | 'raw' }): string {
  const p = new URLSearchParams();
  if (q.from && q.to) { p.set('from', q.from); p.set('to', q.to); } else if (q.range) p.set('range', q.range);
  if (q.groupBy) p.set('groupBy', q.groupBy);
  if (q.stackBy) p.set('stackBy', q.stackBy);
  if (q.agent) p.set('agent', q.agent);
  if (q.feature) p.set('feature', q.feature);
  if (q.provider) p.set('provider', q.provider);
  if (q.shadow) p.set('shadow', '1');
  return p.toString();
}

export function useSpendSummary(range: SpendRange = '7d') {
  return useQuery({
    queryKey: [...KEY, 'summary', range],
    queryFn:  () => api<SpendSummary>(`/api/spend/summary?range=${range}`),
    refetchInterval: 60_000,
  });
}

export function useAgentsOverview() {
  return useQuery({
    queryKey: ['overview', 'agents'],
    queryFn:  () => api<AgentsOverview>('/api/overview/agents'),
    refetchInterval: 60_000,
  });
}

export function useSpendBreakdown(q: SpendQuery) {
  const qs = spendParams(q);
  return useQuery({
    queryKey: [...KEY, 'breakdown', qs],
    queryFn:  () => api<SpendBreakdown>(`/api/spend/breakdown?${qs}`),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
}

export function useSpendLedger() {
  return useQuery({ queryKey: [...KEY, 'ledger'], queryFn: () => api<{ callsBeforeLedger: number; retentionDays: number }>('/api/spend/ledger'), staleTime: 10 * 60_000 });
}

export function usePrices() {
  return useQuery({ queryKey: [...KEY, 'prices'], queryFn: () => api<PricesResponse>('/api/spend/prices') });
}

export function useBudgets() {
  return useQuery({ queryKey: [...KEY, 'budgets'], queryFn: () => api<BudgetsResponse>('/api/spend/budgets'), refetchInterval: 60_000 });
}

export function useSavePrice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: PriceInput) => api<{ ok: true; created: boolean }>('/api/spend/prices', { method: 'PUT', body: JSON.stringify(p) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...KEY, 'prices'] }),
  });
}

export function useDeletePrice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: Pick<PriceRow, 'provider' | 'model' | 'effectiveFrom'>) =>
      api<{ ok: true }>(`/api/spend/prices?${new URLSearchParams({ provider: p.provider, model: p.model, effectiveFrom: p.effectiveFrom })}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...KEY, 'prices'] }),
  });
}

export function useReprice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (days: number) => api<RepriceResult>('/api/spend/reprice', { method: 'POST', body: JSON.stringify({ days }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useSaveBudget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: BudgetInput) => api<{ ok: true; id: number; created: boolean }>('/api/spend/budgets', { method: 'PUT', body: JSON.stringify(b) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useDeleteBudget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api<{ ok: true }>(`/api/spend/budgets/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

/** Download the CSV with the session cookie and save it under the server's file name. */
export async function downloadSpendCsv(q: Omit<Partial<SpendQuery>, 'groupBy'> & { groupBy: SpendGroupBy | 'raw' }): Promise<void> {
  const res = await fetch(`${API_BASE}/api/spend/export.csv?${spendParams(q)}`, { credentials: 'include' });
  if (res.status === 401) throw await unauthorized(res);
  if (!res.ok) throw new ApiError(res.status, await res.text());
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'ai-spend.csv';
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
