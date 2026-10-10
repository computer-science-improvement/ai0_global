import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { toast } from '../components/ui/Toast';
import type {
  EditorCard, EditorCardFields, EditorChannel, EditorChannelsResponse, EditorMemoryEntry, EditorMode,
  EditorPlansResponse, EditorRun, EditorRunDetail, EditorRunOutcome, EditorSlot, EditorSpendResponse,
} from './types';

// Editor agent ops surface (spec 006). Channel keys look like "@my_channel",
// so they are always URL-encoded in paths.
const enc = encodeURIComponent;
const KEY = ['editor'] as const;

export function useEditorChannels() {
  return useQuery({
    queryKey: [...KEY, 'channels'],
    queryFn:  () => api<EditorChannelsResponse>('/api/editor/channels'),
    refetchInterval: 30_000,
  });
}

export function useEditorChannel(key: string) {
  return useQuery({
    queryKey: [...KEY, 'channel', key],
    queryFn:  () => api<EditorChannel>(`/api/editor/channels/${enc(key)}`),
    refetchInterval: 30_000,
  });
}

/** Card create/update. Callers show validation errors inline, so the global toast is muted. */
export function useUpsertEditorCard() {
  const qc = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (v: { key: string; card: Partial<EditorCardFields> }) =>
      api<{ card: EditorCard; previousMode: EditorMode | null }>(`/api/editor/channels/${enc(v.key)}`, {
        method: 'PUT',
        body:   JSON.stringify(v.card),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useSetEditorMode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { key: string; mode: EditorMode }) =>
      api<{ card: EditorCard; previousMode: EditorMode | null }>(`/api/editor/channels/${enc(v.key)}`, {
        method: 'PUT',
        body:   JSON.stringify({ mode: v.mode }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

/** What a replan covers (spec 034 FR-011): the rest of today, or the next day (approval mode plans it the evening before). */
export type ReplanDay = 'today' | 'tomorrow';

export function useReplan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: string | { key: string; date?: ReplanDay }) => {
      const { key, date } = typeof v === 'string' ? { key: v, date: undefined } : v;
      return api<EditorRunOutcome>(`/api/editor/channels/${enc(key)}/replan${date === 'tomorrow' ? '?date=tomorrow' : ''}`, { method: 'POST' });
    },
    // The planner runs in the background; refresh now and again shortly after.
    onSuccess: (_d, v) => {
      const { key, date } = typeof v === 'string' ? { key: v, date: undefined } : v;
      toast.success(`Planner started for ${key} — ${date === 'tomorrow' ? 'tomorrow is' : 'the rest of today is'} replanned; written posts stay. The new plan appears in a minute.`);
      qc.invalidateQueries({ queryKey: KEY });
      setTimeout(() => qc.invalidateQueries({ queryKey: KEY }), 20_000);
    },
  });
}

export function useEditorPlans(date: string | undefined, channel?: string) {
  const qs = new URLSearchParams();
  if (date)    qs.set('date', date);
  if (channel) qs.set('channel', channel);
  return useQuery({
    queryKey: [...KEY, 'plans', date ?? 'today', channel ?? null],
    queryFn:  () => api<EditorPlansResponse>(`/api/editor/plans?${qs.toString()}`),
    refetchInterval: 30_000,
  });
}

export function useEditorSlot(id: string) {
  return useQuery({
    queryKey: [...KEY, 'slot', id],
    queryFn:  () => api<EditorSlot>(`/api/editor/slots/${id}`),
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 5_000 : 30_000),
  });
}

export function useRunSlot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<EditorRunOutcome>(`/api/editor/slots/${id}/run`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Executor started — the slot updates when the run finishes.');
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export function useSkipSlot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; reason?: string }) =>
      api<EditorSlot>(`/api/editor/slots/${v.id}/skip`, { method: 'POST', body: JSON.stringify({ reason: v.reason }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useEditorRuns(filter: { channel?: string; slot?: string; limit?: number } = {}) {
  const qs = new URLSearchParams();
  if (filter.channel) qs.set('channel', filter.channel);
  if (filter.slot)    qs.set('slot', filter.slot);
  if (filter.limit)   qs.set('limit', String(filter.limit));
  return useQuery({
    queryKey: [...KEY, 'runs', filter],
    queryFn:  () => api<EditorRun[]>(`/api/editor/runs?${qs.toString()}`),
    refetchInterval: 30_000,
  });
}

export function useEditorRun(id: string) {
  return useQuery({
    queryKey: [...KEY, 'run', id],
    queryFn:  () => api<EditorRunDetail>(`/api/editor/runs/${id}`),
    refetchInterval: (q) => (q.state.data?.run.status === 'running' ? 5_000 : false),
  });
}

export function useEditorMemory(key: string) {
  return useQuery({
    queryKey: [...KEY, 'memory', key],
    queryFn:  () => api<EditorMemoryEntry[]>(`/api/editor/channels/${enc(key)}/memory`),
  });
}

export function useAddEditorMemory(key: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { kind: EditorMemoryEntry['kind']; text: string }) =>
      api<{ id: number }>(`/api/editor/channels/${enc(key)}/memory`, { method: 'POST', body: JSON.stringify(v) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...KEY, 'memory', key] }),
  });
}

export function useRetireEditorMemory(key: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api<{ ok: true }>(`/api/editor/channels/${enc(key)}/memory/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...KEY, 'memory', key] }),
  });
}

export function useEditorSpend(days = 30) {
  return useQuery({
    queryKey: [...KEY, 'spend', days],
    queryFn:  () => api<EditorSpendResponse>(`/api/editor/spend?days=${days}`),
    refetchInterval: 60_000,
  });
}
