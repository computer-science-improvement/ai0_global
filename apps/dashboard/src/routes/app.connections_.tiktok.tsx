// Legacy /connections/tiktok route — now redirects into the unified Connections
// workspace (?section=tiktok), preserving the ?tiktok=connected|error banner set
// by the OAuth callback redirect. Kept so the TikTok OAuth return keeps working
// after the sidebar collapse.

import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/app/connections_/tiktok')({
  validateSearch: (s: Record<string, unknown>): { tiktok?: 'connected' | 'error' } =>
    s.tiktok === 'connected' || s.tiktok === 'error' ? { tiktok: s.tiktok } : {},
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/app/connections', search: { section: 'tiktok', tiktok: search.tiktok } });
  },
});
