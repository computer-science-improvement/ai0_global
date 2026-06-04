import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { AuthProvider, useAuthCtx } from '../auth/auth-context';
import { AppShell } from '../components/AppShell';

function RootShell() {
  const { me, loading } = useAuthCtx();
  if (loading) return <div className="p-8">Loading…</div>;
  if (!me) {
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      window.location.href = '/login';
      return null;
    }
    return <Outlet />;
  }
  return <AppShell />;
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: () => (
    <AuthProvider>
      <RootShell />
    </AuthProvider>
  ),
});
