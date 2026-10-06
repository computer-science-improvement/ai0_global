// Legacy /app/telegraph route (spec 027 FR-002): redirect-only. The canonical
// home of the Telegraph accounts is Connections → Telegram → Telegraph.

import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/app/telegraph')({
  beforeLoad: () => {
    throw redirect({ to: '/app/connections', search: { section: 'telegram', tab: 'telegraph' }, replace: true });
  },
});
