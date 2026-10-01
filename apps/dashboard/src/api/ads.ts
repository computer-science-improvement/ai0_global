import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type { AdCreative, AdFormat, AdOrder, AdOrderStatus, AdPrice, AdReport, MediaKitChannel } from './types';

export const AD_FORMAT_LABEL: Record<AdFormat, string> = {
  post:           'Post',
  pin_24h:        'Post + 24h pin',
  digest_sponsor: 'Digest sponsor',
};

export function useAdOrders(status?: AdOrderStatus) {
  const qs = status ? `?status=${status}` : '';
  return useQuery({
    queryKey: ['ads', status],
    queryFn:  () => api<AdOrder[]>(`/api/ad-orders${qs}`),
    refetchInterval: 30_000,
  });
}

export interface CreateAdOrderInput {
  advertiser:    string;
  channelId?:    string | null;
  /** Ignored by the server when priceId is set (amount comes from the price). */
  amount?:       string;
  currency?:     string;
  description?:  string;
  priceId?:      string;
  creative?:     AdCreative;
  sponsorLabel?: string;
  publishAt?:    string;
}

export function useCreateAdOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: CreateAdOrderInput) =>
      api<AdOrder>('/api/ad-orders', {
        method: 'POST',
        body:   JSON.stringify({
          advertiser:   v.advertiser,
          channelId:    v.channelId ?? undefined,
          amount:       v.priceId ? undefined : v.amount,
          currency:     v.priceId ? undefined : v.currency,
          description:  v.description || undefined,
          priceId:      v.priceId || undefined,
          creative:     v.creative,
          sponsorLabel: v.sponsorLabel || undefined,
          publishAt:    v.publishAt || undefined,
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

/** Every field falls back to the order (channel, creative, publish_at). */
export function useScheduleAdOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; channelId?: string; text?: string; scheduledAt?: string }) =>
      api<{ actionId: string }>(`/api/ad-orders/${v.id}/schedule`, {
        method: 'POST',
        body:   JSON.stringify({ channelId: v.channelId || undefined, text: v.text || undefined, scheduledAt: v.scheduledAt || undefined }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ads'] }),
  });
}

// ─── Price list (owner) ──────────────────────────────────────────────────────

export function useAdPrices() {
  return useQuery({ queryKey: ['ad-prices'], queryFn: () => api<AdPrice[]>('/api/ad-prices') });
}

export function useUpsertAdPrice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { channelKey: string; format: AdFormat; priceUah: number; note?: string }) =>
      api<AdPrice>('/api/ad-prices', { method: 'PUT', body: JSON.stringify({ ...v, note: v.note || undefined }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ad-prices'] }),
  });
}

export function useDeactivateAdPrice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/api/ad-prices/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ad-prices'] }),
  });
}

// ─── Public (no auth) ────────────────────────────────────────────────────────

export function useMediaKit() {
  return useQuery({ queryKey: ['landing', 'media-kit'], queryFn: () => api<MediaKitChannel[]>('/api/landing/media-kit') });
}

export function useAdReport(token: string) {
  return useQuery({
    queryKey: ['ad-report', token],
    queryFn:  () => api<AdReport>(`/api/ads/report/${encodeURIComponent(token)}`),
    retry:    false,
  });
}
