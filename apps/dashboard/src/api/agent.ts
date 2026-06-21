import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { AgentThread, AgentStatus, AgentCategory } from './types';

export function useAgentInbox(filter: { status?: string; category?: AgentCategory } = {}) {
  const qs = new URLSearchParams();
  if (filter.status)   qs.set('status', filter.status);
  if (filter.category) qs.set('category', filter.category);
  return useQuery({
    queryKey: ['agent', 'inbox', filter],
    queryFn:  () => api<AgentThread[]>(`/api/agent/inbox?${qs.toString()}`),
    refetchInterval: 30_000,
  });
}

export function useAgentStatus() {
  return useQuery({
    queryKey: ['agent', 'status'],
    queryFn:  () => api<AgentStatus>('/api/agent/status'),
    refetchInterval: 30_000,
  });
}

export function usePatchAgentThread() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; status: 'reviewed' | 'archived' | 'new' }) =>
      api<{ ok: boolean }>(`/api/agent/inbox/${v.id}`, {
        method: 'PATCH',
        body:   JSON.stringify({ status: v.status }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agent', 'inbox'] }),
  });
}
