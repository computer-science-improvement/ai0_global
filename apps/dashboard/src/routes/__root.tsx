import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { AuthProvider } from '../auth/auth-context';

// Thin root: just provides auth context + an <Outlet/>. The public landing (`/`)
// and `/login` render here with NO guard. The authenticated app lives under the
// `/app` layout route (src/routes/app.tsx), which owns the guard + AppShell.
export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: () => (
    <AuthProvider>
      <Outlet />
    </AuthProvider>
  ),
});
