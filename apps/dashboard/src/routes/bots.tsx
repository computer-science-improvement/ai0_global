import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '../components/ui/PageHeader';
import { BotsManager } from '../components/connections/BotsManager';

// Standalone bots route kept for deep links; the canonical home is the
// unified /connections page (Telegram tab).
export const Route = createFileRoute('/bots')({ component: BotsPage });

function BotsPage() {
  return (
    <div>
      <PageHeader title="Bots" subtitle="Telegram-боти, що публікують від вашого імені" />
      <BotsManager />
    </div>
  );
}
