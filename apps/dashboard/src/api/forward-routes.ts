// apps/dashboard/src/api/forward-routes.ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export interface ForwardRoute {
  id:                  string;
  source_channel_id:   string;
  target_channel_id:   string;
  topic:               string;
  description:         string;
  source_channel_key:  string | null;
  target_channel_key:  string | null;
  target_title:        string | null;
}

export function useForwardRoutes(sourceId: string | null) {
  return useQuery({
    queryKey: ['forward-routes', sourceId ?? 'all'],
    queryFn:  () => {
      const qs = sourceId ? `?source=${sourceId}` : '';
      return api<ForwardRoute[]>(`/api/forward-routes${qs}`);
    },
    enabled:  !!sourceId,
  });
}

export interface CreateForwardRouteInput {
  source_channel_id: string;
  target_channel_id: string;
  topic:             string;
  description?:      string;
}

export function useCreateForwardRoute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateForwardRouteInput) =>
      api<ForwardRoute>('/api/forward-routes', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['forward-routes', vars.source_channel_id] });
      qc.invalidateQueries({ queryKey: ['strategies'] });
      qc.invalidateQueries({ queryKey: ['channels'] });
    },
  });
}

export function useDeleteForwardRoute(sourceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/forward-routes/${id}`, { method: 'DELETE' }),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['forward-routes', sourceId] });
      qc.invalidateQueries({ queryKey: ['strategies'] });
      qc.invalidateQueries({ queryKey: ['channels'] });
    },
  });
}
