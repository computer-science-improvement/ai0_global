import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { CrosspostTarget, CrosspostMode, MetaPlatform } from './types';

const key = (channelId: string) => ['crossposts', channelId];

export function useCrossposts(channelId: string | null) {
  return useQuery({
    queryKey: key(channelId ?? ''),
    queryFn:  () => api<CrosspostTarget[]>(`/api/channels/${channelId}/crossposts`),
    enabled:  !!channelId,
  });
}

export interface CreateCrosspostInput {
  platform:      MetaPlatform;
  metaAccountId: string;
  mode:          CrosspostMode;
}

export function useCreateCrosspost(channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCrosspostInput) =>
      api<CrosspostTarget>(`/api/channels/${channelId}/crossposts`, { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key(channelId) });
      qc.invalidateQueries({ queryKey: ['strategies'] });
    },
  });
}

export function useToggleCrosspost(channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api<{ ok: boolean }>(`/api/channels/${channelId}/crossposts/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key(channelId) }),
  });
}

export function useDeleteCrosspost(channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/channels/${channelId}/crossposts/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key(channelId) });
      qc.invalidateQueries({ queryKey: ['strategies'] });
    },
  });
}
