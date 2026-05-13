import { api } from './client';
import type { TrackedChannel, TrackedPost, SubsHistoryPoint, PageResp } from './types';

export const trackingApi = {
  listChannels: (q: { filter?: string; q?: string; tier?: string; page?: number; pageSize?: number }) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v) params.set(k, String(v));
    return api<PageResp<TrackedChannel>>(`/tracking/channels?${params}`);
  },
  getChannel:    (id: string) => api<TrackedChannel>(`/tracking/channels/${id}`),
  addChannel:    (username: string) =>
    api<{ id: string; status: 'queued' | 'already_tracked' }>(`/tracking/channels`, {
      method: 'POST', body: JSON.stringify({ username }),
    }),
  deleteChannel: (id: string) => api<void>(`/tracking/channels/${id}`, { method: 'DELETE' }),
  listPosts:     (id: string, limit = 50, offset = 0) =>
    api<PageResp<TrackedPost>>(`/tracking/channels/${id}/posts?limit=${limit}&offset=${offset}`),
  subsHistory:   (id: string) =>
    api<{ points: SubsHistoryPoint[] }>(`/tracking/channels/${id}/subs-history`),
  topPosts:      (id: string, metric = 'views', limit = 10) =>
    api<{ items: TrackedPost[] }>(`/tracking/channels/${id}/top-posts?metric=${metric}&limit=${limit}`),
  discovery:     () => api<{ items: Array<{ id: string; username: string; isClosed: boolean; addedAt: string }> }>(`/tracking/discovery`),
};
