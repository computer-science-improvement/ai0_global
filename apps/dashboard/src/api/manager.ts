import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

// Spec 021: the MANAGER's directives to orchestrators, its review timeline and
// the KPI digest it reads. Responses are camelCase at the row level; params,
// evidence, expected and outcomeDetail are the stored snake_case JSON.

export const DIRECTIVE_KINDS = [
  'advice', 'task', 'format_shift', 'frequency', 'repost', 'cross_promo', 'pause_series', 'experiment', 'pause_resource', 'strategy',
] as const;
export type DirectiveKind = typeof DIRECTIVE_KINDS[number];

export const DIRECTIVE_STATUSES = ['awaiting_owner', 'new', 'accepted', 'applied', 'evaluated', 'rejected', 'expired', 'canceled'] as const;
export type DirectiveStatus = typeof DIRECTIVE_STATUSES[number];

export type DirectiveOutcome = 'worked' | 'no_effect' | 'hurt' | 'inconclusive';
export type OwnerDecision = 'approved' | 'declined' | 'timeout_applied' | 'timeout_dropped';

export interface DirectiveExpected {
  metric:         string;
  direction:      'up' | 'down';
  min_change_pct: number;
  resource_ref?:  string;
}

export interface DirectiveOutcomeDetail {
  before?:      { value: number | null };
  after?:       { value: number | null; stale?: boolean; resources?: string[] };
  changePct?:   number | null;
  confounders?: string[];
}

export interface Directive {
  id:            string;
  fromAgentId:   string | null;
  toAgentId:     string;
  from:          string | null;
  to:            string | null;
  kind:          DirectiveKind;
  structural:    boolean;
  body:          string;
  params:        Record<string, unknown> | null;
  rationale:     string | null;
  evidence:      unknown;
  expected:      DirectiveExpected | null;
  reviewAt:      string | null;
  status:        DirectiveStatus;
  resolution:    string | null;
  reasonKind:    string | null;
  ownerDecision: OwnerDecision | null;
  outcome:       DirectiveOutcome | null;
  outcomeDetail: DirectiveOutcomeDetail | null;
  deliveredAt:   string | null;
  appliedAt:     string | null;
  shadow:        boolean;
  createdAt:     string;
  updatedAt:     string;
}

export type ReviewVerdict = 'continue' | 'directives' | 'skipped';

export interface ManagerReview {
  id:           string;
  verdict:      ReviewVerdict;
  summary:      string;
  directiveIds: string[];
  createdAt:    string;
}

export const KPI_NAMES = ['views_per_post', 'engagement_rate', 'posts', 'followers_growth', 'transitions', 'revenue'] as const;
export type KpiName = typeof KPI_NAMES[number];

/** One metric: 7-day value, 28-day baseline, delta %, z-score, flags. */
export interface KpiValue {
  v:        number | null;
  base:     number | null;
  d:        number | null;
  z:        number | null;
  stale?:   boolean;
  anomaly?: boolean;
}

export interface DigestResource {
  ref:       string;
  title:     string | null;
  agent:     string | null;
  health:    string | null;
  kpis:      Partial<Record<KpiName, KpiValue>>;
  anomalies: string[];
}

export interface KpiDigest {
  generatedAt: string;
  today:       string;
  resources:   DigestResource[];
  agents:      Array<{ handle: string; mode: string; paused: boolean; slotsToday: Record<string, number>; spentTodayUsd: number }>;
  budget:      { spentTodayUsd: number; capUsd: number };
  directives:  {
    open:     Array<{ id: string; to: string; kind: string; status: string; body: string; createdAt: string }>;
    outcomes: Array<{ to: string; kind: string; outcome: string | null; body: string; detail: unknown }>;
  };
  hash:        string;
}

const enc = encodeURIComponent;
const KEY = ['manager'] as const;

/** Directives, optionally by status and addressee (an orchestrator handle). */
export function useDirectives(opts: { status?: readonly DirectiveStatus[]; agent?: string } = {}) {
  const qs = new URLSearchParams();
  if (opts.status?.length) qs.set('status', opts.status.join(','));
  if (opts.agent) qs.set('agent', opts.agent);
  const s = qs.toString();
  return useQuery({
    queryKey: [...KEY, 'directives', s],
    queryFn:  () => api<{ directives: Directive[] }>(`/api/directives${s ? `?${s}` : ''}`),
    retry:    false,
    refetchInterval: 60_000,
  });
}

/** Owner decision on an awaiting_owner directive. 409 not_awaiting_owner is shown by the caller. */
export function useDecideDirective() {
  const qc = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (v: { id: string; decision: 'approve' | 'decline' }) =>
      api<{ directive: Directive }>(`/api/directives/${enc(v.id)}/${v.decision}`, { method: 'POST' }),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useManagerReviews(limit = 50) {
  return useQuery({
    queryKey: [...KEY, 'reviews', limit],
    queryFn:  () => api<{ reviews: ManagerReview[] }>(`/api/manager/reviews?limit=${limit}`),
    retry:    false,
    refetchInterval: 60_000,
  });
}

/** Start a manager run now. 409 manager_off when @manager's mode is off — the caller explains. */
export function useRunManager() {
  const qc = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: () => api<{ started: boolean }>('/api/manager/run', { method: 'POST' }),
    onSuccess: () => {
      // The run is in the background; its review and directives land in a while.
      setTimeout(() => qc.invalidateQueries({ queryKey: KEY }), 15_000);
      setTimeout(() => qc.invalidateQueries({ queryKey: KEY }), 45_000);
    },
  });
}

export function useKpiDigest() {
  return useQuery({
    queryKey: [...KEY, 'digest'],
    queryFn:  () => api<KpiDigest>('/api/kpi/digest'),
    retry:    false,
    refetchInterval: 5 * 60_000,
  });
}
