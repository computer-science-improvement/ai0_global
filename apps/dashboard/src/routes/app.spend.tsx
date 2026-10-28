import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { PageHeader } from '../components/ui/PageHeader';
import { SegmentedTabs } from '../components/SegmentedTabs';
import { SpendReport } from '../components/spend/SpendReport';
import { PricesTab } from '../components/spend/PricesTab';
import { BudgetsTab } from '../components/spend/BudgetsTab';
import '../components/spend/spend.css';
import { useBudgets } from '../api/spend';
import { dayEyebrow } from '../lib/day-groups';
import { kyivToday } from '../lib/spend';
import { parseSpendSearch, type SpendSearch, type SpendTab } from '../lib/spend-search';

// AI spend (spec 029 FR-010): tokens and money across every LLM call — report,
// price table and blocking caps. All state lives in the URL (?tab, ?range, …).
export const Route = createFileRoute('/app/spend')({
  validateSearch: parseSpendSearch,
  component: SpendPage,
});

function SpendPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const tab: SpendTab = search.tab ?? 'report';
  const blocking = useBudgets().data?.blocking.length ?? 0;
  const setSearch = (patch: Partial<SpendSearch>) => navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });

  return (
    <div>
      <PageHeader eyebrow={dayEyebrow(kyivToday())} title="AI spend" subtitle="Tokens and USD across every LLM call: agents, strategies, DM triage, ROI, dedup, routing" />
      <div style={{ marginBottom: 16 }}>
        {/* A blocking cap is the one thing on this page that needs the owner: its count rides on the Budgets tab. */}
        <SegmentedTabs variant="underline" ariaLabel="AI spend sections" value={tab} onChange={(t) => setSearch({ tab: t === 'report' ? undefined : t })}
          options={[
            { key: 'report', label: 'Report', icon: 'analytics' },
            { key: 'prices', label: 'Prices', icon: 'spend' },
            { key: 'budgets', label: 'Budgets', icon: blocking ? 'ban' : 'lock', count: blocking || undefined },
          ]} />
      </div>
      {tab === 'report' && <SpendReport search={search} setSearch={setSearch} />}
      {tab === 'prices' && <PricesTab />}
      {tab === 'budgets' && <BudgetsTab />}
    </div>
  );
}
