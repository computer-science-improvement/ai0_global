// Spec 027 T4: the saved menu in React — query, first-paint cache, resolution,
// and the optimistic quick edits used by the sidebar (pin, hide) and ⌘K.
import { useCallback, useEffect, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { ApiError } from '../api/client';
import { navApi, NAV_BADGES_KEY, NAV_CONFIG_KEY, takeFreshBadges } from '../api/nav';
import { useApprovalsCount } from '../api/approvals';
import { describeError, toast } from '../components/ui/Toast';
import { isIconName } from '../components/ui/Icon';
import { NAV_REGISTRY } from './registry';
import { normalizeNav, resolveNav } from './resolve';
import { makeRouteMatcher } from './routes';
import type { NavConfigResponse, NavConfigV1 } from './config';
import type { BadgeCounts } from './badges';
import { readNavCache as readCache, writeNavCache as writeCache } from './cache';

/** The saved menu. Seeds from the cache (refetched at once), then keeps the cache fresh. */
export function useNavConfig(opts: { fresh?: boolean } = {}) {
  const q = useQuery({
    queryKey: NAV_CONFIG_KEY,
    queryFn: () => navApi.getConfig(),
    initialData: readCache,
    initialDataUpdatedAt: 0,
    staleTime: 60_000,
    // The constructor bases its draft on the server's copy: always refetch when it mounts.
    ...(opts.fresh ? { refetchOnMount: 'always' as const } : {}),
  });
  useEffect(() => { if (q.data && q.isFetchedAfterMount) writeCache(q.data); }, [q.data, q.isFetchedAfterMount]);
  return q;
}

/** Does an href still match a route of this build? (custom links, FR-007) */
export function useRouteExists(): (href: string) => boolean {
  const router = useRouter();
  return useMemo(() => makeRouteMatcher(Object.keys(router.routesByPath)), [router]);
}

/** The menu to render (saved or default), with source and warnings. */
export function useResolvedNav() {
  const { data } = useNavConfig();
  const routeExists = useRouteExists();
  const config = data?.config ?? null;
  return useMemo(() => resolveNav(NAV_REGISTRY, config, { routeExists, isIcon: isIconName }), [config, routeExists]);
}

/** Owner renames by item id (breadcrumbs, palette). */
export function useNavLabels(): Record<string, string> {
  const { data } = useNavConfig();
  return useMemo(() => {
    const o = (data?.config as any)?.overrides;
    if (!o || typeof o !== 'object') return {};
    return Object.fromEntries(Object.entries(o).flatMap(([id, v]: [string, any]) => (typeof v?.label === 'string' && v.label.trim() ? [[id, v.label.trim()]] : [])));
  }, [data]);
}

export function isConflict(e: unknown): boolean {
  return e instanceof ApiError && e.status === 409;
}

/**
 * Quick edits (FR-009): apply `op` to the normalized saved menu and PUT it with
 * the current revision, optimistically. A 409 (another tab saved) rolls back and
 * reloads the menu. Returns false when the edit could not start.
 */
export function useQuickNavEdit() {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (v: { next: NavConfigV1; base: string | null }) => navApi.putConfig(v.next, v.base),
    meta: { skipNavBadges: true },
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: NAV_CONFIG_KEY });
      const prev = qc.getQueryData<NavConfigResponse>(NAV_CONFIG_KEY);
      qc.setQueryData<NavConfigResponse>(NAV_CONFIG_KEY, { config: v.next as unknown as Record<string, unknown>, revision: prev?.revision ?? null });
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(NAV_CONFIG_KEY, ctx.prev);
      if (isConflict(e)) toast.error('The menu was changed in another tab. Reloaded it; try again.');
      else toast.error(`Couldn't save the menu: ${describeError(e)}`);
      void qc.invalidateQueries({ queryKey: NAV_CONFIG_KEY });
    },
    onSuccess: (r, v) => {
      const fresh: NavConfigResponse = { config: v.next as unknown as Record<string, unknown>, revision: r.revision };
      qc.setQueryData(NAV_CONFIG_KEY, fresh);
      writeCache(fresh);
    },
  });

  const apply = useCallback((op: (c: NavConfigV1) => NavConfigV1): boolean => {
    if (m.isPending) return false;
    const cur = qc.getQueryData<NavConfigResponse>(NAV_CONFIG_KEY);
    const n = normalizeNav(NAV_REGISTRY, cur?.config ?? null);
    if (n.source === 'newer') {
      toast.error('This menu was saved by a newer version of the dashboard. Reload the page to edit it.');
      return false;
    }
    const next = op(n.config);
    if (next === n.config) return false;
    m.mutate({ next, base: cur?.revision ?? null });
    return true;
  }, [m, qc]);

  return { apply, isPending: m.isPending };
}

/**
 * FR-010/FR-011: every menu counter. GET /api/nav/badges every 30 s while the tab
 * is visible (not in background tabs) and on focus, plus the approvals count
 * (spec 031, its own endpoint). Unknown sources stay null: no badge.
 */
export function useNavBadgeCounts(): BadgeCounts {
  const q = useQuery({
    queryKey: NAV_BADGES_KEY,
    queryFn: () => navApi.getBadges(takeFreshBadges()),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: 25_000,
  });
  const approvals = useApprovalsCount().data?.waiting ?? null;
  return useMemo(() => ({ ...(q.data?.counts ?? {}), approvalsWaiting: approvals }), [q.data, approvals]);
}
