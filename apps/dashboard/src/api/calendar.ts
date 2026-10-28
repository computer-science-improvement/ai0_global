import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './client';
import { scheduledPostsApi } from './scheduled-posts';
import { trackingApi } from './tracking';
import type { SeriesPause, SeriesPausesResponse } from './agents';
import type { RuleInput, RuleResult, ScheduleResponse } from './schedule';
import { describeError } from '../components/ui/Toast';
import type { ScheduleState } from '../lib/calendar';

// Spec 078 B4: what the Calendar page reads, for every orchestrator at once. The query keys are the ones the single-agent
// hooks use (`useSchedule`, `useSeriesPauses`, the Scheduled page), so a change made anywhere refreshes the grid and the
// other way round: ['schedule', handle, from] (the response is the server's 7 days from `from`; the grid shows 5),
// ['agents', 'series-pauses', handle], ['scheduled-posts'], ['channels', 'mine', 1, '', undefined].

const enc = encodeURIComponent;

/** The reason an error carries, for a row that could not load ("no_channel_card"). */
function reasonOf(err: unknown): string {
  if (err instanceof ApiError) {
    try {
      const b = JSON.parse(err.message);
      if (b && typeof b.error === 'string') return b.error;
    } catch { /* plain text */ }
    return `http_${err.status}`;
  }
  return err instanceof Error ? err.message : 'failed';
}

/**
 * A failed request as one English sentence for the form: the server's `details` (a string or a list of problems), else its
 * message, else its error code ("rule invalid"). Anything else goes through `describeError`.
 */
export function apiMessage(err: unknown): string {
  if (err instanceof ApiError) {
    try {
      const b = JSON.parse(err.message);
      if (Array.isArray(b?.details) && b.details.length) return b.details.join('; ');
      if (typeof b?.details === 'string' && b.details) return b.details;
      if (Array.isArray(b?.message) && b.message.length) return b.message.join('; ');
      if (typeof b?.message === 'string' && b.message) return b.message;
      if (typeof b?.error === 'string' && b.error) return b.error.replace(/_/g, ' ');
    } catch { /* plain text */ }
  }
  return describeError(err);
}

/** One schedule per handle, over the window starting at `from`. Always an explicit `from`: `useSchedule(handle)` without one is another cache entry. */
export function useCalendarSchedules(handles: readonly string[], from: string): Record<string, ScheduleState> {
  const results = useQueries({
    queries: handles.map((handle) => ({
      queryKey: ['schedule', handle, from],
      queryFn:  () => api<ScheduleResponse>(`/api/agents/${enc(handle)}/schedule?from=${enc(from)}`),
      retry:    false,
      refetchInterval: 60_000,
    })),
  });
  return Object.fromEntries(handles.map((h, i) => [h, {
    data: results[i]?.data, error: results[i]?.error ? reasonOf(results[i].error) : null, loading: !!results[i]?.isLoading,
  } satisfies ScheduleState]));
}

/** The open series pauses of every handle (an agent without a channel, or a server without the endpoint, has none). */
export function useCalendarPauses(handles: readonly string[]): Record<string, SeriesPause[]> {
  const results = useQueries({
    queries: handles.map((handle) => ({
      queryKey: ['agents', 'series-pauses', handle],
      queryFn:  () => api<SeriesPausesResponse>(`/api/agents/${enc(handle)}/series-pauses`),
      retry:    false,
    })),
  });
  return Object.fromEntries(handles.map((h, i) => [h, results[i]?.data?.open ?? []]));
}

/** The owner's own posts (all of them: the server has no date filter; the grid keeps the window's). */
export function useCalendarPosts() {
  return useQuery({ queryKey: ['scheduled-posts'], queryFn: () => scheduledPostsApi.list() });
}

/** The owner's channels, with the bot each one posts through (the composer's channel chips). */
export function useCalendarChannels() {
  return useQuery({
    queryKey: ['channels', 'mine', 1, '', undefined],
    queryFn:  () => trackingApi.listChannels({ filter: 'mine', page: 1, pageSize: 100 }),
  });
}

/** "Ask the agent": a one-off pin on the agent's schedule. The handle is a variable because the channel is picked in the form. */
export function useAskAgentPin() {
  const qc = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (v: { handle: string; rule: RuleInput }) =>
      api<RuleResult>(`/api/agents/${enc(v.handle)}/schedule-rules`, { method: 'POST', body: JSON.stringify(v.rule) }),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: ['schedule'] }), qc.invalidateQueries({ queryKey: ['network'] })]),
  });
}

/** Undo of "Ask the agent": the pin is switched off (the server drops its not-yet-run slot). */
export function useDisablePin() {
  const qc = useQueryClient();
  return useMutation({
    meta: { silentError: true },
    mutationFn: (v: { handle: string; id: string }) =>
      api<RuleResult>(`/api/agents/${enc(v.handle)}/schedule-rules/${enc(v.id)}`, { method: 'PATCH', body: JSON.stringify({ active: false }) }),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: ['schedule'] }), qc.invalidateQueries({ queryKey: ['network'] })]),
  });
}
