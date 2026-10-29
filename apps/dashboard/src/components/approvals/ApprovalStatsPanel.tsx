// Approval stats of a resource (spec 031 FR-011): approval rate, edit rate,
// median time to approve, expired posts and the top reject reasons, for the
// last 7 / 14 / 30 days — in total and per resource of a network. Reads
// GET /api/editor/approvals/stats (the same API the 029 Agents card reads).
// Spec 078 D4: a flush panel — the four numbers as a strip of tiles split by hairlines, then rows for the reject reasons and
// for each resource of a network. Styles: approvals.css (appr-).

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
    <SectionCard title="Approval stats" icon="analytics" flush delay={0} style={{ marginBottom: 16 }}
      action={<SegmentedTabs size="sm" value={days} onChange={setDays} options={DAY_OPTIONS} ariaLabel="Period" />}>
      {q.error && <div className="appr-pad"><div className="callout-danger" role="alert">{describeError(q.error)}</div></div>}
      {!q.data && !q.error && <div className="appr-pad"><div className="appr-skeleton" aria-busy="true" /></div>}
      {t && decided === 0 && (
        <div className="panel-row">
          <span className="text-body-sm appr-muted">
            No decisions in the last {days} days{t.waiting ? ` · ${t.waiting} waiting for approval` : ''}.
          </span>
        </div>
      )}
      {t && decided > 0 && (
        <>
          <div className="appr-numbers" role="group" aria-label={`Approval numbers, last ${days} days`}>
            <StatTile label="Approval rate" value={fmtRate(t.approvalRate)} delta={`${t.approved} approved · ${t.rejected} rejected`} />
            <StatTile label="Edit rate" value={fmtRate(t.editRate)} delta={`${t.edited} edited before approval`} />
            <StatTile label="Median time to approve" value={fmtWait(t.medianTimeToApproveSec)} delta="from writing to approval" />
            <StatTile label="Expired" value={t.expired} deltaTone={t.expired ? 'warning' : 'neutral'} delta="not approved in time" />
          </div>
          <div className="appr-label"><span className="text-overline">Top reject reasons</span></div>
          {t.topRejectReasons.length === 0 && !t.rejectedWithoutReason
            ? <div className="panel-row"><span className="text-body-sm appr-dim">No rejections.</span></div>
            : (
              <>
                {t.topRejectReasons.map((r) => (
                  <div key={r.reason} className="panel-row appr-line">
                    <span className="text-body-sm appr-line-text">{r.reason}</span>
                    <span className="text-micro mono appr-dim">× {r.count}</span>
                  </div>
                ))}
                {t.rejectedWithoutReason > 0 && (
                  <div className="panel-row appr-line"><span className="text-micro appr-dim">{t.rejectedWithoutReason} rejected without a reason</span></div>
                )}
              </>
            )}
          {q.data!.byResource.length > 1 && (
            <>
              <div className="appr-label"><span className="text-overline">By resource</span></div>
              {q.data!.byResource.map((r) => (
                <div key={r.resourceRef} className="panel-row appr-line">
                  <span className="chip mono appr-ref" title={r.resourceRef}>{r.resourceRef}</span>
                  <span className="text-micro mono appr-muted appr-line-text">
                    approval {fmtRate(r.approvalRate)} · edits {fmtRate(r.editRate)} · median {fmtWait(r.medianTimeToApproveSec)} · {r.expired} expired
                  </span>
                </div>
              ))}
            </>
          )}
        </>
      )}
    </SectionCard>
  );
}
