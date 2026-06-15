// TikTok connections page — lives at /connections/tiktok as a ROOT-level route
// (filename `connections_.tiktok`), so the static path wins over the generic
// /connections/$platform placeholder. Reads ?tiktok=connected|error set by the
// OAuth callback redirect to show a result banner.

import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '../components/ui/PageHeader';
import { TikTokAccountsManager } from '../components/connections/TikTokAccountsManager';

interface Search { tiktok?: 'connected' | 'error'; }

export const Route = createFileRoute('/app/connections_/tiktok')({
  validateSearch: (s: Record<string, unknown>): Search =>
    (s.tiktok === 'connected' || s.tiktok === 'error') ? { tiktok: s.tiktok } : {},
  component: TikTokConnectionsPage,
});

function TikTokConnectionsPage() {
  const { tiktok } = Route.useSearch();
  return (
    <div>
      <PageHeader title="Connections · TikTok" subtitle="Connect a TikTok creator account for carousels" />
      <TikTokAccountsManager notice={tiktok} />
    </div>
  );
}
