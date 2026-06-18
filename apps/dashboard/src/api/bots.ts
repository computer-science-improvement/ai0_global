import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { Bot } from './types';

export function useBots() {
  return useQuery({
    queryKey: ['bots'],
    queryFn:  () => api<Bot[]>('/api/my-bots'),
  });
}

export function useCreateBot() {
  const qc = useQueryClient();
  return useMutation({
    // Provide a token VALUE (encrypted server-side) OR a legacy token_env name.
    mutationFn: (input: { bot_id: string; token?: string; token_env?: string }) =>
      api<Bot>('/api/my-bots', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bots'] }),
  });
}

export function useVerifyBot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ ok: boolean; username?: string; first_name?: string; error?: string }>(
        `/api/my-bots/${id}/verify`,
        { method: 'POST' },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bots'] }),
  });
}

export function useToggleBotActive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      api<{ ok: boolean }>(`/api/my-bots/${id}`, {
        method: 'PATCH', body: JSON.stringify({ active }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bots'] }),
  });
}

export function useDeleteBot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, unbind }: { id: string; unbind?: boolean }) =>
      api<void>(`/api/my-bots/${id}${unbind ? '?unbind=true' : ''}`, { method: 'DELETE' }),
    // unbind nulls channels' bot_id (→ default-bot fallback) + detaches scheduled
    // posts, so refresh channels + strategies (needs-bot) alongside the bot list.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bots'] });
      qc.invalidateQueries({ queryKey: ['channels'] });
      qc.invalidateQueries({ queryKey: ['strategies'] });
    },
  });
}

export function useSetDefaultBot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, default: isDefault }: { id: string; default: boolean }) =>
      api<{ ok: true }>(`/api/my-bots/${id}/set-default`, {
        method: 'POST', body: JSON.stringify({ default: isDefault }),
      }),
    // Refresh the bot list (is_default), plus channels + strategies so their
    // needs_bot/needsBot flags and bot-picker option labels reflect the change.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bots'] });
      qc.invalidateQueries({ queryKey: ['channels'] });
      qc.invalidateQueries({ queryKey: ['strategies'] });
    },
  });
}
