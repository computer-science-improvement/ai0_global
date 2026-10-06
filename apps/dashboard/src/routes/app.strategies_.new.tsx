import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { PageHeader } from '../components/ui/PageHeader';
import { useCrumbs } from '../nav/hooks';
import { Card } from '../components/ui/Card';
import { StrategyForm } from '../components/StrategyForm';

export const Route = createFileRoute('/app/strategies_/new')({ component: NewStrategyPage });

function NewStrategyPage() {
  const navigate = useNavigate();
  const back = () => navigate({ to: '/app/strategies' });
  const crumbs = useCrumbs('strategies-new');

  return (
    <div>
      <PageHeader
        crumbs={crumbs}
        title="New strategy"
        subtitle="Cron-scheduled content generator bound to a channel or account. Starts paused — enable it when ready to publish."
      />
      <Card style={{ padding: 24, maxWidth: 640 }}>
        <StrategyForm onCreated={back} onCancel={back} />
      </Card>
    </div>
  );
}
