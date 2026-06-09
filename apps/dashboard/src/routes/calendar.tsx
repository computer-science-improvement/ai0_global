import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '../components/ui/PageHeader';
import { Placeholder } from '../components/ui/Placeholder';

export const Route = createFileRoute('/calendar')({ component: () => (
  <div>
    <PageHeader title="Calendar / queue" subtitle="Scheduling publications" />
    <Placeholder icon="calendar" title="Calendar soon" note="Queue and calendar of scheduled posts." />
  </div>
)});
