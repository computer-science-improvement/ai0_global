import { api } from './client';
import type { ComposedPostInput, ScheduledPost } from './types';

export const scheduledPostsApi = {
  create: (input: ComposedPostInput) => api<ScheduledPost>('/scheduled-posts', { method: 'POST', body: JSON.stringify(input) }),
  list:   (status?: string) => api<ScheduledPost[]>(`/scheduled-posts${status ? `?status=${status}` : ''}`),
  update: (id: string, input: ComposedPostInput) => api<ScheduledPost>(`/scheduled-posts/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  cancel: (id: string) => api<{ ok: boolean }>(`/scheduled-posts/${id}/cancel`, { method: 'POST' }),
};
