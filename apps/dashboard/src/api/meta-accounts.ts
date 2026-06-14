import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { MetaAccount, MetaPlatform } from './types';

const KEY = ['meta-accounts'];

export function useMetaAccounts() {
  return useQuery({ queryKey: KEY, queryFn: () => api<MetaAccount[]>('/api/meta-accounts') });
}

export interface CreateMetaAccountInput {
  platform:  MetaPlatform;
  accountId: string;
  tokenEnv:  string;
  targetId:  string;
}

export function useCreateMetaAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMetaAccountInput) =>
      api<MetaAccount>('/api/meta-accounts', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useVerifyMetaAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ ok: boolean; error?: string }>(`/api/meta-accounts/${id}/verify`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useToggleMetaAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      api<{ ok: boolean }>(`/api/meta-accounts/${id}`, { method: 'PATCH', body: JSON.stringify({ active }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useDeleteMetaAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/meta-accounts/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export interface MetaFollowerHistory {
  accountId: string;
  current:   number | null;
  delta24h:  number | null;
  delta7d:   number | null;
  points:    { at: string; followers: number }[];
}

export function useMetaFollowerHistory(id: string) {
  return useQuery({
    queryKey: ['meta-follower-history', id],
    queryFn:  () => api<MetaFollowerHistory>(`/api/meta-accounts/${id}/follower-history`),
    enabled:  !!id,
  });
}

export interface MetaInsightDay {
  day:          string;
  reach:        number | null;
  impressions:  number | null;
  profileViews: number | null;
}
export interface MetaAccountInsights {
  accountId: string;
  points:    MetaInsightDay[];
}

export function useMetaAccountInsights(id: string) {
  return useQuery({
    queryKey: ['meta-account-insights', id],
    queryFn:  () => api<MetaAccountInsights>(`/api/meta-accounts/${id}/insights`),
    enabled:  !!id,
  });
}

/** Manually trigger the Meta stats collector (followers + insights, all active
 *  accounts), then refresh the account list + history/insight charts. */
export function useRefreshMetaStats() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ accounts: number; snapshots: number; insightDays: number }>(
      '/api/meta-accounts/refresh-stats', { method: 'POST' },
    ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['meta-accounts'] });
      qc.invalidateQueries({ queryKey: ['meta-follower-history'] });
      qc.invalidateQueries({ queryKey: ['meta-account-insights'] });
    },
  });
}
