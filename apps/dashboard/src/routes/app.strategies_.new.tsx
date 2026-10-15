// Legacy /app/strategies/new route (spec 023 FR-013 phase B): redirect-only, see app.strategies.tsx.

import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/app/strategies_/new')({
  beforeLoad: () => {
    throw redirect({ to: '/app/agents', replace: true });
  },
});
