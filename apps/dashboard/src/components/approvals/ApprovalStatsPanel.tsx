// Approval stats of a resource (spec 031 FR-011): approval rate, edit rate,
// median time to approve, expired posts and the top reject reasons, for the
// last 7 / 14 / 30 days — in total and per resource of a network. Reads
// GET /api/editor/approvals/stats (the same API the 029 Agents card reads).

import { useState } from 'react';
import { SectionCard, StatTile } from '../ui/primitives';
import { describeError } from '../ui/Toast';
import { SegmentedTabs } from '../SegmentedTabs';
import { useApprovalStats } from '../../api/approvals';
import { fmtRate, fmtWait } from '../../lib/approval-stats';

type Days = '7' | '14' | '30';
const DAY_OPTIONS = [
  { key: '7' as const, label: '7 days' },
  { key: '14' as const, label: '14 days' },
  { key: '30' as const, label: '30 days' },
];

export function ApprovalStatsPanel({ channel }: { channel: string }) {
  const [days, setDays] = useState<Days>('14');
  const q = useApprovalStats({ channel, days: Number(days) });
  const t = q.data?.totals;
  const decided = t ? t.approved + t.rejected + t.expired : 0;

  return (
    <SectionCard title="Approval stats" icon="analytics" delay={0} style={{ marginBottom: 16 }}
      action={<SegmentedTabs size="sm" value={days} onChange={setDays} options={DAY_OPTIONS} />}>
      {q.error && <div className="callout-danger">{describeError(q.error)}</div>}
      {!q.data && !q.error && <div className="panel" style={{ height: 96, opacity: 0.55 }} />}
      {t && decided === 0 && (
        <div className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>
          No decisions in the last {days} days{t.waiting ? ` · ${t.waiting} waiting for approval` : ''}.
        </div>
      )}
      {t && decided > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
            <StatTile label="Approval rate" value={fmtRate(t.approvalRate)} icon="check" accent
              delta={`${t.approved} approved · ${t.rejected} rejected`} />
            <StatTile label="Edit rate" value={fmtRate(t.editRate)} icon="pencil" delta={`${t.edited} edited before approval`} />
            <StatTile label="Median time to approve" value={fmtWait(t.medianTimeToApproveSec)} icon="clock" delta="from writing to approval" />
            <StatTile label="Expired" value={t.expired} icon="ban" deltaTone={t.expired ? 'warning' : 'neutral'} delta="not approved in time" />
          </div>
          <div>
            <div className="text-eyebrow" style={{ marginBottom: 6 }}>Top reject reasons</div>
            {t.topRejectReasons.length === 0 && !t.rejectedWithoutReason
              ? <div className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>No rejections.</div>
              : (
                <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {t.topRejectReasons.map((r) => (
                    <li key={r.reason} className="text-body-sm" style={{ overflowWrap: 'anywhere' }}>
                      {r.reason} <span className="text-micro tabular-nums" style={{ color: 'var(--color-ink-dim)' }}>× {r.count}</span>
                    </li>
                  ))}
                  {t.rejectedWithoutReason > 0 && (
                    <li className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{t.rejectedWithoutReason} rejected without a reason</li>
                  )}
                </ul>
              )}
          </div>
          {q.data!.byResource.length > 1 && (
            <div>
              <div className="text-eyebrow" style={{ marginBottom: 6 }}>By resource</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {q.data!.byResource.map((r) => (
                  <div key={r.resourceRef} className="text-body-sm" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
                    <span className="chip" style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.resourceRef}</span>
                    <span className="text-micro tabular-nums" style={{ color: 'var(--color-ink-muted)' }}>
                      approval {fmtRate(r.approvalRate)} · edits {fmtRate(r.editRate)} · median {fmtWait(r.medianTimeToApproveSec)} · {r.expired} expired
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </SectionCard>
  );
}
