import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

// Steering (spec 045): a reference channel that is not ours, read through the tracking account (its last 20 posts),
// becomes lowest-priority rules for one of our channels. GET /api/steering?target=, GET /:id, GET /estimate,
// GET /active?target=, POST / {target, source}, POST /:id/activate|pause|resume|discard|reanalyze,
// PATCH /:id/rules/:ruleId {enabled?, text?}.

export const STEERING_RULE_KINDS = ['structure', 'hook', 'length', 'formatting', 'cta', 'series', 'topic', 'mix'] as const;
export type SteeringRuleKind = typeof STEERING_RULE_KINDS[number];
export type SteeringStatus =
  | 'queued' | 'collecting' | 'analyzing' | 'ready' | 'active' | 'paused'
  | 'discarded' | 'superseded' | 'failed' | 'no_access' | 'too_few_posts';

export interface SteeringRule {
  id:       string;
  kind:     SteeringRuleKind;
  text:     string;
  evidence: { post_ids: string[]; note: string };
  /** What of the channel's own rules it contradicts: shown, never given to the agent. */
  conflict: { with: string; note: string } | null;
  enabled:  boolean;
  edited?:  boolean;
}

export interface SteeringSetBrief {
  id:          string;
  targetRef:   string;
  channelKey:  string | null;
  sourceRef:   string;
  sourceTitle: string | null;
  status:      SteeringStatus;
  reason:      string | null;
  retryAt:     string | null;
  summary:     string | null;
  rules:       SteeringRule[];
  runId:       string | null;
  costUsd:     number;
  createdBy:   string;
  createdAt:   string;
  updatedAt:   string;
  activatedAt: string | null;
  postCount:   number;
  rulesTotal:  number;
  rulesActive: number;
  conflicts:   number;
}

export interface SteeringPostRef {
  key:       string;
  msgId:     number;
  postedAt:  string;
  mediaType: string | null;
  views:     number | null;
  reactions: number | null;
  forwards:  number | null;
  comments:  number | null;
  firstLine: string;
  link:      string | null;
}

export interface SteeringSetView {
  set:   Omit<SteeringSetBrief, 'postCount' | 'rulesTotal' | 'rulesActive' | 'conflicts'> & { metrics: unknown };
  posts: SteeringPostRef[];
}

const KEY = ['steering'] as const;
const busy = (s: SteeringStatus | undefined) => s === 'queued' || s === 'collecting' || s === 'analyzing';

export function useSteeringSets(target?: string | null) {
  return useQuery({
    queryKey: [...KEY, 'list', target ?? null],
    queryFn:  () => api<{ sets: SteeringSetBrief[] }>(`/api/steering${target ? `?target=${encodeURIComponent(target)}` : ''}`),
    // Polls while an analysis is queued or running.
    refetchInterval: (q) => (q.state.data?.sets.some((s) => busy(s.status)) ? 4_000 : false),
  });
}

export function useSteeringSet(id: string | null | undefined) {
  return useQuery({
    queryKey: [...KEY, 'set', id],
    queryFn:  () => api<SteeringSetView>(`/api/steering/${encodeURIComponent(id!)}`),
    enabled:  !!id,
    refetchInterval: (q) => (busy(q.state.data?.set.status) ? 4_000 : false),
  });
}

export function useSteeringEstimate() {
  return useQuery({ queryKey: [...KEY, 'estimate'], queryFn: () => api<{ estimateUsd: number | null }>('/api/steering/estimate') });
}

/** "Steering: N active from @a, @b" on the agent page. */
export function useActiveSteering(targetRef: string | null | undefined) {
  return useQuery({
    queryKey: [...KEY, 'active', targetRef],
    queryFn:  () => api<{ active: number; sources: string[] }>(`/api/steering/active?target=${encodeURIComponent(targetRef!)}`),
    enabled:  !!targetRef && targetRef.startsWith('telegram:@'),
  });
}

function useDone() {
  const qc = useQueryClient();
  // Spec 048: a steering set is also an artifact (its chip and panel read /api/artifacts).
  return () => { void qc.invalidateQueries({ queryKey: KEY }); void qc.invalidateQueries({ queryKey: ['artifacts'] }); };
}

export function useCreateSteering() {
  const done = useDone();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (v: { target: string; source: string }) => api<{ set: SteeringSetBrief }>('/api/steering', { method: 'POST', body: JSON.stringify(v) }),
    onSuccess: done,
  });
}

export type SteeringAction = 'activate' | 'pause' | 'resume' | 'discard' | 'reanalyze';

export function useSteeringAction() {
  const done = useDone();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (v: { id: string; action: SteeringAction }) =>
      api<{ set: SteeringSetBrief }>(`/api/steering/${encodeURIComponent(v.id)}/${v.action}`, { method: 'POST' }),
    onSuccess: done,
  });
}

export function usePatchSteeringRule() {
  const done = useDone();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (v: { id: string; ruleId: string; enabled?: boolean; text?: string }) =>
      api<{ set: SteeringSetBrief }>(`/api/steering/${encodeURIComponent(v.id)}/rules/${encodeURIComponent(v.ruleId)}`, {
        method: 'PATCH', body: JSON.stringify({ ...(v.enabled !== undefined ? { enabled: v.enabled } : {}), ...(v.text !== undefined ? { text: v.text } : {}) }),
      }),
    onSuccess: done,
  });
}
