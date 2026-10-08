import { createFileRoute, Link } from '@tanstack/react-router';
import { PageHeader } from '../components/ui/PageHeader';
import { useCrumbs } from '../nav/hooks';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/primitives';

export const Route = createFileRoute('/app/strategies_/new')({ component: NewStrategyPage });

/**
 * Spec 023 FR-013 phase A: no new strategy can be created (the API answers 410). The route stays so old
 * links and bookmarks land on an explanation instead of a 404.
 */
function NewStrategyPage() {
  const crumbs = useCrumbs('strategies-new');

  return (
    <div>
      <PageHeader crumbs={crumbs} title="New strategy" subtitle="Strategies are legacy" />
      <Card style={{ padding: 24, maxWidth: 640 }}>
        <EmptyState
          icon="agents"
          title="Strategies can no longer be created"
          note="Content is planned and written by agents now. Give the channel an agent and steer its series and schedule on the agent page, or migrate existing strategies on the Strategies page."
          action={
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
              <Link to="/app/agents" className="btn-primary">Open Agents</Link>
              <Link to="/app/strategies" className="link-accent">Strategies page</Link>
            </div>
          }
        />
      </Card>
    </div>
  );
}
