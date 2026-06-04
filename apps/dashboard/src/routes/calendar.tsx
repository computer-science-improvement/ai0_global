import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '../components/ui/PageHeader';
import { Placeholder } from '../components/ui/Placeholder';

export const Route = createFileRoute('/calendar')({ component: () => (
  <div>
    <PageHeader title="Календар / черга" subtitle="Планування публікацій" />
    <Placeholder icon="calendar" title="Календар скоро" note="Черга та календар запланованих постів." />
  </div>
)});
