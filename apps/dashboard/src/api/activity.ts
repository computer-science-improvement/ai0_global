import { api } from './client';
import type { ActivityListResult, ActivityType } from './types';

export interface ActivityQuery {
  platform?: string;
  type?:     ActivityType | null;
  limit?:    number;
  offset?:   number;
}

// Read-only activity feed (strategy runs + scheduled posts). See GET /activity.
export const activityApi = {
  list: (q: ActivityQuery = {}) => {
    const p = new URLSearchParams();
    p.set('platform', q.platform ?? 'telegram');
    if (q.type)            p.set('type', q.type);
    if (q.limit  != null)  p.set('limit', String(q.limit));
    if (q.offset != null)  p.set('offset', String(q.offset));
    return api<ActivityListResult>(`/activity?${p.toString()}`);
  },
};
