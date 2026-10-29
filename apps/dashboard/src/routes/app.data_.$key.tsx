import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { PageHeader } from '../components/ui/PageHeader';
import { Crumbs } from '../components/ui/Crumbs';
import { useCrumbs } from '../nav/hooks';
import { Badge } from '../components/ui/Badge';
import { Icon } from '../components/ui/Icon';
import { EmptyState, SectionCard, StatStrip, StatTile } from '../components/ui/primitives';
import { describeError } from '../components/ui/Toast';
import { SegmentedTabs } from '../components/SegmentedTabs';
import { SkeletonRows } from '../components/SkeletonRows';
import { DatasetItems } from '../components/data/DatasetItems';
import { SchemaEditor } from '../components/data/SchemaEditor';
import { ImportHistory } from '../components/data/ImportHistory';
import { ImportWizard } from '../components/data/ImportWizard';
import { DataSuggestions } from '../components/data/DataSuggestions';
import { RoundsPanel } from '../components/data/RoundsPanel';
import { fmtDate, fmtRelative } from '../lib/format';
import { DATASET_STATUS, fmtInt } from '../lib/data-store';
import { ApiError } from '../api/client';
import { useDataset, useDatasets } from '../api/data';
import '../components/data/data.css';

const TABS = ['items', 'schema', 'imports'] as const;
type Tab = typeof TABS[number];

export const Route = createFileRoute('/app/data_/$key')({
  validateSearch: (s: Record<string, unknown>): { tab?: Tab } => ({
    tab: (TABS as readonly string[]).includes(String(s.tab)) ? (s.tab as Tab) : undefined,
  }),
  component: DatasetPage,
});

function DatasetPage() {
  const { key } = Route.useParams();
  const { tab = 'items' } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const q = useDataset(key);
  const list = useDatasets();
  const stats = list.data?.find((d) => d.key === key);
  const [importing, setImporting] = useState(false);
  const setTab = (t: Tab) => void navigate({ search: { tab: t === 'items' ? undefined : t }, replace: true });

  // Spec 027 FR-013: breadcrumbs instead of the ad-hoc back link.
  const crumbs = useCrumbs('dataset');
  const back = <Crumbs crumbs={crumbs} />;

  if (q.error) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return <div>{back}{notFound
      ? <EmptyState icon="database" title={`No dataset "${key}"`} note="It may have a different key. Pick one from the list." />
      : <div className="callout-danger" role="alert">{describeError(q.error)}</div>}</div>;
  }
  if (!q.data) return <div>{back}<SkeletonRows rows={3} label="Loading dataset" /></div>;
  const s = q.data;

  return (
    <div>
      {back}
      <PageHeader
        title={s.title}
        subtitle={<>
          {s.description || 'No description yet — agents choose datasets by their description, so add one on the Schema tab.'}
          <span className="dx-meta">
            <Badge tone={DATASET_STATUS[s.status].tone}>{DATASET_STATUS[s.status].label}</Badge>
            <span className="chip">{s.entity}</span>
            <span className="mono text-micro dx-dim">
              {s.key} · v{s.version}{s.language ? ` · ${s.language}` : ''} · license {s.default_license}
              {s.contains_personal_data ? ' · personal data' : ''}{s.legacy ? ` · moved from the ${s.legacy.table} table` : ''}
            </span>
          </span>
        </>}
        actions={
          <button type="button" className="btn-primary" disabled={s.status === 'archived'} onClick={() => setImporting(true)}>
            <Icon name="arrow-up" size={14} /> Import file
          </button>
        }
      />

      <div className="compose-rise" style={{ marginBottom: 20 }}>
        <StatStrip label="Dataset numbers">
          <StatTile label="Rows" value={fmtInt(stats?.rows ?? null)}
            delta={stats && stats.rows !== stats.rows_active ? `${fmtInt(stats.rows - stats.rows_active)} hidden` : undefined} />
          <StatTile label="Unposted" value={fmtInt(stats?.unposted_network ?? null)}
            delta={`${s.reuse_policy.kind === 'cycle' ? 'in current rounds · ' : ''}${stats?.stats_at ? `stats ${fmtRelative(stats.stats_at)}` : 'no stats yet'}`} />
          <StatTile label="Today" value={fmtInt(stats?.today_items ?? null)} delta="rows for today's date" />
          <StatTile label="Last import" value={stats?.last_import_at ? fmtRelative(stats.last_import_at) : '—'}
            delta={stats?.last_import_at ? fmtDate(stats.last_import_at) : undefined} />
        </StatStrip>
      </div>

      <div style={{ marginBottom: 20 }}>
        <SegmentedTabs<Tab> variant="underline" ariaLabel="Dataset sections" value={tab} onChange={setTab} options={[
          { key: 'items', label: 'Items', icon: 'database' },
          { key: 'schema', label: 'Schema', icon: 'pencil' },
          { key: 'imports', label: 'Imports', icon: 'history' },
        ]} />
      </div>

      <div key={tab} className="anim-fade-up">
        {tab === 'items' && <div className="dx-stack">
          <RoundsPanel schema={s} />
          <DatasetItems schema={s} />
        </div>}
        {tab === 'schema' && <SchemaEditor schema={s}><DataSuggestions schema={s.key} /></SchemaEditor>}
        {tab === 'imports' && <SectionCard title="Imports"><ImportHistory schema={s.key} /></SectionCard>}
      </div>

      {importing && <ImportWizard open onClose={() => setImporting(false)} initialSchema={s.key} />}
    </div>
  );
}
