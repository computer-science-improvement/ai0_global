import { createFileRoute } from '@tanstack/react-router';
import { useAuthCtx } from '../auth/auth-context';
import { AppShell } from '../components/AppShell';

// Layout route for the entire authenticated app (everything under /app). Owns the
// auth guard that previously lived in __root's RootShell. AppShell renders the
// sidebar + header and an <Outlet/> for the nested /app/* pages.
function AppLayout() {
  const { me, loading } = useAuthCtx();
  if (loading) return <div className="p-8">Loading…</div>;
  if (!me) {
    if (typeof window !== 'undefined') window.location.href = '/login';
    return null;
  }
  return <AppShell />;
}

export const Route = createFileRoute('/app')({ component: AppLayout });
