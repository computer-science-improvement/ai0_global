import { api } from './client';
import type { TrackedChannel, TrackedPost, SubsHistoryPoint, PageResp, GraphResponse, RoiResponse } from './types';

export interface PatchChannelInput {
  title?:         string | null;
  isMine?:        boolean;
  botId?:         string | null;
  channelKey?:    string | null;
  tgChatId?:      string | null;
  kind?:          'public' | 'private' | null;
  pollTier?:      'hot' | 'warm' | 'cold';
  themes?:        string[];
  publishPaused?: boolean;
}

export interface CreateFullChannelInput {
  kind:         'public' | 'private';
  channelKey?:  string;
  username?:    string;
  tgChatId?:    string;
  title?:       string;
  botId?:       string | null;
  isMine?:      boolean;
  pollTier?:    'hot' | 'warm' | 'cold';
}

export const trackingApi = {
  listChannels: (q: { filter?: string; q?: string; tier?: string; bot?: string; page?: number; pageSize?: number }) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v) params.set(k, String(v));
    return api<PageResp<TrackedChannel>>(`/tracking/channels?${params}`);
  },
  getChannel:    (id: string) => api<TrackedChannel>(`/tracking/channels/${id}`),
  patchChannel:  (id: string, patch: PatchChannelInput) =>
    api<TrackedChannel>(`/tracking/channels/${id}`, {
      method: 'PATCH', body: JSON.stringify(patch),
    }),
  addChannel:    (username: string) =>
    api<{ id: string; status: 'queued' | 'already_tracked' }>(`/tracking/channels`, {
      method: 'POST', body: JSON.stringify({ username }),
    }),
  createFullChannel: (input: CreateFullChannelInput) =>
    api<TrackedChannel>(`/tracking/channels/full`, {
      method: 'POST', body: JSON.stringify(input),
    }),
  deleteChannel: (id: string) => api<void>(`/tracking/channels/${id}`, { method: 'DELETE' }),
  listPosts:     (id: string, limit = 50, offset = 0) =>
    api<PageResp<TrackedPost>>(`/tracking/channels/${id}/posts?limit=${limit}&offset=${offset}`),
  subsHistory:   (id: string) =>
    api<{ points: SubsHistoryPoint[] }>(`/tracking/channels/${id}/subs-history`),
  topPosts:      (id: string, metric = 'views', limit = 10) =>
    api<{ items: TrackedPost[] }>(`/tracking/channels/${id}/top-posts?metric=${metric}&limit=${limit}`),
  discovery:     () => api<{ items: Array<{ id: string; username: string; isClosed: boolean; addedAt: string }> }>(`/tracking/discovery`),
  graph: (q: { from?: string; to?: string; min_edge_weight?: number; kind?: string[]; include_mine?: boolean }) => {
    const params = new URLSearchParams();
    if (q.from) params.set('from', q.from);
    if (q.to)   params.set('to',   q.to);
    if (q.min_edge_weight) params.set('min_edge_weight', String(q.min_edge_weight));
    if (q.kind) q.kind.forEach((k) => params.append('kind', k));
    if (q.include_mine === false) params.set('include_mine', 'false');
    return api<GraphResponse>(`/tracking/graph?${params}`);
  },
  roi: (id: string, fresh = false) =>
    api<RoiResponse>(`/tracking/roi/${id}${fresh ? '?fresh=true' : ''}`),
  edgePosts: (sourceId: string, targetUsername: string) =>
    api<{ items: TrackedPost[] }>(`/tracking/edges/${sourceId}/${encodeURIComponent(targetUsername)}/posts`),
};
