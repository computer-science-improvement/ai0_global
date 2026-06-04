import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '../components/ui/PageHeader';
import { Placeholder } from '../components/ui/Placeholder';

export const Route = createFileRoute('/settings')({ component: () => (
  <div>
    <PageHeader title="Налаштування" />
    <Placeholder icon="settings" title="Налаштування скоро" note="Профіль, доступи, глобальні параметри." />
  </div>
)});
