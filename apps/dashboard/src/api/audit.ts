import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { ResourceAuditView } from '../lib/audit-view';

// Spec 037 FR-014 (T14): the post audit.
// GET /api/editor/audit?resource=<ref>&days=7 — one resource's findings grouped by code;
// POST /api/editor/audit/run[?resource=<ref>] — audit now (one resource or all).

const KEY = ['post-audit'] as const;

export function usePostAudit(resource: string, opts: { enabled?: boolean; days?: number } = {}) {
  const qs = new URLSearchParams({ resource });
  if (opts.days) qs.set('days', String(opts.days));
  return useQuery({
    queryKey: [...KEY, resource, opts.days ?? 7],
    queryFn:  () => api<ResourceAuditView>(`/api/editor/audit?${qs.toString()}`),
    enabled:  opts.enabled ?? true,
    staleTime: 60_000,
  });
}

export interface AuditRunResult { resource: string; posts: number; findings: number; rulesHash: string; error?: string }

export function useRunPostAudit() {
  const qc = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (resource?: string) =>
      api<{ results: AuditRunResult[] }>(`/api/editor/audit/run${resource ? `?resource=${encodeURIComponent(resource)}` : ''}`, { method: 'POST' }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ['manager'] });
    },
  });
}
