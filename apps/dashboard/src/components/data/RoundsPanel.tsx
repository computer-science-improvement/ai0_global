// Rounds of a dataset that repeats (spec 071): one compact card per channel — round N, how many rows are posted, the
// next row of an in-order dataset — and a "Restart round" action in the details dialog, behind a confirm.
// The panel is hidden for a dataset that does not repeat and when the server has no rounds endpoint (404).

import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { CompactCard } from '../ui/CompactCard';
import { useConfirm } from '../ui/ConfirmDialog';
import { SectionCard } from '../ui/primitives';
import { describeError, toast } from '../ui/Toast';
import { SkeletonRows } from '../SkeletonRows';
import { ApiError } from '../../api/client';
import { useDatasetRounds, useRestartRound, type DataSchema, type DatasetRounds, type RoundState } from '../../api/data';
import { fmtDate } from '../../lib/format';
import { fmtInt, reuseLabel, roundLeft, roundLine, roundPercent } from '../../lib/data-store';
import './data.css';

export function RoundsPanel({ schema }: { schema: DataSchema }) {
  const repeats = schema.reuse_policy.kind === 'cycle';
  const q = useDatasetRounds(schema.key, repeats);
  const restart = useRestartRound(schema.key);
  const confirm = useConfirm();
  if (!repeats) return null;
  if (q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 400)) return null;

  async function restartOn(r: RoundState, close: () => void) {
    const ok = await confirm(`restart the round on ${r.resource_ref}`, {
      danger: false, confirmLabel: 'Restart round',
      details: (
        <p className="dx-note">
          Round {r.round + 1} starts now: every row of {schema.title} can be posted on this channel again, including the {fmtInt(r.done)} already posted in round {r.round}.
          {schema.reuse_policy.kind === 'cycle' && schema.reuse_policy.order === 'sequential' ? ' The order starts from the first row.' : ''}
        </p>
      ),
    });
    if (!ok) return;
    restart.mutate(r.resource_ref, {
      onSuccess: (s) => { toast.success(`Round ${s.round} started on ${s.resource_ref}`); close(); },
      onError: (e) => toast.error(describeError(e)),
    });
  }

  const rounds: DatasetRounds | undefined = q.data;
  return (
    <SectionCard title={`Rounds · ${reuseLabel(schema.reuse_policy)}`} delay={0}>
      {q.error && <div className="callout-danger" role="alert">{describeError(q.error)}</div>}
      {q.isLoading && <SkeletonRows rows={2} height={84} label="Loading rounds" />}
      {rounds && rounds.resources.length === 0 && (
        <p className="dx-note">
          No channel has posted from this dataset yet. A channel appears here after its first post, and starts at round 1.
        </p>
      )}
      {rounds && rounds.resources.length > 0 && (
        <div className="compact-grid">
          {rounds.resources.map((r, i) => (
            <CompactCard key={r.resource_ref} delay={Math.min(i, 12) * 25} hint="Open the round" lines={2}
              top={<><Badge tone="accent">Round {r.round}</Badge>{r.waiting > 0 && <Badge tone="warning">{fmtInt(r.waiting)} waiting</Badge>}</>}
              meta={`${roundPercent(r)}%`}
              title={r.resource_ref}
              body={<>{roundLine(r)}. {roundLeft(r)}.</>}
              extra={<span className="dx-bar" aria-hidden="true"><span className="anim-grow-x" style={{ width: `${roundPercent(r)}%` }} /></span>}
              dialog={{
                size: 'md', icon: 'refresh', title: r.resource_ref, subtitle: `Round ${r.round} of ${schema.title}`,
                body: () => <RoundDetails r={r} data={rounds} />,
                actions: (close) => (
                  <button type="button" className="btn-secondary" disabled={restart.isPending} style={{ marginLeft: 'auto' }}
                    onClick={() => void restartOn(r, close)}>
                    <Icon name="reset" size={14} /> Restart round
                  </button>
                ),
              }} />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function RoundDetails({ r, data }: { r: RoundState; data: DatasetRounds }) {
  const rows: Array<[string, string]> = [
    ['Round', String(r.round)],
    ['Started', r.started_at ? fmtDate(r.started_at) : 'the first round has no start'],
    ['Posted', `${fmtInt(r.done)} of ${fmtInt(r.total)}`],
    ['Left', roundLeft(r)],
    ['Order', data.order === 'sequential' ? `In order${data.order_by.length ? ` (by ${data.order_by.join(', then ')})` : ' (import order)'}` : 'Random'],
    ...(data.order === 'sequential' ? [['Next row', r.next ?? 'none left in this round'] as [string, string]] : []),
  ];
  return (
    <div className="dx-col" style={{ gap: 12 }}>
      <dl className="dx-facts inset">
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt className="text-overline">{k}</dt>
            <dd>{k === 'Next row' && r.next ? <span className="mono">{r.next}</span> : v}</dd>
          </div>
        ))}
      </dl>
      <p className="dx-note is-sm">
        The round rolls on its own when the last open row is posted. Restart it only to start over before that.
      </p>
    </div>
  );
}
