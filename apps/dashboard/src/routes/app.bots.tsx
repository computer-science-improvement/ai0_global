import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '../components/ui/PageHeader';
import { BotsManager } from '../components/connections/BotsManager';

// Standalone bots route kept for deep links; the canonical home is the
// unified /connections page (Telegram tab).
export const Route = createFileRoute('/app/bots')({ component: BotsPage });

function BotsPage() {
  return (
    <div>
      <PageHeader title="Bots" subtitle="Telegram bots that publish on your behalf" />
      <BotsManager />
    </div>
  );
}
