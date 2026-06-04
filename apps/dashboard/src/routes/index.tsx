import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '../components/ui/PageHeader';
import { Placeholder } from '../components/ui/Placeholder';

export const Route = createFileRoute('/')({ component: OverviewPage });

function OverviewPage() {
  return (
    <div>
      <PageHeader title="Огляд" subtitle="Усі платформи" />
      <Placeholder
        icon="overview"
        title="Зведення скоро"
        note="KPI, найближчі заплановані пости й останні публікації зʼявляться тут (Фаза 4)."
      />
    </div>
  );
}
