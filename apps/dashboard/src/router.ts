import { createRouter } from '@tanstack/react-router';
import { MutationCache, QueryClient } from '@tanstack/react-query';
import { routeTree } from './routeTree.gen';
import { ApiError, setUnauthorizedHandler } from './api/client';
import { describeError, toast } from './components/ui/Toast';
import { SESSION_KEY, type SessionInfo } from './auth/session';
import { createUnauthorizedHandler } from './auth/unauthorized';

const is401 = (e: unknown) => e instanceof ApiError && e.status === 401;

/** The app's single QueryClient (also the router context). */
export const queryClient = new QueryClient({
  // No retry on 401: the session is gone, retrying only multiplies the noise.
  defaultOptions: { queries: { staleTime: 30_000, retry: (n, e) => !is401(e) && n < 1 } },
  // Global error surface for every mutation (audit: mutations without onError
  // failed silently). Skipped when the mutation handles errors itself (own
  // onError, or meta.silentError for inline display) and for 401, which
  // already redirects to /login.
  mutationCache: new MutationCache({
    onError: (error, _vars, _ctx, mutation) => {
      if (mutation.options.onError || mutation.meta?.silentError) return;
      if (is401(error)) return;
      toast.error(describeError(error));
    },
  }),
});

/** The app's single router; `api()` reaches it through the 401 handler below. */
export const router = createRouter({
  routeTree,
  context: { queryClient },
  // A cold session check shows the /app pendingComponent after 200 ms.
  defaultPendingMs: 200,
});

declare module '@tanstack/react-router' {
  interface Register { router: typeof router; }
}

// Spec 028 FR-012: a 401 anywhere forgets the session and makes ONE router
// navigation to /login (no full reload), keeping where the user was.
setUnauthorizedHandler(createUnauthorizedHandler({
  resetSession: (reason) => queryClient.setQueryData<SessionInfo>(SESSION_KEY, { me: null, reason }),
  navigateToLogin: (search) => router.navigate({ to: '/login', search }),
  currentHref: () => router.state.location.href,
}));
