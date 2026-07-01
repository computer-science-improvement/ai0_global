// Legacy /connections/meta route — now redirects into the unified Connections
// workspace (?section=meta), preserving the ?tab=facebook|instagram|threads
// deep link. Kept so existing bookmarks keep working after the sidebar collapse.

import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/app/connections_/meta')({
  validateSearch: (s: Record<string, unknown>): { tab?: string } => ({
    tab: typeof s.tab === 'string' ? s.tab : undefined,
  }),
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/app/connections', search: { section: 'meta', tab: search.tab } });
  },
});
