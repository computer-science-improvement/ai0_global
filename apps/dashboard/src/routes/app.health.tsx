import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '../components/ui/PageHeader';
import { NetworkHealthView } from '../components/health/NetworkHealthView';
import { DigestSection } from '../components/health/DigestSection';
import { OwnerBotSection } from '../components/health/OwnerBotSection';
import { useNetworkHealth } from '../api/health';
import { fmtRelative } from '../lib/format';

// Network health (spec 049 FR-005): connections, sources, budget headroom and stuck work in one place;
// below them the owner bot (spec 012 FR-007).
export const Route = createFileRoute('/app/health')({ component: HealthPage });

function HealthPage() {
  // The same query as NetworkHealthView (one cache entry): the eyebrow says how the network is doing.
  const h = useNetworkHealth().data;
  const eyebrow = h
    ? `${h.problems ? `${h.problems} thing${h.problems === 1 ? '' : 's'} need${h.problems === 1 ? 's' : ''} attention` : 'All clear'} · updated ${fmtRelative(h.generatedAt)}`
    : 'Insights';
  return (
    <div>
      <PageHeader eyebrow={eyebrow} title="Network health" subtitle="Connections, sources, budget headroom and stuck work across every channel" />
      <NetworkHealthView />
      {/* Its own endpoint: the digest shows even when the health checks above could not load. */}
      <DigestSection delay={210} />
      <OwnerBotSection delay={240} />
    </div>
  );
}
