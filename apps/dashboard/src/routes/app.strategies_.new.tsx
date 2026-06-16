import { createFileRoute, useNavigate, Link } from '@tanstack/react-router';
import { PageHeader } from '../components/ui/PageHeader';
import { Card } from '../components/ui/Card';
import { StrategyForm } from '../components/StrategyForm';

export const Route = createFileRoute('/app/strategies_/new')({ component: NewStrategyPage });

function NewStrategyPage() {
  const navigate = useNavigate();
  const back = () => navigate({ to: '/app/strategies' });

  return (
    <div>
      <Link to={'/app/strategies' as never} className="link-accent text-body-sm" style={{ display: 'inline-block', marginBottom: 16 }}>
        ← Back to strategies
      </Link>
      <PageHeader
        title="New strategy"
        subtitle="Cron-scheduled content generator bound to a channel or account. Starts paused — enable it when ready to publish."
      />
      <Card style={{ padding: 24, maxWidth: 640 }}>
        <StrategyForm onCreated={back} onCancel={back} />
      </Card>
    </div>
  );
}
