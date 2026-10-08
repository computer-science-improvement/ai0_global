import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

// Spec 021: the MANAGER's directives to orchestrators, its review timeline and
// the KPI digest it reads. Responses are camelCase at the row level; params,
// evidence, expected and outcomeDetail are the stored snake_case JSON.

export const DIRECTIVE_KINDS = [
  'advice', 'task', 'format_shift', 'frequency', 'repost', 'cross_promo', 'pause_series', 'experiment', 'pause_resource', 'strategy',
] as const;
export type DirectiveKind = typeof DIRECTIVE_KINDS[number];

export const DIRECTIVE_STATUSES = [
  'awaiting_owner', 'contested', 'new', 'accepted', 'applied', 'evaluated', 'rejected', 'declined', 'failed', 'expired', 'canceled',
] as const;
export type DirectiveStatus = typeof DIRECTIVE_STATUSES[number];

export type DirectiveOutcome = 'worked' | 'no_effect' | 'hurt' | 'inconclusive';
export type OwnerDecision = 'approved' | 'declined' | 'timeout_applied' | 'timeout_dropped' | 'upheld' | 'refusal_accepted';

/** Spec 025: a directive must be carried out (or contested); advice may be declined. */
export type DirectiveBinding = 'directive' | 'advice';

/** How the change was observed (spec 025): in plans / publishing, reported by a task, or self-reported advice. */
export type VerificationKind = 'observed' | 'reported' | 'self_reported' | 'unverified';
export type Adherence = 'followed' | 'violated' | 'not_followed';

/** The code check of an orchestrator's contest (FR-006), stored in `verification.contest`. */
export interface ContestCheck {
  reason_kind:   'owner_rule' | 'safety' | 'capability' | 'health';
  verified:      boolean | 'unverified';
  detail:        string;
  rule_ids?:     number[];
  resource_ref?: string;
  checked_at?:   string;
}

export interface DirectiveVerification {
  kind?:      VerificationKind;
  adherence?: Adherence;
  detail?:    unknown;
  reason?:    string;
  contest?:   ContestCheck;
  [k: string]: unknown;
}

/** The executor's change (spec 025 FR-009…FR-015); `op` says which shape it is. */
export interface DirectiveChange {
  op:            'per_day' | 'format_weight' | 'series_active' | 'pause_resource' | 'experiment' | 'playbook_build' | string;
  kind?:         DirectiveKind;
  target?:       'playbook' | 'card' | 'resource' | 'quota' | 'owner';
  resource_ref?: string;
  before?:       unknown;
  after?:        unknown;
  format?:       string | null;
  series?:       string;
  resume_on?:    string;
  resumed_at?:   string;
  days?:         number;
  until?:        string;
  reason?:       string;
  angle?:        string;
  slots?:        number;
  within_days?:  number;
  deadline?:     string;
  brief?:        string;
  playbook_id?:  string;
  version?:      number;
  activated_at?: string;
  structural?:   boolean;
  noop?:         boolean;
}

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
  /** Spec 025 FR-016: why the row was not scored — `not_verified` (inconclusive) or `self_reported` (advice). */
  reason?:      'not_verified' | 'self_reported' | 'owner_override' | string;
  adherence?:   Adherence | null;
  verification?: VerificationKind | null;
}

export interface Directive {
  id:            string;
  fromAgentId:   string | null;
  toAgentId:     string;
  from:          string | null;
  to:            string | null;
  kind:          DirectiveKind;
  binding:       DirectiveBinding;
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
  change:        DirectiveChange | null;
  execAttempts?: number;
  execError:     string | null;
  verification:  DirectiveVerification | null;
  verifiedAt:    string | null;
  contestedAt:   string | null;
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
  /** Spec 025 FR-017: how each orchestrator answered the MANAGER over 30 days. */
  compliance?: ComplianceRow[];
  hash:        string;
}

export interface ComplianceRow {
  agent:           string;
  advice_followed: number;
  advice_declined: number;
  decline_reasons: Array<{ kind: string; reason: string }>;
  contested:       number;
  auto_applied:    number;
}

/** A resource pause made by a pause_resource directive (spec 025 FR-013). */
export interface ResourcePause {
  id:          string | number;
  resourceRef: string;
  agentId:     string | null;
  agentHandle: string | null;
  directiveId: string | null;
  reason:      string;
  startsAt:    string;
  until:       string;
  liftedAt:    string | null;
  liftedBy:    'schedule' | 'owner' | null;
  createdAt:   string;
  active:      boolean;
}

const enc = encodeURIComponent;
const KEY = ['manager'] as const;

/** Directives, optionally by status, addressee (an orchestrator handle), binding and kinds (spec 025 FR-018). */
export function useDirectives(opts: {
  status?: readonly DirectiveStatus[]; agent?: string; binding?: DirectiveBinding; kinds?: readonly DirectiveKind[];
} = {}) {
  const qs = new URLSearchParams();
  if (opts.status?.length) qs.set('status', opts.status.join(','));
  if (opts.agent) qs.set('agent', opts.agent);
  if (opts.binding) qs.set('binding', opts.binding);
  if (opts.kinds?.length) qs.set('kind', opts.kinds.join(','));
  const s = qs.toString();
  return useQuery({
    queryKey: [...KEY, 'directives', s],
    queryFn:  () => api<{ directives: Directive[] }>(`/api/directives${s ? `?${s}` : ''}`),
    retry:    false,
    refetchInterval: 60_000,
    // A filter change keeps the board on screen until the new list lands (never another agent's list).
    placeholderData: (prev, q) => (q && new URLSearchParams(String(q.queryKey[2] ?? '')).get('agent') === (opts.agent ?? null) ? prev : undefined),
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

/**
 * Spec 025 FR-008: the owner decides a contested directive — uphold (the executor runs; 409 not_executable when a
 * health / capability guard refuses it now) or accept the orchestrator's refusal. 409 not_contested on a repeat.
 */
export function useContestDecision() {
  const qc = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (v: { id: string; decision: 'uphold' | 'accept-refusal' }) =>
      api<{ directive: Directive }>(`/api/directives/${enc(v.id)}/${v.decision}`, { method: 'POST' }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: PAUSES_KEY });
    },
  });
}

const PAUSES_KEY = ['resource-pauses'] as const;

/** Resource pauses (spec 025 FR-013); `active` narrows to pauses in force now. */
export function useResourcePauses(opts: { active?: boolean } = {}) {
  const s = opts.active === undefined ? '' : `?active=${opts.active}`;
  return useQuery({
    queryKey: [...PAUSES_KEY, s],
    queryFn:  () => api<{ pauses: ResourcePause[] }>(`/api/resources/pauses${s}`),
    retry:    false,
    refetchInterval: 60_000,
  });
}

/** The owner lifts a pause early. 409 not_paused = it has already ended (the caller explains and refreshes). */
export function useLiftPause() {
  const qc = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (ref: string) => api<{ pause: ResourcePause }>(`/api/resources/${enc(ref)}/pause/lift`, { method: 'POST' }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: PAUSES_KEY });
      qc.invalidateQueries({ queryKey: KEY });
    },
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
