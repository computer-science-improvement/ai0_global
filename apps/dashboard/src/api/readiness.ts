import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './client';
import { isFreshWindow, readinessPath } from '../lib/readiness';

// Spec 072 FR-007/FR-008: the channel doctor's stored result. GET /api/editor/channels/:key/readiness (?fresh=1 runs a look now),
// POST …/readiness/recheck and POST …/readiness/fix {codes?, keys?}. A channel without a card answers 404 `channel_not_found`.

export type ReadinessSeverity = 'error' | 'warn' | 'info';

export interface ReadinessFinding {
  key: string; code: string; severity: ReadinessSeverity; title: string; detail: string;
  subject: { type: string; id: string; label: string; agent?: string; channel?: string };
  link: string | null; firstSeenAt: string | null;
  /** The fix itself stays on the server: its label, and whether code may apply it by itself. */
  fix: { label: string; auto: boolean } | null;
}

export interface ReadinessLast24h { planned: number; published: number; awaiting: number; skipped: number; byGroup: Record<string, number> }

export interface ReadinessView {
  channelKey: string; agent: string | null; mode: 'off' | 'shadow' | 'approve' | 'live'; checkedAt: string; configHash: string;
  blockers: number; warnings: number; infos: number; fixable: number;
  findings: ReadinessFinding[];
  last24h: ReadinessLast24h;
  topFix: { key: string; title: string; link: string | null } | null;
}

export interface ReadinessFixResult {
  applied: string[];
  failed: Array<{ code: string; error: string }>;
  view: ReadinessView;
}

/** What a fix request selects (A13): nothing = Fix all; `codes` = the open findings with those codes; `keys` = those findings only. */
export interface ReadinessFixSelection { codes?: string[]; keys?: string[] }

/** The prefix of every cached Readiness result (`router.ts` invalidates it after a change). */
export const READINESS_ROOT = ['readiness'] as const;
export const readinessKey = (channelKey: string) => [...READINESS_ROOT, channelKey] as const;

// A11: a plain GET answers from the stored row (under a minute old). After any successful change the next reads ask for a fresh
// look for a few seconds: `router.ts` opens the window in the mutation cache, before it invalidates ['readiness'].
let staleAt: number | null = null;
export function markReadinessStale(now: number = Date.now()): void { staleAt = now; }
export const readinessFresh = (now: number = Date.now()): boolean => isFreshWindow(now, staleAt);

export const getReadiness = (channelKey: string, o: { fresh?: boolean } = {}) =>
  api<ReadinessView>(readinessPath(channelKey, !!o.fresh));

const is404 = (e: unknown) => e instanceof ApiError && e.status === 404;

/** The stored result of one channel. A 404 is an answer ("no card"), so it is not retried. */
export function useReadiness(channelKey: string | null | undefined, o: { enabled?: boolean } = {}) {
  const key = channelKey ?? '';
  return useQuery({
    queryKey: readinessKey(key),
    queryFn: () => getReadiness(key, { fresh: readinessFresh() }),
    enabled: !!key && o.enabled !== false,
    staleTime: 30_000,
    retry: (n, e) => !is404(e) && !(e instanceof ApiError && e.status === 401) && n < 1,
  });
}

/** Recheck now (reason `owner`: the server applies the two safe fixes by itself too). The answer replaces the cached view. */
export function useRecheckReadiness(channelKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<ReadinessView>(`/api/editor/channels/${encodeURIComponent(channelKey)}/readiness/recheck`, { method: 'POST', body: '{}' }),
    // The global handler must not open the fresh window for this: the answer is already fresh.
    meta: { readiness: true },
    onSuccess: (view) => { qc.setQueryData(readinessKey(channelKey), view); },
  });
}

/** Fix all (no selection), one finding (`keys: [key]`) or the findings with some codes. The answer carries the rechecked view. */
export function useFixReadiness(channelKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sel: ReadinessFixSelection = {}) =>
      api<ReadinessFixResult>(`/api/editor/channels/${encodeURIComponent(channelKey)}/readiness/fix`, { method: 'POST', body: JSON.stringify(sel) }),
    meta: { readiness: true },
    onSuccess: (r) => {
      qc.setQueryData(readinessKey(channelKey), r.view);
      // A fix changes a skill, a rule, the card or a pause: the pages that show them read again.
      void qc.invalidateQueries({ queryKey: ['agents'] });
      void qc.invalidateQueries({ queryKey: ['editor'] });
    },
  });
}
