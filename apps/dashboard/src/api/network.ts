import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { useMetaAccounts } from './meta-accounts';
import { useTikTokAccounts } from './tiktok-accounts';

// Spec 020: playbook, idea pool, network day plan and network mode. Every
// /agents/:handle/* endpoint accepts a role child's handle too (the server
// resolves it to its orchestrator). Responses are camelCase at the row level;
// the playbook body itself is the snake_case Playbook document.

export type Platform = 'telegram' | 'instagram' | 'facebook' | 'threads' | 'tiktok' | 'youtube';
/** Spec 024: `independent` (agent decides per resource) | `legacy_duplicate` (auto-duplicate Telegram posts). */
export type NetworkMode = 'single' | 'independent' | 'legacy_duplicate';
export type GroupNetworkMode = Exclude<NetworkMode, 'single'>;

export interface NetworkResource { ref: string; platform: Platform }

export interface AgentNetwork {
  anchor:    string;
  mode:      NetworkMode;
  groupId:   string | null;
  groupName: string | null;
  resources: NetworkResource[];
  /** Spec 024 FR-003: the anchor's posts are still auto-duplicated today. */
  autoDuplicateActive?: boolean;
}

export interface PlaybookPlatform {
  resource_ref:   string;
  /** core | discovery | community | archive | funnel_to:<ref> */
  role:           string;
  formats:        Record<string, number>;
  per_day:        { min: number; max: number };
  best_hours:     number[];
  tone?:          string;
  hashtag_policy: { vocab: string[]; min: number; max: number };
  link_policy?:   string;
  cta?:           string;
}

export interface PlaybookSeries {
  name:         string;
  /** daily@HH:MM | weekly:sun@HH:MM (Kyiv) */
  cadence:      string;
  resource_ref: string;
  format:       string;
  brief:        string;
  active:       boolean;
}

export interface Playbook {
  platforms: PlaybookPlatform[];
  series:    PlaybookSeries[];
  pillars:   Array<{ name: string; share: number }>;
  rules:     string[];
}

export type PlaybookStatus = 'draft' | 'pending_owner' | 'active' | 'superseded' | 'rejected';

export interface PlaybookRow {
  id:        string;
  agentId:   string;
  version:   number;
  status:    PlaybookStatus;
  brief:     string | null;
  body:      Playbook;
  review:    { verdict: 'ok' | 'concerns'; comments: string[] } | null;
  rationale: string | null;
  createdBy: 'orchestrator' | 'owner';
  createdAt: string;
  decidedAt: string | null;
}

export interface PlaybookResponse { active: PlaybookRow | null; pending: PlaybookRow | null; history: PlaybookRow[] }

export const IDEA_STATUSES = ['new', 'accepted', 'needs_revision', 'rejected', 'planned', 'used', 'expired'] as const;
export type IdeaStatus = typeof IDEA_STATUSES[number];
export type IdeaOrigin = 'orchestrator' | 'series' | 'directive' | 'owner' | 'trend';

export interface IdeaVariant { resource_ref: string; format: string; note?: string }
export interface IdeaScores { fit: number; novelty: number; verifiability: number; platform_fit: number; risk: number }
export interface IdeaReview {
  verdict:     string;
  scores?:     Partial<IdeaScores>;
  comment?:    string;
  reason_code?: string | null;
  owner?:      'accepted' | 'rejected';
}

export interface IdeaRow {
  id:        string;
  agentId:   string;
  title:     string;
  angle:     string | null;
  sources:   string[];
  variants:  IdeaVariant[];
  why:       string | null;
  evidence:  unknown;
  origin:    IdeaOrigin;
  originRef: string | null;
  expiresAt: string;
  status:    IdeaStatus;
  revisions: number;
  review:    IdeaReview | null;
  createdAt: string;
  updatedAt: string;
}

export type PlanSlotStatus = 'planned' | 'running' | 'published' | 'shadowed' | 'skipped' | 'failed' | 'awaiting_approval' | 'approved' | 'expired';

export interface PlanSlot {
  id:          string;
  at:          string;
  kind:        'content' | 'reserved';
  format:      string;
  topic:       string;
  angle:       string | null;
  status:      PlanSlotStatus;
  error:       string | null;
  preview:     string | null;
  resourceRef: string;
  ideaId:      string | null;
  runId:       string | null;
}

export interface NetworkPlan { date: string; anchor: string; rationale: string | null; slots: PlanSlot[] }

const enc = encodeURIComponent;
const KEY = ['network'] as const;

/** Parse "instagram:<uuid>" → { platform, id }. Unknown prefixes keep the raw ref as id. */
export function parseRef(ref: string): { platform: Platform | null; id: string } {
  const i = ref.indexOf(':');
  if (i <= 0) return { platform: null, id: ref };
  const p = ref.slice(0, i);
  const known = ['telegram', 'instagram', 'facebook', 'threads', 'tiktok', 'youtube'];
  return known.includes(p) ? { platform: p as Platform, id: ref.slice(i + 1) } : { platform: null, id: ref };
}

export function useAgentNetwork(handle: string) {
  return useQuery({
    queryKey: [...KEY, 'net', handle],
    queryFn:  () => api<AgentNetwork>(`/api/agents/${enc(handle)}/network`),
    retry:    false,
  });
}

export function usePlaybook(handle: string) {
  return useQuery({
    queryKey: [...KEY, 'playbook', handle],
    queryFn:  () => api<PlaybookResponse>(`/api/agents/${enc(handle)}/playbook`),
    retry:    false,
    refetchInterval: 30_000,
  });
}

/** Owner edit (active at once). 400 playbook_invalid / invalid_body is shown inline by the editor. */
export function usePutPlaybook(handle: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (v: { body: Playbook; rationale?: string }) =>
      api<{ playbook: PlaybookRow }>(`/api/agents/${enc(handle)}/playbook`, { method: 'PUT', body: JSON.stringify(v) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useRebuildPlaybook(handle: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (brief: string) =>
      api<{ started: boolean }>(`/api/agents/${enc(handle)}/playbook/rebuild`, { method: 'POST', body: JSON.stringify(brief.trim() ? { brief: brief.trim() } : {}) }),
    onSuccess: () => {
      // The orchestrator works in the background; look again in a while.
      setTimeout(() => qc.invalidateQueries({ queryKey: [...KEY, 'playbook', handle] }), 20_000);
    },
  });
}

export function useDecidePlaybook() {
  const qc = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (v: { id: string; decision: 'approve' | 'reject' }) =>
      api<{ playbook: PlaybookRow }>(`/api/playbooks/${enc(v.id)}/${v.decision}`, { method: 'POST' }),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useIdeas(handle: string, statuses: readonly IdeaStatus[] | null) {
  const qs = statuses?.length ? `?status=${statuses.join(',')}` : '';
  return useQuery({
    queryKey: [...KEY, 'ideas', handle, qs],
    queryFn:  () => api<{ ideas: IdeaRow[] }>(`/api/agents/${enc(handle)}/ideas${qs}`),
    retry:    false,
    refetchInterval: 60_000,
  });
}

export function useDecideIdea() {
  const qc = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (v: { id: string; decision: 'accept' | 'reject' }) =>
      api<{ idea: IdeaRow }>(`/api/ideas/${enc(v.id)}/${v.decision}`, { method: 'POST' }),
    onSettled: () => qc.invalidateQueries({ queryKey: [...KEY, 'ideas'] }),
  });
}

export function useNetworkPlan(handle: string, date: string) {
  return useQuery({
    queryKey: [...KEY, 'plan', handle, date],
    queryFn:  () => api<NetworkPlan>(`/api/agents/${enc(handle)}/plan?date=${enc(date)}`),
    retry:    false,
    refetchInterval: 60_000,
  });
}

export function useSetNetworkMode(handle: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (mode: GroupNetworkMode) =>
      api<{ mode: NetworkMode; group: string }>(`/api/agents/${enc(handle)}/network-mode`, { method: 'POST', body: JSON.stringify({ mode }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...KEY, 'net'] }),
  });
}

export interface ResourceLabel { platform: Platform | null; label: string; title: string }

/**
 * ref → readable label: Telegram keys as-is, Meta/TikTok account uuids
 * resolved to @username / display name via the connection lists (cached),
 * otherwise "platform · 1a2b3c".
 */
export function useResourceLabels(): (ref: string) => ResourceLabel {
  const meta = useMetaAccounts();
  const tiktok = useTikTokAccounts();
  const names = new Map<string, string>();
  for (const a of Array.isArray(meta.data) ? meta.data : []) {
    const n = a.username ? `@${a.username}` : a.display_name;
    if (n) names.set(`${a.platform}:${a.id}`, n);
  }
  for (const a of Array.isArray(tiktok.data) ? tiktok.data : []) {
    const n = a.username ? `@${a.username}` : a.display_name;
    if (n) names.set(`tiktok:${a.id}`, n);
  }
  return (ref: string) => {
    const { platform, id } = parseRef(ref);
    const known = names.get(ref);
    if (known) return { platform, label: known, title: ref };
    if (platform === 'telegram') return { platform, label: id, title: ref };
    return { platform, label: platform ? `${platform} · ${id.slice(0, 6)}` : ref, title: ref };
  };
}
