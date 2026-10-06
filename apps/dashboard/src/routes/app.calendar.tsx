// Legacy /app/calendar route (spec 027 FR-002): the "Calendar soon" stub is gone;
// scheduled posts live on /app/scheduled. Redirect-only.

import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/app/calendar')({
  beforeLoad: () => {
    throw redirect({ to: '/app/scheduled', replace: true });
  },
});
