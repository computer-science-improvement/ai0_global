// The owner's approve → live confirm dialog (spec 031 FR-010): the last 14 days
// of decisions on this resource's posts (approved without edits, edited,
// rejected, expired), the posts that still wait and the choice to approve them
// as well (default yes). Agents never switch modes; only this dialog does.

import { useState } from 'react';
import { Modal } from '../Modal';
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

  const tile = (label: string, value: number, tone?: string) => (
    <div style={{ padding: '10px 12px', background: 'var(--color-surface-1)', border: '1px solid var(--color-hairline-soft)', borderRadius: 'var(--radius-md)' }}>
      <div className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{label}</div>
      <div className="tabular-nums" style={{ fontSize: 22, fontWeight: 600, color: tone ?? 'var(--color-ink)' }}>{value}</div>
    </div>
  );

  return (
    <Modal open onClose={onClose} title={`Switch ${name} to Live`} subtitle="Agents will publish without your approval" icon="rocket">
      {q.error && <div className="callout-danger">{describeError(q.error)}</div>}
      {!p && !q.error && <div className="panel" style={{ height: 120, opacity: 0.55 }} />}
      {p && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>
            Last {p.days} days in approval mode{resources > 1 ? ` · ${resources} resources of this network` : ''}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 }}>
            {tile('Approved without edits', p.stats.approvedClean, 'var(--color-accent)')}
            {tile('Edited', p.stats.edited)}
            {tile('Rejected', p.stats.rejected, p.stats.rejected ? 'var(--color-warning)' : undefined)}
            {tile('Expired', p.stats.expired)}
          </div>
          <div className="text-micro" style={{ color: 'var(--color-ink-muted)' }}>
            Approved without edits: {fmtRate(p.stats.cleanRate)} of approved posts · approval rate {fmtRate(p.stats.approvalRate)}
          </div>
          {p.stats.approved + p.stats.rejected + p.stats.expired === 0 && (
            <div className="callout-warning">No decisions in the last {p.days} days — you have not reviewed any of this resource’s posts yet.</div>
          )}
          {p.waiting > 0 ? (
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: clean ? 'pointer' : 'default' }}>
              <input type="checkbox" checked={approveWaiting && clean > 0} disabled={clean === 0} onChange={(e) => setApproveWaiting(e.target.checked)} style={{ marginTop: 3 }} />
              <span className="text-body-sm">
                {waitingChoiceLabel(p.waiting, p.waitingWithWarnings)}
                <span className="text-micro" style={{ display: 'block', color: 'var(--color-ink-dim)' }}>
                  Unchecked: they keep waiting in “Posts to approve” and expire if nobody approves them.
                </span>
              </span>
            </label>
          ) : (
            <div className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>No posts are waiting for approval.</div>
          )}
          <div className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>
            You can switch back to approval mode at any time with one click; it applies from the next written post.
          </div>
        </div>
      )}
      <div className="modal-foot">
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-danger" disabled={!p || sw.isPending} onClick={submit}>Go live</button>
      </div>
    </Modal>
  );
}
