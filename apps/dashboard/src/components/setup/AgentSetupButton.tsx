import { useState } from 'react';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { useConfirm } from '../ui/ConfirmDialog';
import { describeError, toast } from '../ui/Toast';
import { useAnalyzeChannels, useChannelProposals, useSetupOverview } from '../../api/channel-setup';
import { estimateText, isReviewable, isRunning, SETUP_STATUS } from '../../lib/channel-setup';
import { SetupProposalDialog } from './SetupProposalDialog';

// Spec 042: "Set up from history" on a channel agent's page — starts the analysis of the channel's last 20 posts,
// or opens the proposal waiting for review; the badge shows the latest proposal's state.
export function AgentSetupButton({ channelKey }: { channelKey: string }) {
  const q = useChannelProposals(channelKey);
  const overview = useSetupOverview();
  const analyze = useAnalyzeChannels();
  const confirm = useConfirm();
  const [open, setOpen] = useState<string | null>(null);
  const latest = q.data?.proposals.find((p) => p.status !== 'superseded') ?? null;
  const running = isRunning(latest?.status);
  const review = latest && (isReviewable(latest.status) || running) ? latest : null;

  const start = async () => {
    if (!(await confirm(`analyze the last 20 posts of ${channelKey}: ${estimateText(overview.data?.estimateUsd ?? null, 1)}`, { danger: false, confirmLabel: 'Analyze' }))) return;
    analyze.mutate([channelKey], {
      onSuccess: (r) => {
        if (r.queued[0]) { setOpen(r.queued[0].id); return; }
        toast.error(r.refused[0]?.error === 'not_own_channel' ? `${channelKey} is not marked as your channel on Tracked` : 'Not queued');
      },
      onError: (e) => toast.error(describeError(e)),
    });
  };

  return (
    <>
      {latest && (isReviewable(latest.status) || running) && (
        <Badge tone={SETUP_STATUS[latest.status].tone} title="Setup from history">setup: {SETUP_STATUS[latest.status].label.toLowerCase()}</Badge>
      )}
      <button className="btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        disabled={analyze.isPending}
        title={review ? 'Open the setup proposal' : 'Read the last 20 posts and propose the brief, profile, formatting, schedule and voice'}
        onClick={() => (review ? setOpen(review.id) : void start())}>
        <Icon name="sparkles" size={14} /> {review ? (running ? 'Setup running…' : 'Review setup') : 'Set up from history'}
      </button>
      <SetupProposalDialog id={open} onClose={() => setOpen(null)} />
    </>
  );
}
