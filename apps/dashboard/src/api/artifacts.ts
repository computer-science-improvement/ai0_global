import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

// Artifacts (spec 048 FR-001): one registry over what shapes an agent — setup proposals, steering sets, owner rules,
// memory, skills, playbooks, profiles and formatting. GET /api/artifacts?type&agent&channel&status&limit,
// GET /api/artifacts/:type/:id, GET /api/artifacts/:type/:id/versions/:v, PATCH /api/artifacts/:type/:id {patch, reason?}.

export const ARTIFACT_TYPES = ['setup', 'steering', 'rules', 'memory', 'skill', 'playbook', 'profile', 'formatting', 'launch'] as const;
export type ArtifactType = typeof ARTIFACT_TYPES[number];

export interface ArtifactRow {
  type:      ArtifactType;
  id:        string;
  title:     string;
  agent:     string | null;
  channel:   string | null;
  target:    string | null;
  status:    string;
  version:   number | null;
  updatedAt: string;
  summary:   string;
  live:      boolean;
}

export interface ArtifactVersionMeta { version: number; author: string; reason: string | null; createdAt: string }

export interface ArtifactAction { key: string; label: string; method?: 'POST' | 'PATCH' | 'PUT'; path?: string; danger?: boolean }

export interface ArtifactDetail {
  row:      ArtifactRow;
  body:     unknown;
  versions: ArtifactVersionMeta[];
  actions:  ArtifactAction[];
  /** The latest chat whose message made or named it ("Open in chat"). */
  chatId?:  string | null;
}

/** An artifact as a chat message carries it; the chip reads the rest live. */
export interface ArtifactChip { type: ArtifactType; id: string; title: string; status: string }

export interface ArtifactFilter { type?: ArtifactType; agent?: string; channel?: string; status?: string; limit?: number }

const KEY = ['artifacts'] as const;
const path = (type: ArtifactType, id: string) => `/api/artifacts/${type}/${encodeURIComponent(id)}`;

/** Statuses that change by themselves (an analysis running): poll until they settle. */
const BUSY = new Set(['queued', 'collecting', 'preparing', 'analyzing']);
/** A launch waiting for the bot or running changes on the minute tick (spec 052): a slower poll. */
const LIVE_LAUNCH = new Set(['ready', 'running']);

export function useArtifacts(f: ArtifactFilter) {
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]));
  return useQuery({
    queryKey: [...KEY, 'list', f],
    queryFn: () => api<{ rows: ArtifactRow[] }>(`/api/artifacts${qs.size ? `?${qs}` : ''}`),
    refetchInterval: (q) => (q.state.data?.rows.some((r) => BUSY.has(r.status)) ? 5_000 : false),
  });
}

export function useArtifact(type: ArtifactType | null | undefined, id: string | null | undefined) {
  return useQuery({
    queryKey: [...KEY, 'one', type, id],
    queryFn: () => api<ArtifactDetail>(path(type!, id!)),
    enabled: !!type && !!id,
    staleTime: 15_000,
    refetchInterval: (q) => {
      const s = q.state.data?.row.status ?? '';
      return BUSY.has(s) ? 4_000 : type === 'launch' && LIVE_LAUNCH.has(s) ? 20_000 : false;
    },
  });
}

export function useArtifactVersion(type: ArtifactType, id: string, version: number | null) {
  return useQuery({
    queryKey: [...KEY, 'version', type, id, version],
    queryFn: () => api<{ version: number; body: unknown }>(`${path(type, id)}/versions/${version}`),
    enabled: version != null && version > 0,
    staleTime: Infinity,
  });
}

export function useInvalidateArtifacts() {
  const qc = useQueryClient();
  return () => { void qc.invalidateQueries({ queryKey: KEY }); };
}

export function usePatchArtifact() {
  const invalidate = useInvalidateArtifacts();
  return useMutation({
    mutationFn: (v: { type: ArtifactType; id: string; patch: unknown; reason?: string }) =>
      api<ArtifactDetail>(path(v.type, v.id), { method: 'PATCH', body: JSON.stringify({ patch: v.patch, ...(v.reason ? { reason: v.reason } : {}) }) }),
    onSuccess: invalidate,
  });
}

/** An artifact's own action (activate, approve…): its type's endpoint, linked by the registry. */
export function useArtifactAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: ArtifactAction) => api<unknown>(a.path!, { method: a.method ?? 'POST', body: '{}' }),
    onSuccess: () => { void qc.invalidateQueries(); },
  });
}
