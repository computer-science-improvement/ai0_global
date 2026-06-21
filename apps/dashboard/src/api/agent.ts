import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { AgentThread, AgentStatus, AgentCategory, AgentAction, AgentActionStatus, AgentActionType } from './types';

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

// ─── Agent Actions (SP2) ──────────────────────────────────────────────────────

export function useAgentActions(status?: AgentActionStatus) {
  const qs = status ? `?status=${status}` : '';
  return useQuery({
    queryKey: ['agent', 'actions', status],
    queryFn:  () => api<AgentAction[]>(`/api/agent/actions${qs}`),
    refetchInterval: 15_000,
  });
}

export function useCreateAgentAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { type: AgentActionType; threadId?: string; payload: Record<string, any> }) =>
      api<AgentAction>('/api/agent/actions', {
        method: 'POST',
        body:   JSON.stringify({ type: v.type, threadId: v.threadId, payload: v.payload }),
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['agent', 'actions'] });
      // Creating a reply action touches the thread's context — refresh inbox too.
      if (vars.type === 'reply') qc.invalidateQueries({ queryKey: ['agent', 'inbox'] });
    },
  });
}

export function useApproveAgentAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<AgentAction>(`/api/agent/actions/${id}/approve`, { method: 'POST' }),
    onSuccess: (_data, _id) => {
      qc.invalidateQueries({ queryKey: ['agent', 'actions'] });
      // Approving a reply sends the message — inbox thread status changes.
      qc.invalidateQueries({ queryKey: ['agent', 'inbox'] });
    },
  });
}

export function useRejectAgentAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<AgentAction>(`/api/agent/actions/${id}/reject`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agent', 'actions'] }),
  });
}
