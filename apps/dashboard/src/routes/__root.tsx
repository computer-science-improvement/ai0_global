import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';

// Thin root: just an <Outlet/>. The public landing (`/`) and `/login` render here
// with NO guard. The authenticated app lives under the `/app` layout route
// (src/routes/app.tsx), whose beforeLoad checks the session against the server.
export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: () => <Outlet />,
});
