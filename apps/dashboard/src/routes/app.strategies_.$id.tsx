// Legacy /app/strategies/$id route (spec 023 FR-013 phase B): redirect-only, see app.strategies.tsx.

import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/app/strategies_/$id')({
  beforeLoad: () => {
    throw redirect({ to: '/app/agents', replace: true });
  },
});
