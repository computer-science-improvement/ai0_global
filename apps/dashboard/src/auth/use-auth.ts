import { useQuery, useQueryClient } from '@tanstack/react-query';
import { sessionQuery, SESSION_KEY } from './session';
import type { Me } from '../api/types';

/**
 * The signed-in identity — a thin hook over the `['auth','session']` query that
 * the /app route guard already loaded (spec 028 FR-011). No context provider:
 * the query cache is the single source of truth.
 */
export function useAuth(): { me: Me | null; loading: boolean; refresh: () => Promise<void> } {
  const qc = useQueryClient();
  const q = useQuery(sessionQuery);
  return {
    me: q.data?.me ?? null,
    loading: q.isPending,
    refresh: async () => { await qc.invalidateQueries({ queryKey: SESSION_KEY }); },
  };
}
