// Import history with undo (spec 032 FR-006/FR-007). Undo deletes the rows the import added that were
// never published, hides the ones that were, and restores the rows it updated.

import { Link } from '@tanstack/react-router';
import { Badge } from '../ui/Badge';
import { EmptyState, type Tone } from '../ui/primitives';
import { ActionsTh, RowActions, TableAction } from '../ui/table';
import { useConfirm } from '../ui/ConfirmDialog';
import { describeError, toast } from '../ui/Toast';
import { SkeletonRows } from '../SkeletonRows';
import { fmtDate } from '../../lib/format';
import { fmtInt } from '../../lib/data-store';
import { useImports, useUndoImport, type ImportRecord, type ImportStatus } from '../../api/data';
import './data.css';

// Imports are their own domain (not a slot or a publication), so their tones are not in lib/status-tone.ts.
const STATUS: Record<ImportStatus, { label: string; tone: Tone }> = {
  committed: { label: 'Imported', tone: 'success' },
  dry_run:   { label: 'Dry run', tone: 'neutral' },
  running:   { label: 'Running', tone: 'warning' },
  failed:    { label: 'Failed', tone: 'danger' },
  undone:    { label: 'Undone', tone: 'neutral' },
  expired:   { label: 'Expired', tone: 'neutral' },
};

const SOURCE: Record<ImportRecord['source'], string> = { csv: 'CSV', json: 'JSON', jsonl: 'JSONL', pipeline: 'Pipeline', api: 'API' };

export function ImportHistory({ schema, showDataset = !schema }: { schema?: string; showDataset?: boolean }) {
  const q = useImports(schema);
  const undo = useUndoImport();
  const confirm = useConfirm();
  const rows = (q.data ?? []).filter((r) => r.status !== 'dry_run' && r.status !== 'expired');

  async function onUndo(r: ImportRecord) {
    const ok = await confirm(`undo the import of ${r.filename ?? SOURCE[r.source]} into ${r.schema}`, {
      danger: true, confirmLabel: 'Undo import',
      details: (
        <p className="dx-note">
          Rows this import added are deleted unless they were already published (those are hidden instead).
          Rows it updated go back to their previous values.
        </p>
      ),
    });
    if (!ok) return;
    undo.mutate(r.id, {
      onSuccess: (res) => toast.success(`Undone: ${res.deleted} deleted, ${res.hidden} hidden, ${res.restored} restored`),
      onError: (e) => toast.error(describeError(e)),
    });
  }

  if (q.isLoading) return <SkeletonRows rows={2} height={44} label="Loading imports" />;
  if (q.error) return <div className="callout-danger" role="alert">{describeError(q.error)}</div>;
  if (!rows.length) return <EmptyState icon="history" title="No imports yet" note="Imported files and rows sent by scripts show up here, with an undo." />;

  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr>
          <th>When</th>
          {showDataset && <th>Dataset</th>}
          <th>Source</th>
          <th className="num">Rows</th>
          <th className="num">New</th>
          <th className="num">Updated</th>
          <th className="num">Invalid</th>
          <th>Status</th>
          <ActionsTh />
        </tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.created_at)}</td>
              {showDataset && (
                <td><Link to="/app/data/$key" params={{ key: r.schema }} className="link-accent">{r.schema}</Link></td>
              )}
              <td>
                <div>{SOURCE[r.source]}</div>
                {r.filename && <div className="meta clamp" style={{ maxWidth: 220, ['--clamp' as string]: 1 }} title={r.filename}>{r.filename}</div>}
              </td>
              <td className="num">{fmtInt(r.rows_total)}</td>
              <td className="num">{fmtInt(r.inserted)}</td>
              <td className="num">{fmtInt(r.updated)}</td>
              <td className="num">{r.invalid ? <span className="dx-warn">{fmtInt(r.invalid)}</span> : '0'}</td>
              <td>
                <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                {r.status === 'undone' && r.undo_report && (
                  <div className="meta" style={{ marginTop: 4 }}>
                    {r.undo_report.deleted ?? 0} deleted · {r.undo_report.hidden ?? 0} hidden · {r.undo_report.restored ?? 0} restored
                  </div>
                )}
              </td>
              <td style={{ textAlign: 'right' }}>
                <RowActions danger={r.status === 'committed'
                  ? <TableAction icon="history" danger title="Undo import" disabled={undo.isPending} onClick={() => void onUndo(r)} />
                  : undefined}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
