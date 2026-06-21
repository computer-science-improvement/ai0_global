import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { AdOrder, AdOrderStatus } from './types';

export function useAdOrders(status?: AdOrderStatus) {
  const qs = status ? `?status=${status}` : '';
  return useQuery({
    queryKey: ['ads', status],
    queryFn:  () => api<AdOrder[]>(`/api/ad-orders${qs}`),
    refetchInterval: 30_000,
  });
}

export function useCreateAdOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: {
      advertiser: string;
      channelId?: string | null;
      amount: string;
      currency: string;
      description?: string;
    }) =>
      api<AdOrder>('/api/ad-orders', {
        method: 'POST',
        body:   JSON.stringify({
          advertiser:  v.advertiser,
          channelId:   v.channelId ?? undefined,
          amount:      v.amount,
          currency:    v.currency,
          description: v.description ?? undefined,
        }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ads'] }),
  });
}

export function useAdOrderCheckout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ data: string; signature: string; actionUrl: string }>(
        `/api/ad-orders/${id}/checkout`,
        { method: 'POST' },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ads'] }),
  });
}

export function useScheduleAdOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; channelId: string; text: string; scheduledAt: string }) =>
      api<{ actionId: string }>(`/api/ad-orders/${v.id}/schedule`, {
        method: 'POST',
        body:   JSON.stringify({ channelId: v.channelId, text: v.text, scheduledAt: v.scheduledAt }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ads'] }),
  });
}
