import { useState, type ReactNode } from 'react';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { useConfirm } from '../ui/ConfirmDialog';
import { describeError, toast } from '../ui/Toast';
import { useAnalyzeChannels, useChannelProposals, useSetupOverview } from '../../api/channel-setup';
import { estimateText, isReviewable, isRunning, SETUP_STATUS } from '../../lib/channel-setup';
import { SetupProposalDialog } from './SetupProposalDialog';

// Spec 042: "Set up from history" on a channel agent's page — starts the analysis of the channel's last 20 posts,
// or opens the proposal waiting for review; the badge shows the latest proposal's state.
// Spec 078 B3.2: the logic is a hook so the header's More menu can start it; the button below is the same thing as a button.

export interface AgentSetup {
  /** The latest proposal's state while one is running or waiting for review (a badge next to the agent's name). */
  status: { label: string; tone: (typeof SETUP_STATUS)[keyof typeof SETUP_STATUS]['tone'] } | null;
  /** "Set up from history" · "Review setup" · "Setup running…". */
  label: string;
  title: string;
  busy: boolean;
  /** Start the analysis (after a confirmation) or open the proposal waiting for review. */
  start: () => void;
  /** The proposal dialog: render it once, wherever the trigger lives. */
  dialog: ReactNode;
}

export function useAgentSetup(channelKey: string | null): AgentSetup {
  const q = useChannelProposals(channelKey);
  const overview = useSetupOverview();
  const analyze = useAnalyzeChannels();
  const confirm = useConfirm();
  const [open, setOpen] = useState<string | null>(null);
  const latest = q.data?.proposals.find((p) => p.status !== 'superseded') ?? null;
  const running = isRunning(latest?.status);
  const review = latest && (isReviewable(latest.status) || running) ? latest : null;

  const begin = async () => {
    if (!channelKey) return;
    if (!(await confirm(`analyze the last 20 posts of ${channelKey}: ${estimateText(overview.data?.estimateUsd ?? null, 1)}`, { danger: false, confirmLabel: 'Analyze' }))) return;
    analyze.mutate([channelKey], {
      onSuccess: (r) => {
        if (r.queued[0]) { setOpen(r.queued[0].id); return; }
        toast.error(r.refused[0]?.error === 'not_own_channel' ? `${channelKey} is not marked as your channel on Tracked` : 'Not queued');
      },
      onError: (e) => toast.error(describeError(e)),
    });
  };

  return {
    status: review && latest ? { label: `setup: ${SETUP_STATUS[latest.status].label.toLowerCase()}`, tone: SETUP_STATUS[latest.status].tone } : null,
    label: review ? (running ? 'Setup running…' : 'Review setup') : 'Set up from history',
    title: review ? 'Open the setup proposal' : 'Read the last 20 posts and propose the brief, profile, formatting, schedule and voice',
    busy: analyze.isPending,
    start: () => (review ? setOpen(review.id) : void begin()),
    dialog: <SetupProposalDialog id={open} onClose={() => setOpen(null)} />,
  };
}

/** The same as a stand-alone button with the state badge. */
export function AgentSetupButton({ channelKey }: { channelKey: string }) {
  const s = useAgentSetup(channelKey);
  return (
    <>
      {s.status && <Badge tone={s.status.tone} title="Setup from history">{s.status.label}</Badge>}
      <button className="btn-secondary" disabled={s.busy} title={s.title} onClick={s.start}>
        <Icon name="sparkles" size={14} /> {s.label}
      </button>
      {s.dialog}
    </>
  );
}
