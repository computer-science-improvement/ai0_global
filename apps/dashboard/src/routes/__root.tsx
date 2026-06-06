import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { AuthProvider, useAuthCtx } from '../auth/auth-context';
import { AppShell } from '../components/AppShell';

function RootShell() {
  const { me, loading } = useAuthCtx();

  // /login is always full-screen — never wrapped in the app shell. Without
  // this, an authenticated (incl. dev-bypass) user landing on /login would
  // render the login card *inside* the sidebar + header chrome.
  const onLogin = typeof window !== 'undefined' && window.location.pathname.startsWith('/login');
  if (onLogin) return <Outlet />;

  if (loading) return <div className="p-8">Loading…</div>;
  if (!me) {
    if (typeof window !== 'undefined') window.location.href = '/login';
    return null;
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
