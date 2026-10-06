// Legacy /app/bots route (spec 027 FR-002): redirect-only. The canonical home of
// the bots manager is Connections → Telegram → Bots.

import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/app/bots')({
  beforeLoad: () => {
    throw redirect({ to: '/app/connections', search: { section: 'telegram', tab: 'bots' }, replace: true });
  },
});
