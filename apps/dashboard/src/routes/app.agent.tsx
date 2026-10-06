// Legacy /app/agent route (spec 027 FR-002): the DM triage page is now "DM inbox"
// at /app/dm. Redirect-only; every search param survives (e.g. ?cat=ad).

import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/app/agent')({
  validateSearch: (s: Record<string, unknown>): Record<string, unknown> => s,
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/app/dm', search: search as never, replace: true });
  },
});
