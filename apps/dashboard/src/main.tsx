import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { routeTree } from './routeTree.gen';
import { ApiError } from './api/client';
import { Toaster, describeError, toast } from './components/ui/Toast';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
  // Global error surface for every mutation (audit: mutations without onError
  // failed silently). Skipped when the mutation handles errors itself (own
  // onError, or meta.silentError for inline display) and for 401, which
  // already redirects to /login.
  mutationCache: new MutationCache({
    onError: (error, _vars, _ctx, mutation) => {
      if (mutation.options.onError || mutation.meta?.silentError) return;
      if (error instanceof ApiError && error.status === 401) return;
      toast.error(describeError(error));
    },
  }),
});

const router = createRouter({ routeTree, context: { queryClient } });

declare module '@tanstack/react-router' {
  interface Register { router: typeof router; }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>
  </StrictMode>,
);
