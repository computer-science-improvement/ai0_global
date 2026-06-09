import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '../components/ui/PageHeader';
import { TelegraphManager } from '../components/connections/TelegraphManager';

// Standalone Telegraph route kept for deep links; the canonical home is the
// unified /connections page (Telegraph tab).
export const Route = createFileRoute('/telegraph')({ component: TelegraphPage });

function TelegraphPage() {
  return (
    <div>
      <PageHeader title="Telegraph" subtitle="telegra.ph accounts for long-form posts with Instant View" />
      <TelegraphManager />
    </div>
  );
}
