import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './client';
import { toast } from '../components/ui/Toast';
import type { EditorMemoryEntry, EditorMode, EditorRunStatus, PendingAction } from './types';

export type { PendingAction } from './types';

// Agent registry (spec 017 FR-010/FR-011). Responses are camelCase, PATCH/PUT
// bodies snake_case. Handles are [a-z0-9_] but are still URL-encoded.

export type AgentKind = 'manager' | 'builder' | 'orchestrator' | 'planner' | 'ideator' | 'idea_reviewer' | 'executor' | 'reviewer';
export type AgentScope = 'system' | 'network' | 'resource';
export type AgentMode = EditorMode;
export type ReasoningEffort = 'low' | 'medium' | 'high';

export interface AgentSchedule { times?: string[] }

export interface Agent {
  id:              string;
  kind:            AgentKind;
  scope:           AgentScope;
  scopeId:         string | null;
  parentId:        string | null;
  name:            string;
  handle:          string;
  emoji:           string | null;
  description:     string | null;
  mode:            AgentMode;
  status:          'active' | 'paused';
  pausedUntil:     string | null;
  model:           string | null;
  reasoningEffort: ReasoningEffort | null;
  schedule:        AgentSchedule;
  dailyBudgetUsd:  number | null;
  shadowUntil:     string | null;
  createdBy:       string;
  createdAt:       string;
  updatedAt:       string;
}

export interface AgentActivity {
  spentTodayUsd: number;
  lastRunAt:     string | null;
  lastStatus:    EditorRunStatus | null;
  runsToday:     number;
}

export interface AgentNode extends Agent {
  activity: AgentActivity;
  paused:   boolean;
  children: AgentNode[];
}

export interface AgentDetail {
  agent:      Agent & { paused: boolean; activity: AgentActivity | null };
  parent:     { id: string; handle: string; name: string; emoji: string | null } | null;
  children:   Array<Agent & { activity: AgentActivity | null }>;
  channelKey: string | null;
}

export interface AgentPatch {
  name?:             string;
  handle?:           string;
  emoji?:            string | null;
  description?:      string | null;
  mode?:             AgentMode;
  status?:           'active' | 'paused';
  paused_until?:     string | null;
  model?:            string | null;
  reasoning_effort?: ReasoningEffort | null;
  schedule?:         { times: string[] };
  daily_budget_usd?: number | null;
}

export interface AgentRun {
  id:               string;
  role:             string;
  channelKey:       string | null;
  slotId:           string | null;
  model:            string;
  status:           EditorRunStatus;
  steps:            number;
  promptTokens:     number;
  completionTokens: number;
  costUsd:          number;
  error:            string | null;
  startedAt:        string;
  finishedAt:       string | null;
  agentId:          string | null;
}

export type AgentMemoryEntry = Omit<EditorMemoryEntry, 'active'>;

export const SKILL_ROLES = ['planner', 'executor', 'reviewer', 'checker', 'composer', 'orchestrator', 'idea_reviewer', 'manager', 'builder'] as const;
export type SkillRole = typeof SKILL_ROLES[number];
export const SKILL_MAX_BODY = 12_000;
export const SKILL_MAX_INLINE_BODY = 4_000;

export interface Skill {
  id:             string;
  name:           string;
  scope:          'builtin' | 'global' | 'agent';
  agentId:        string | null;
  description:    string;
  appliesTo:      string[];
  body:           string;
  locked:         boolean;
  safety:         boolean;
  currentVersion: number;
  baseVersion:    number | null;
  createdBy:      'repo' | 'owner' | 'agent';
  updatedAt:      string;
}

export type SkillOrigin = 'builtin' | 'global' | 'override' | 'own' | 'inherited';

export interface AgentSkillEntry {
  skill:       Skill;
  origin:      SkillOrigin;
  enabled:     boolean;
  inline:      boolean;
  baseChanged: boolean;
  pending:     boolean;
}

export interface SkillLintIssue { code: string; message: string; hard?: boolean }

export interface SkillVersion {
  id:            string;
  skillId:       string;
  version:       number;
  body:          string;
  description:   string;
  appliesTo:     string[];
  author:        'repo' | 'owner' | 'agent';
  authorAgentId: string | null;
  reason:        string | null;
  kpiBaseline:   unknown;
  reviewAt:      string | null;
  outcome:       'pending' | 'kept' | 'rolled_back' | 'superseded' | null;
  outcomeDetail: unknown;
  createdAt:     string;
}

export interface InboxItem {
  id:        number;
  agentId:   string | null;
  kind:      string;
  title:     string;
  body:      string | null;
  refType:   string | null;
  refId:     string | null;
  severity:  'info' | 'action' | 'critical';
  readAt:    string | null;
  createdAt: string;
}

/** The parsed JSON error body of a failed request ({error, details?, issues?}), or null. */
export function errorBody(err: unknown): { error?: string; details?: unknown; issues?: Array<{ path?: string; message: string }> } | null {
  if (!(err instanceof ApiError)) return null;
  try {
    const b = JSON.parse(err.message);
    return b && typeof b === 'object' ? b : null;
  } catch { return null; }
}

const enc = encodeURIComponent;
const KEY = ['agents'] as const;

export function useAgentTree() {
  return useQuery({
    queryKey: [...KEY, 'tree'],
    queryFn:  () => api<{ agents: AgentNode[] }>('/api/agents'),
    refetchInterval: 30_000,
  });
}

export function useAgent(handle: string) {
  return useQuery({
    queryKey: [...KEY, 'agent', handle],
    queryFn:  () => api<AgentDetail>(`/api/agents/${enc(handle)}`),
    refetchInterval: 30_000,
  });
}

/** Profile / mode / pause changes. Errors are shown by the caller (inline or toast). */
export function usePatchAgent(handle: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (patch: AgentPatch) =>
      api<{ agent: Agent }>(`/api/agents/${enc(handle)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useRunAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (handle: string) => api<{ started: boolean; what: string }>(`/api/agents/${enc(handle)}/run`, { method: 'POST' }),
    onSuccess: (r, handle) => {
      if (r.started) toast.success(`@${handle}: ${r.what}`);
      else toast.error(`@${handle} did not start: ${r.what}`);
      qc.invalidateQueries({ queryKey: KEY });
      setTimeout(() => qc.invalidateQueries({ queryKey: KEY }), 15_000);
    },
  });
}

export function useAgentRuns(handle: string, limit = 50) {
  return useInfiniteQuery({
    queryKey: [...KEY, 'runs', handle, limit],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: String(limit) });
      if (pageParam) qs.set('before', pageParam);
      return api<{ runs: AgentRun[] }>(`/api/agents/${enc(handle)}/runs?${qs.toString()}`);
    },
    getNextPageParam: (last) => (last.runs.length >= limit ? last.runs[last.runs.length - 1].startedAt : undefined),
  });
}

export function useAgentMemory(handle: string) {
  return useQuery({
    queryKey: [...KEY, 'memory', handle],
    queryFn:  () => api<{ channelKey: string | null; memory: AgentMemoryEntry[] }>(`/api/agents/${enc(handle)}/memory`),
  });
}

export function useAgentSkills(handle: string) {
  return useQuery({
    queryKey: [...KEY, 'skills', handle],
    queryFn:  () => api<{ skills: AgentSkillEntry[] }>(`/api/agents/${enc(handle)}/skills`),
  });
}

export interface PutSkillBody { description: string; applies_to: string[]; body: string; force?: boolean }
export interface PutSkillResult { ok: boolean; skill: Skill; version: number; lint: { ok: boolean; errors: SkillLintIssue[]; warnings: SkillLintIssue[] } }

/** Create/override/edit a skill. Lint and safety errors are handled inline by the editor. */
export function usePutSkill(handle: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (v: { name: string } & PutSkillBody) => {
      const { name, ...body } = v;
      return api<PutSkillResult>(`/api/agents/${enc(handle)}/skills/${enc(name)}`, { method: 'PUT', body: JSON.stringify(body) });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function usePatchSkill(handle: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { name: string; enabled?: boolean; inline?: boolean; locked?: boolean }) => {
      const { name, ...body } = v;
      return api<{ skills: AgentSkillEntry[] }>(`/api/agents/${enc(handle)}/skills/${enc(name)}`, { method: 'PATCH', body: JSON.stringify(body) });
    },
    onSuccess: (r) => {
      qc.setQueryData([...KEY, 'skills', handle], r);
      qc.invalidateQueries({ queryKey: [...KEY, 'skills'] });
    },
  });
}

export function useDeleteSkill(handle: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api<{ ok: true }>(`/api/agents/${enc(handle)}/skills/${enc(name)}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...KEY, 'skills'] }),
  });
}

export function useSkillVersions(id: string | null) {
  return useQuery({
    queryKey: [...KEY, 'skill-versions', id],
    queryFn:  () => api<{ skill: Skill; versions: SkillVersion[] }>(`/api/skills/${enc(id!)}/versions`),
    enabled:  !!id,
  });
}

export function useRollbackSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; version: number }) =>
      api<unknown>(`/api/skills/${enc(v.id)}/rollback`, { method: 'POST', body: JSON.stringify({ version: v.version }) }),
    onSuccess: (_r, v) => {
      toast.success(`Rolled back to v${v.version}`);
      qc.invalidateQueries({ queryKey: [...KEY, 'skills'] });
      qc.invalidateQueries({ queryKey: [...KEY, 'skill-versions', v.id] });
    },
  });
}

export function useAgentInbox(unreadOnly = false) {
  return useQuery({
    queryKey: [...KEY, 'inbox', unreadOnly],
    queryFn:  () => api<{ items: InboxItem[] }>(`/api/agents/inbox${unreadOnly ? '?unread=true' : ''}`),
    refetchInterval: 60_000,
  });
}

export function useMarkInboxRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: number[] | 'all') =>
      api<{ marked: number }>('/api/agents/inbox/read', { method: 'POST', body: JSON.stringify({ ids }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...KEY, 'inbox'] }),
  });
}

// ── spec 018: mentionable handles, confirmation cards, resource profile ──

/** A top-level agent that can be @mentioned in the chat. */
export interface AgentHandle {
  handle:  string;
  name:    string;
  emoji:   string | null;
  kind:    AgentKind;
  scope:   AgentScope;
  scopeId: string | null;
  mode:    AgentMode;
}

export function useAgentHandles(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [...KEY, 'handles'],
    queryFn:  () => api<{ agents: AgentHandle[] }>('/api/agents/handles'),
    staleTime: 60_000,
    // The ⌘K palette loads handles lazily, only once it is open (spec 027 FR-012).
    enabled: opts.enabled ?? true,
  });
}

/**
 * [Apply] / [Discard] on a confirmation card. A failed apply is not an HTTP
 * error (the card comes back `failed` with the reason); 409 means the card was
 * already decided elsewhere — the caller shows it and the chat is refreshed.
 */
export function useDecideAction() {
  const qc = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (v: { id: string; decision: 'apply' | 'discard' }) =>
      api<{ action: PendingAction }>(`/api/agents/actions/${enc(v.id)}/${v.decision}`, { method: 'POST' }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ['editor-chat', 'chat'] });
    },
  });
}

export const KPI_GOALS = ['growth', 'engagement', 'transitions', 'revenue'] as const;
export type KpiGoal = typeof KPI_GOALS[number];

/** What an agent's resource is about (spec 018 FR-006). Mirrors ResourceProfileSchema on the server. */
export interface ResourceProfile {
  topic:           string;
  audience:        { who: string; age?: string; region?: string };
  language:        string;
  goals:           KpiGoal[];
  tone?:           string;
  taboo:           string[];
  sources:         string[];
  frequency_hint?: string;
  ads_allowed:     { allowed: boolean; categories: string[] };
  examples:        string[];
  notes?:          string;
  /** Spec 024: IANA zone (absent = Europe/Kyiv) and quiet hours (absent = 23→8); ignored for Telegram (the card rules). */
  timezone?:       string;
  quiet_hours?:    { start: number; end: number };
  /** Spec 024 FR-013: edited in the Formatting section; the profile form keeps them (the server too). */
  format_prefs?:   FormatPrefs;
  format_locks?:   FormatPrefField[];
}

// ── spec 024 FR-013: agent-owned formatting per resource ──────────────────────

export const FORMAT_PREF_FIELDS = [
  'tone', 'length', 'emoji', 'hashtags', 'mentions', 'cta', 'links', 'line_breaks', 'signature', 'preferred_formats', 'media', 'notes',
  'rich',
] as const;
export type FormatPrefField = typeof FORMAT_PREF_FIELDS[number];

/** Mirrors FormatPrefsSchema on the server: every field optional — empty means "the agent's judgement". */
export interface FormatPrefs {
  tone?:              string;
  length?:            { target: number; max: number };
  emoji?:             'none' | 'light' | 'rich';
  hashtags?:          { count: number; style?: string; fixed: string[] };
  mentions?:          string;
  cta?:               string;
  links?:             'inline' | 'bio' | 'first_comment' | 'button';
  line_breaks?:       string;
  signature?:         string;
  preferred_formats?: string[];
  media?:             { aspect?: string; cover_style?: string };
  notes?:             string;
  /** Spec 033: Telegram rich messages (headings, tables, numbered lists, formulas). */
  rich?:              'auto' | 'prefer' | 'never';
}

export interface FormatResource {
  ref:          string;
  platform:     string;
  title:        string | null;
  formatPrefs:  FormatPrefs;
  locks:        FormatPrefField[];
  updatedAt:    string | null;
  /** Agent changes on the resource's local day (at most `changesPerDay`). */
  changesToday: number;
}

export interface FormatVersion {
  id:          number;
  resourceRef: string;
  version:     number;
  kind:        'profile' | 'format';
  changedBy:   'owner' | 'builder' | 'agent' | 'system';
  agentId:     string | null;
  agentHandle: string | null;
  reason:      string | null;
  diff:        Record<string, { from: unknown; to: unknown }>;
  createdAt:   string;
}

export interface FormattingResponse {
  changesPerDay: number;
  resources:     FormatResource[];
  history:       FormatVersion[];
}

export function useResourceFormatting(handle: string, enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'formatting', handle],
    queryFn:  () => api<FormattingResponse>(`/api/agents/${enc(handle)}/formatting`),
    enabled,
  });
}

/** The owner's edit of one resource: its whole format_prefs and the locked fields. Issues are shown inline. */
export function usePutResourceFormatting(handle: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (b: { ref: string; format_prefs: FormatPrefs; format_locks: FormatPrefField[] }) =>
      api<FormattingResponse>(`/api/agents/${enc(handle)}/formatting/${enc(b.ref)}`, {
        method: 'PUT', body: JSON.stringify({ format_prefs: b.format_prefs, format_locks: b.format_locks }),
      }),
    onSuccess: (r) => {
      qc.setQueryData([...KEY, 'formatting', handle], r);
      qc.invalidateQueries({ queryKey: [...KEY, 'profile'] });
    },
  });
}

export type HealthState = 'ok' | 'no_access' | 'token_expiring' | 'token_invalid' | 'rate_limited' | 'unknown';
export interface ResourceHealth { state: HealthState; detail?: string | null; checkedAt: string }

export interface ResourceProfileResponse {
  ref:       string | null;
  profile:   ResourceProfile | null;
  health:    ResourceHealth | null;
  updatedAt: string | null;
}

export function useResourceProfile(handle: string, enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'profile', handle],
    queryFn:  () => api<ResourceProfileResponse>(`/api/agents/${enc(handle)}/profile`),
    enabled,
  });
}

/** Save the profile. Validation issues (400 invalid_body) are shown inline by the form. */
export function usePutResourceProfile(handle: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (p: ResourceProfile) =>
      api<ResourceProfileResponse>(`/api/agents/${enc(handle)}/profile`, { method: 'PUT', body: JSON.stringify(p) }),
    onSuccess: (r) => {
      qc.setQueryData([...KEY, 'profile', handle], r);
      qc.invalidateQueries({ queryKey: [...KEY, 'profile'] });
    },
  });
}
