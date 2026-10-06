import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { PageHeader } from '../components/ui/PageHeader';
import { Badge } from '../components/ui/Badge';
import { Icon } from '../components/ui/Icon';
import { EmptyState, StatTile } from '../components/ui/primitives';
import { describeError } from '../components/ui/Toast';
import { SegmentedTabs } from '../components/SegmentedTabs';
import { DatasetItems } from '../components/data/DatasetItems';
import { SchemaEditor } from '../components/data/SchemaEditor';
import { ImportHistory } from '../components/data/ImportHistory';
import { ImportWizard } from '../components/data/ImportWizard';
import { fmtDate, fmtRelative } from '../lib/format';
import { DATASET_STATUS, fmtInt } from '../lib/data-store';
import { ApiError } from '../api/client';
import { useDataset, useDatasets } from '../api/data';

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

  const back = (
    <div className="text-micro" style={{ marginBottom: 10 }}>
      <Link to="/app/data" className="link-accent">← Data</Link>
    </div>
  );

  if (q.error) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return <div>{back}{notFound
      ? <EmptyState icon="database" title={`No dataset "${key}"`} note="It may have a different key. Pick one from the list." />
      : <p className="text-body-sm" style={{ color: 'var(--color-danger)' }}>{describeError(q.error)}</p>}</div>;
  }
  if (!q.data) return <div>{back}<p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Loading…</p></div>;
  const s = q.data;

  return (
    <div>
      {back}
      <PageHeader
        title={s.title}
        subtitle={s.description || 'No description yet — agents choose datasets by their description, so add one on the Schema tab.'}
        actions={
          <button type="button" className="btn-primary" disabled={s.status === 'archived'} onClick={() => setImporting(true)}>
            <Icon name="arrow-up" size={14} /> Import file
          </button>
        }
      />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '-12px 0 16px' }}>
        <Badge tone={DATASET_STATUS[s.status].tone}>{DATASET_STATUS[s.status].label}</Badge>
        <span className="chip">{s.entity}</span>
        <span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>
          <code>{s.key}</code> · version {s.version}{s.language ? ` · ${s.language}` : ''} · license {s.default_license}
          {s.contains_personal_data ? ' · personal data' : ''}{s.legacy ? ` · moved from the ${s.legacy.table} table` : ''}
        </span>
      </div>

      <div className="stat-grid" style={{ marginBottom: 18 }}>
        <StatTile label="Rows" value={fmtInt(stats?.rows ?? null)} icon="database" delta={stats && stats.rows !== stats.rows_active ? `${fmtInt(stats.rows - stats.rows_active)} hidden` : undefined} />
        <StatTile label="Unposted" value={fmtInt(stats?.unposted_network ?? null)} icon="sparkles" accent
          delta={stats?.stats_at ? `stats ${fmtRelative(stats.stats_at)}` : 'no stats yet'} />
        <StatTile label="Today" value={fmtInt(stats?.today_items ?? null)} icon="calendar" delta="rows for today's date" />
        <StatTile label="Last import" value={stats?.last_import_at ? fmtRelative(stats.last_import_at) : '—'} icon="history"
          delta={stats?.last_import_at ? fmtDate(stats.last_import_at) : undefined} />
      </div>

      <div style={{ marginBottom: 16, overflowX: 'auto' }}>
        <SegmentedTabs<Tab> value={tab} onChange={setTab} options={[
          { key: 'items', label: 'Items', icon: 'database' },
          { key: 'schema', label: 'Schema', icon: 'pencil' },
          { key: 'imports', label: 'Imports', icon: 'history' },
        ]} />
      </div>

      {tab === 'items' && <DatasetItems schema={s} />}
      {tab === 'schema' && <SchemaEditor schema={s} />}
      {tab === 'imports' && <ImportHistory schema={s.key} />}

      {importing && <ImportWizard open onClose={() => setImporting(false)} initialSchema={s.key} />}
    </div>
  );
}
