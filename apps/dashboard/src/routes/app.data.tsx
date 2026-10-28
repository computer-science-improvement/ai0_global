import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { PageHeader } from '../components/ui/PageHeader';
import { Badge } from '../components/ui/Badge';
import { Icon } from '../components/ui/Icon';
import { EmptyState, SectionCard, StatStrip, StatTile } from '../components/ui/primitives';
import { ActionsTh, RowActions, TableAction } from '../components/ui/table';
import { describeError, toast } from '../components/ui/Toast';
import { SkeletonRows } from '../components/SkeletonRows';
import { ImportWizard } from '../components/data/ImportWizard';
import { ImportHistory } from '../components/data/ImportHistory';
import { fmtDate, fmtRelative } from '../lib/format';
import { DATASET_STATUS, fmtInt, summarizeDatasets } from '../lib/data-store';
import { useDatasets, useRefreshStats } from '../api/data';
import '../components/data/data.css';

export const Route = createFileRoute('/app/data')({ component: DataPage });

function DataPage() {
  const q = useDatasets();
  const refresh = useRefreshStats();
  const navigate = useNavigate();
  const [importing, setImporting] = useState<string | null>(null);
  const rows = q.data ?? [];
  const sum = summarizeDatasets(rows);

  return (
    <div>
      <PageHeader
        eyebrow={q.data ? `${sum.count} ${sum.count === 1 ? 'dataset' : 'datasets'}${sum.drafts ? ` · ${sum.drafts} in draft` : ''}` : undefined}
        title="Data"
        subtitle="Datasets the agents read from: what each one holds, its fields, rows and imports"
        actions={<>
          <button type="button" className="btn-secondary" disabled={refresh.isPending}
            onClick={() => refresh.mutate(undefined, { onSuccess: (r) => toast.success(`Stats refreshed for ${r.refreshed} datasets`), onError: (e) => toast.error(describeError(e)) })}>
            <Icon name="refresh" size={14} /> Refresh stats
          </button>
          <button type="button" className="btn-primary" onClick={() => setImporting('')}>
            <Icon name="arrow-up" size={14} /> Import file
          </button>
        </>}
      />

      {rows.length > 0 && (
        <div className="compose-rise" style={{ marginBottom: 16 }}>
          <StatStrip label="Dataset totals">
            <StatTile label="Datasets" value={fmtInt(sum.count)} delta={`${fmtInt(sum.active)} active`} />
            <StatTile label="Rows" value={fmtInt(sum.rows)} delta={sum.hidden > 0 ? `${fmtInt(sum.hidden)} hidden` : undefined} />
            <StatTile label="Unposted" value={fmtInt(sum.unposted)} delta="in the network, last stats run" />
            <StatTile label="Last import" value={sum.lastImportAt ? fmtRelative(sum.lastImportAt) : '—'}
              delta={sum.lastImportAt ? fmtDate(sum.lastImportAt) : undefined} />
          </StatStrip>
        </div>
      )}

      <SectionCard title="Datasets" delay={60}>
        {q.isLoading && <SkeletonRows rows={3} label="Loading datasets" />}
        {q.error && <div className="callout-danger" role="alert">{describeError(q.error)}</div>}
        {!q.isLoading && !q.error && rows.length === 0 && (
          <EmptyState icon="database" title="No datasets yet" note="Import a CSV, JSON or JSONL file to create the first one."
            action={<button type="button" className="btn-primary" onClick={() => setImporting('')}>Import file</button>} />
        )}
        {rows.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead><tr>
                <th>Dataset</th>
                <th>Entity</th>
                <th className="num">Rows</th>
                <th className="num" title="Active rows not yet posted anywhere in the network (from the last stats run); for datasets that repeat in rounds, rows not yet posted in the current rounds">Unposted</th>
                <th>Last import</th>
                <th>Status</th>
                <ActionsTh />
              </tr></thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.key}>
                    <td style={{ minWidth: 200 }}>
                      <Link to="/app/data/$key" params={{ key: d.key }} search={{}} className="link-accent" style={{ fontWeight: 600 }}>{d.title}</Link>
                      <div className="meta">
                        <span className="mono">{d.key}</span> · v{d.version}{d.legacy ? ' · moved from a content table' : ''}
                      </div>
                      {d.description && <div className="meta clamp" style={{ maxWidth: 420, ['--clamp' as string]: 1 }} title={d.description}>{d.description}</div>}
                    </td>
                    <td><span className="chip">{d.entity}</span></td>
                    <td className="num">
                      {fmtInt(d.rows)}
                      {d.rows !== d.rows_active && <div className="meta">{fmtInt(d.rows - d.rows_active)} hidden</div>}
                    </td>
                    <td className="num" title={d.stats_at ? `Stats from ${fmtDate(d.stats_at)}` : 'No stats yet'}>
                      {fmtInt(d.unposted_network)}
                      {d.reuse_policy.kind === 'cycle' && <div className="meta">in current rounds</div>}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }} title={d.last_import_at ? fmtDate(d.last_import_at) : undefined}>{d.last_import_at ? fmtRelative(d.last_import_at) : '—'}</td>
                    <td><Badge tone={DATASET_STATUS[d.status].tone}>{DATASET_STATUS[d.status].label}</Badge></td>
                    <td style={{ textAlign: 'right' }}>
                      <RowActions>
                        <TableAction icon="arrow-up" title="Import into this dataset" disabled={d.status === 'archived'} onClick={() => setImporting(d.key)} />
                        <TableAction action="edit" title="Edit schema" onClick={() => void navigate({ to: '/app/data/$key', params: { key: d.key }, search: { tab: 'schema' } })} />
                      </RowActions>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard title="Recent imports" delay={120} style={{ marginTop: 16 }}>
        <ImportHistory />
      </SectionCard>

      {importing !== null && (
        <ImportWizard open onClose={() => setImporting(null)} initialSchema={importing || undefined} />
      )}
    </div>
  );
}
