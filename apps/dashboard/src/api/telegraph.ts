import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { TelegraphAccount } from './types';

export function useTelegraphAccounts() {
  return useQuery({
    queryKey: ['telegraph-accounts'],
    queryFn:  () => api<TelegraphAccount[]>('/api/telegraph-accounts'),
  });
}

export function useCreateTelegraphAccount() {
  const qc = useQueryClient();
  return useMutation({
    // Provide a token VALUE (encrypted server-side) OR a legacy token_env name.
    mutationFn: (input: { account_id: string; token?: string; token_env?: string; author_name?: string; author_url?: string }) =>
      api<TelegraphAccount>('/api/telegraph-accounts', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['telegraph-accounts'] }),
  });
}

export function useVerifyTelegraphAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ ok: boolean; short_name?: string; page_count?: number; error?: string }>(
        `/api/telegraph-accounts/${id}/verify`,
        { method: 'POST' },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['telegraph-accounts'] }),
  });
}

export function useToggleTelegraphActive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      api<{ ok: boolean }>(`/api/telegraph-accounts/${id}`, {
        method: 'PATCH', body: JSON.stringify({ active }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['telegraph-accounts'] }),
  });
}

export function useDeleteTelegraphAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/telegraph-accounts/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['telegraph-accounts'] }),
  });
}
