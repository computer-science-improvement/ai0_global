// The owner's approve → live confirm dialog (spec 031 FR-010): the last 14 days
// of decisions on this resource's posts (approved without edits, edited,
// rejected, expired), the posts that still wait and the choice to approve them
// as well (default yes). Agents never switch modes; only this dialog does.
// Spec 078 D4: the four decisions as a strip of tiles, Cancel is quiet, Go live stays the one danger confirm. Styles: approvals.css (appr-).

import { useState } from 'react';
import { Modal } from '../Modal';
import { StatStrip, StatTile } from '../ui/primitives';
import { describeError, toast } from '../ui/Toast';
import { useAutonomyPreview, useSwitchAutonomy } from '../../api/approvals';
import { fmtRate, switchSummary, waitingChoiceLabel } from '../../lib/approval-stats';

export function AutonomyDialog({ channel, title, onClose }: { channel: string; title?: string | null; onClose: () => void }) {
  const q = useAutonomyPreview(channel);
  const sw = useSwitchAutonomy();
  const [approveWaiting, setApproveWaiting] = useState(true);
  const p = q.data;
  const name = title || p?.title || channel;
  const clean = p ? p.waiting - p.waitingWithWarnings : 0;
  const resources = p?.byResource.length ?? 0;

  const submit = () => sw.mutate({ channel, mode: 'live', approve_waiting: approveWaiting }, {
    onSuccess: (r) => { toast.success(switchSummary(r, name)); onClose(); },
    onError: (e) => toast.error(describeError(e)),
  });

  return (
    <Modal open onClose={onClose} title={`Switch ${name} to Live`} subtitle="Agents will publish without your approval" icon="rocket">
      {q.error && <div className="callout-danger" role="alert">{describeError(q.error)}</div>}
      {!p && !q.error && <div className="appr-skeleton" aria-busy="true" />}
      {p && (
        <div className="appr-autonomy">
          <div className="text-micro appr-muted">
            Last {p.days} days in approval mode{resources > 1 ? ` · ${resources} resources of this network` : ''}
          </div>
          <StatStrip label="Decisions on this resource's posts">
            <StatTile label="Approved without edits" value={<span className="appr-v-accent">{p.stats.approvedClean}</span>} />
            <StatTile label="Edited" value={p.stats.edited} />
            <StatTile label="Rejected" value={<span className={p.stats.rejected ? 'appr-v-warning' : undefined}>{p.stats.rejected}</span>} />
            <StatTile label="Expired" value={p.stats.expired} />
          </StatStrip>
          <div className="text-micro appr-muted">
            Approved without edits: <span className="mono">{fmtRate(p.stats.cleanRate)}</span> of approved posts · approval rate <span className="mono">{fmtRate(p.stats.approvalRate)}</span>
          </div>
          {p.stats.approved + p.stats.rejected + p.stats.expired === 0 && (
            <div className="callout-warning">No decisions in the last {p.days} days — you have not reviewed any of this resource’s posts yet.</div>
          )}
          {p.waiting > 0 ? (
            <label className={`appr-check${clean ? '' : ' is-disabled'}`}>
              <input type="checkbox" checked={approveWaiting && clean > 0} disabled={clean === 0} onChange={(e) => setApproveWaiting(e.target.checked)} />
              <span className="text-body-sm">
                {waitingChoiceLabel(p.waiting, p.waitingWithWarnings)}
                <span className="text-micro appr-dim appr-block">
                  Unchecked: they keep waiting in “Posts to approve” and expire if nobody approves them.
                </span>
              </span>
            </label>
          ) : (
            <div className="text-micro appr-dim">No posts are waiting for approval.</div>
          )}
          <div className="text-micro appr-dim">
            You can switch back to approval mode at any time with one click; it applies from the next written post.
          </div>
        </div>
      )}
      <div className="modal-foot">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-danger" disabled={!p || sw.isPending} onClick={submit}>Go live</button>
      </div>
    </Modal>
  );
}
