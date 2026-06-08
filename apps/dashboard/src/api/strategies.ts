// apps/dashboard/src/api/strategies.ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { Strategy, StrategyRun, StrategyPreview } from './types';

export function useStrategyRuns(strategyId: string | null) {
  return useQuery({
    queryKey: ['strategy-runs', strategyId],
    queryFn:  () => api<StrategyRun[]>(`/api/strategies/${strategyId}/runs`),
    enabled:  !!strategyId,
    refetchInterval: 10_000,
  });
}

export function useStrategyPreview(strategyId: string | null) {
  return useQuery({
    queryKey: ['strategy-preview', strategyId],
    queryFn:  () => api<StrategyPreview>(`/api/strategies/${strategyId}/preview`),
    enabled:  !!strategyId,
    staleTime: 60_000,
  });
}

export function useStrategies() {
  return useQuery({
    queryKey: ['strategies'],
    queryFn:  () => api<Strategy[]>('/api/strategies'),
    // Recompute next-run timestamps reasonably often (every 30s in foreground).
    refetchInterval: 30_000,
  });
}

export interface CreateStrategyInput {
  ext_id:      string;
  type:        string;
  channel_id:  string;
  schedule:    string;
  params?:     Record<string, unknown>;
  enabled?:    boolean;
}

export function useCreateStrategy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateStrategyInput) =>
      api<Strategy>('/api/strategies', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['strategies'] }),
  });
}

export interface PatchStrategyInput {
  type?:       string;
  channel_id?: string;
  schedule?:   string;
  params?:     Record<string, unknown>;
  enabled?:    boolean;
  notes?:      string | null;
  low_content_threshold?: number | null;
}

export function usePatchStrategy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: PatchStrategyInput }) =>
      api<Strategy>(`/api/strategies/${id}`, {
        method: 'PATCH', body: JSON.stringify(patch),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['strategies'] }),
  });
}

export function useDeleteStrategy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/strategies/${id}`, { method: 'DELETE' }),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['strategies'] }),
  });
}
