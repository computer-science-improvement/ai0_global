import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '../components/ui/PageHeader';
import { parseSpendSearch } from '../lib/spend-search';

export const Route = createFileRoute('/app/spend')({
  validateSearch: parseSpendSearch,
  component: SpendPage,
});

function SpendPage() {
  return <PageHeader title="AI spend" subtitle="Tokens and money across every LLM call" />;
}
