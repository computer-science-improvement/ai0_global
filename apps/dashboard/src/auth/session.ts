import { queryOptions } from '@tanstack/react-query';
import { authApi } from '../api/auth';
import type { Me } from '../api/types';

/**
 * The server's answer to "is this browser signed in" (spec 028 FR-011): the
 * `/auth/me` identity, or null plus the reason the cookie stopped working
 * (`session_expired`, `session_revoked`, `session_legacy`). The client never
 * fabricates a user — even the dev identity comes from the backend bypass.
 */
export interface SessionInfo { me: Me | null; reason: string | null }

export const SESSION_KEY = ['auth', 'session'] as const;

export const sessionQuery = queryOptions({
  queryKey: SESSION_KEY,
  queryFn: (): Promise<SessionInfo> => authApi.session(),
  staleTime: 60_000,
  retry: false,
});
