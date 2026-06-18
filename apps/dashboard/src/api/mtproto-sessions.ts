import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { MtprotoSession } from './types';

// MTProto tracking/stats sessions, stored ENCRYPTED server-side. The session
// string is provided on create and is NEVER returned by any endpoint.

export function useMtprotoSessions() {
  return useQuery({
    queryKey: ['mtproto-sessions'],
    queryFn:  () => api<MtprotoSession[]>('/api/mtproto-sessions'),
  });
}

export function useAddMtprotoSession() {
  const qc = useQueryClient();
  return useMutation({
    // The session string is encrypted server-side; never echoed back.
    mutationFn: (input: { label: string; session: string }) =>
      api<MtprotoSession>('/api/mtproto-sessions', {
        method: 'POST', body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mtproto-sessions'] });
      qc.invalidateQueries({ queryKey: ['tracking-sessions'] });
    },
  });
}

export function useVerifyMtprotoSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ ok: boolean; username?: string; error?: string }>(
        `/api/mtproto-sessions/${id}/verify`, { method: 'POST' },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mtproto-sessions'] }),
  });
}

export function useToggleMtprotoSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      api<{ ok: boolean }>(`/api/mtproto-sessions/${id}`, {
        method: 'PATCH', body: JSON.stringify({ active }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mtproto-sessions'] });
      qc.invalidateQueries({ queryKey: ['tracking-sessions'] });
    },
  });
}

export function useDeleteMtprotoSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<void>(`/api/mtproto-sessions/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mtproto-sessions'] });
      qc.invalidateQueries({ queryKey: ['tracking-sessions'] });
    },
  });
}
