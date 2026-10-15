// Legacy /app/strategies route (spec 023 FR-013 phase B): the strategy runtime is gone and content is run by
// agents. Redirect-only; the binding → series migration lives on /app/agents.

import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/app/strategies')({
  beforeLoad: () => {
    throw redirect({ to: '/app/agents', replace: true });
  },
});
