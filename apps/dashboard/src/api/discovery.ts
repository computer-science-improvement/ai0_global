import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { RecommendResponse, Theme } from './types';

export function useThemes() {
  return useQuery({
    queryKey: ['themes'],
    queryFn: () => api<{ themes: Theme[] }>('/api/themes').then(r => r.themes),
    staleTime: 24 * 60 * 60 * 1000,
  });
}

export function useChannelThemes(channelId: string | null) {
  return useQuery({
    queryKey: ['channel-themes', channelId],
    queryFn: () =>
      api<{ themes: string[] }>(`/api/tracked-channels/${channelId}/themes`).then(r => r.themes),
    enabled: !!channelId,
  });
}

export function useUpdateChannelThemes(channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (themes: string[]) =>
      api<void>(`/api/tracked-channels/${channelId}/themes`, {
        method: 'PUT',
        body: JSON.stringify({ themes }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['channel-themes', channelId] });
      qc.invalidateQueries({ queryKey: ['recommendations'] });
      qc.invalidateQueries({ queryKey: ['channel', channelId] });
    },
  });
}

export function useRecommendations(input: {
  targetChannelId: string | null;
  budget:          number;
  limit?:          number;
}) {
  return useQuery({
    queryKey: ['recommendations', input.targetChannelId, input.budget, input.limit],
    queryFn: () =>
      api<RecommendResponse>('/api/recommendations', {
        method: 'POST',
        body: JSON.stringify({
          targetChannelId: input.targetChannelId,
          budget:          input.budget,
          limit:           input.limit ?? 20,
        }),
      }),
    enabled: !!input.targetChannelId && input.budget > 0,
  });
}
