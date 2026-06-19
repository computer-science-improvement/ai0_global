import { api } from './client';
import type { ActivityListResult, ActivityType, RunStep } from './types';

export interface ActivityQuery {
  platform?:  string;
  type?:      ActivityType | null;
  /** Inclusive ISO bounds on the event time. */
  from?:      string | null;
  to?:        string | null;
  /** Filter to one strategy (ext_id). */
  strategy?:  string | null;
  /** Filter to one resolved channel/account UUID. */
  channelId?: string | null;
  limit?:     number;
  offset?:    number;
}

// Read-only activity feed (strategy runs + scheduled posts). See GET /activity.
export const activityApi = {
  list: (q: ActivityQuery = {}) => {
    const p = new URLSearchParams();
    p.set('platform', q.platform ?? 'telegram');
    if (q.type)       p.set('type', q.type);
    if (q.from)       p.set('from', q.from);
    if (q.to)         p.set('to', q.to);
    if (q.strategy)   p.set('strategy', q.strategy);
    if (q.channelId)  p.set('channelId', q.channelId);
    if (q.limit  != null) p.set('limit', String(q.limit));
    if (q.offset != null) p.set('offset', String(q.offset));
    return api<ActivityListResult>(`/activity?${p.toString()}`);
  },

  /** Lazy-loaded execution trace for a strategy run (when a log row expands). */
  runSteps: (runId: string) => api<RunStep[]>(`/activity/run/${runId}/steps`),
};
