import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '../components/ui/PageHeader';
import { NetworkHealthView } from '../components/health/NetworkHealthView';
import { OwnerBotSection } from '../components/health/OwnerBotSection';

// Network health (spec 049 FR-005): connections, sources, budget headroom and stuck work in one place;
// below them the owner bot (spec 012 FR-007).
export const Route = createFileRoute('/app/health')({
  component: () => (
    <div>
      <PageHeader title="Network health" subtitle="Connections, sources, budget headroom and stuck work across every channel" />
      <NetworkHealthView />
      <OwnerBotSection delay={240} />
    </div>
  ),
});
