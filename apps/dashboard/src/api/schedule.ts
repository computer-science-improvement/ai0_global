import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { Platform } from './network';

// Spec 023 FR-007: the agent's Schedule tab. Every route accepts a role child's
// handle (the server resolves the orchestrator). Times are local to each
// resource (its IANA zone is in `resources[].timezone`); rules are snake_case
// like the server's input.

export type RuleKind = 'pin' | 'blackout' | 'frequency';

export type SeriesSource =
  | { kind: 'library'; table: string; category?: string; query?: string; today_only?: boolean }
  | { kind: 'api'; source: string; params?: Record<string, unknown> }
  | { kind: 'feed'; ref: string }
  | { kind: 'network_highlights'; scope: 'channel' | 'network' }
  | { kind: 'free' };

export interface ScheduleRule {
  id:           string;
  resource_ref: string;
  kind:         RuleKind;
  /** 0 = Sunday; null = every day. */
  days:         number[] | null;
  at_local:     string | null;
  until_local:  string | null;
  window_min:   number;
  format:       string | null;
  series_name:  string | null;
  brief:        string | null;
  source:       SeriesSource | null;
  per_day_min:  number | null;
  per_day_max:  number | null;
  valid_from:   string | null;
  valid_until:  string | null;
  active:       boolean;
  created_by:   'owner' | 'chat';
  note:         string | null;
  created_at:   string;
  updated_at:   string;
}

export type RuleInput = Partial<Omit<ScheduleRule, 'id' | 'created_by' | 'created_at' | 'updated_at'>> & { resource_ref?: string; kind?: RuleKind };

export interface ScheduleSeries {
  name:          string;
  /** daily@HH:MM[,…] | weekly:mon[,thu]@HH:MM[,…] in the resource's zone. */
  cadence:       string;
  resource_ref:  string;
  format:        string;
  brief:         string;
  active:        boolean;
  source:        SeriesSource | null;
  source_mode:   'suggested' | 'required';
  origin:        'agent' | 'owner' | 'migration';
  locked:        boolean;
  migrated_from: string | null;
}

export type ScheduleItem =
  | { kind: 'series'; resourceRef: string; date: string; time: string; at: string; name: string; format: string; locked: boolean; origin: string }
  | { kind: 'pin'; ruleId: string; resourceRef: string; date: string; time: string; at: string; format: string | null; seriesName: string | null; brief: string | null }
  | { kind: 'blackout'; ruleId: string; resourceRef: string; date: string; time: string; until: string }
  | { kind: 'frequency'; ruleId: string; resourceRef: string; date: string; min: number | null; max: number | null };

export interface ScheduleSlot {
  id:             string;
  resourceRef:    string;
  at:             string;
  /** The resource-local date and time. */
  date:           string;
  time:           string;
  kind:           'content' | 'reserved';
  status:         string;
  format:         string;
  topic:          string;
  seriesName:     string | null;
  scheduleRuleId: string | null;
  promo:          boolean;
}

export interface ScheduleResource {
  ref:        string;
  platform:   Platform;
  timezone:   string;
  quietHours: { start: number; end: number };
  formats:    string[];
  perDay:     { min: number; max: number } | null;
}

export interface ScheduleResponse {
  agent:           { id: string; handle: string };
  anchor:          string;
  mode:            string;
  playbookVersion: number | null;
  now:             string;
  from:            string;
  to:              string;
  days:            string[];
  resources:       ScheduleResource[];
  series:          ScheduleSeries[];
  rules:           ScheduleRule[];
  items:           ScheduleItem[];
  slots:           ScheduleSlot[];
  sourceOptions:   { tables: string[]; feeds: string[]; apis: string[] };
}

export interface RuleResult { rule: ScheduleRule; warnings: string[] }

export type SeriesBody = Partial<Omit<ScheduleSeries, 'name' | 'origin' | 'locked' | 'migrated_from'>>;

const enc = encodeURIComponent;
const KEY = ['schedule'] as const;

export function useSchedule(handle: string, from?: string | null) {
  return useQuery({
    queryKey: [...KEY, handle, from ?? 'today'],
    queryFn:  () => api<ScheduleResponse>(`/api/agents/${enc(handle)}/schedule${from ? `?from=${enc(from)}` : ''}`),
    retry:    false,
    refetchInterval: 60_000,
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: KEY }), qc.invalidateQueries({ queryKey: ['network'] })]);
}

export function useAddRule(handle: string) {
  const done = useInvalidate();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (rule: RuleInput) => api<RuleResult>(`/api/agents/${enc(handle)}/schedule-rules`, { method: 'POST', body: JSON.stringify(rule) }),
    onSuccess: done,
  });
}

/** Edit a rule, or disable / enable it with `{ active }`. */
export function usePatchRule(handle: string) {
  const done = useInvalidate();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (v: { id: string; patch: RuleInput & { active?: boolean } }) =>
      api<RuleResult>(`/api/agents/${enc(handle)}/schedule-rules/${enc(v.id)}`, { method: 'PATCH', body: JSON.stringify(v.patch) }),
    onSuccess: done,
  });
}

/** Owner add / edit of a series: a new owner playbook version, the series locked. */
export function usePutSeries(handle: string) {
  const done = useInvalidate();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (v: { name: string; body: SeriesBody }) =>
      api<{ ok: true; version: number; diff: string }>(`/api/agents/${enc(handle)}/series/${enc(v.name)}`, { method: 'PUT', body: JSON.stringify(v.body) }),
    onSuccess: done,
  });
}

export function useUnlockSeries(handle: string) {
  const done = useInvalidate();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (name: string) => api<{ ok: true; version: number }>(`/api/agents/${enc(handle)}/series/${enc(name)}/unlock`, { method: 'POST' }),
    onSuccess: done,
  });
}
