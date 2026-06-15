import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export interface TikTokAccount {
  id: string; open_id: string; username: string | null; display_name: string | null;
  avatar_url: string | null; active: boolean; last_refreshed_at: string | null;
  refresh_error: string | null; created_at: string;
}

const KEY = ['tiktok-accounts'];

export function useTikTokAccounts() {
  return useQuery({ queryKey: KEY, queryFn: () => api<TikTokAccount[]>('/api/tiktok-accounts') });
}

export function useToggleTikTokAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      api<{ ok: boolean }>(`/api/tiktok-accounts/${id}`, { method: 'PATCH', body: JSON.stringify({ active }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useDeleteTikTokAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/tiktok-accounts/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

/** Begin the OAuth flow: ask the API for the authorize URL, then navigate to it. */
export async function startTikTokOAuth(): Promise<void> {
  const { url } = await api<{ url: string }>('/api/tiktok/oauth/start');
  window.location.href = url;
}
