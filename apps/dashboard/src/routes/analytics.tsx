import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '../components/ui/PageHeader';
import { Placeholder } from '../components/ui/Placeholder';

export const Route = createFileRoute('/analytics')({ component: () => (
  <div>
    <PageHeader title="Статистика" subtitle="Крос-платформна аналітика" />
    <Placeholder icon="analytics" title="Аналітика скоро" note="Зведемо графіки підписників, переглядів, залученості та ROI (Фаза 5)." />
  </div>
)});
