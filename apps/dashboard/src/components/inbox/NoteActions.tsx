// Spec 078 A3: the buttons of an Inbox note, for Today's "Needs you" rows and the Inbox page alike.
//
// `lib/inbox-kinds.ts` decides what a note offers (a primary step, a secondary one and a few quiet extras); this component
// runs them with the hooks the dashboard already has, plus the two new ones of spec 078 (`useInboxAction`, `usePauseSeries`;
// `useMarkInboxUnread` is for the pages' Undo after a Dismiss). After a decision it marks the note read, which refreshes the
// lists and the menu counters (the router's MutationCache refreshes the badges after every successful mutation). Toasts are English.
//
//   <NoteActions item={note} size="sm" onDone={() => ...} />
//
// - Nothing here is fatal: a step that cannot run is not offered (no handle, an old server without `actions`), a 404 from a
//   server that predates an endpoint is explained, and the links stay.
// - A note that is already read shows its links only: its decisions were taken or are stale.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '../ui/Button';
import { useConfirm } from '../ui/ConfirmDialog';
import { describeError, toast } from '../ui/Toast';
import { AutonomyDialog } from '../approvals/AutonomyDialog';
import { AgentModeSwitch } from '../agents/AgentsUi';
import { NetworkOfferActions } from '../agents/NetworkOfferActions';
import { errorText } from '../agents/NetworkUi';
import { ApiError } from '../../api/client';
import {
  errorBody, useAgentTree, useInboxAction, useMarkInboxRead, usePauseSeries, useResumeSeries, type AgentNode, type InboxItem,
} from '../../api/agents';
import { useContestDecision, useDecideDirective } from '../../api/manager';
import { useDecidePlaybook } from '../../api/network';
import { useReplan } from '../../api/editor';
import { useRefreshThreadsToken } from '../../api/meta-accounts';
import {
  inboxActionMessage, isAlreadyDecided, isSettledCode, noteErrorMessage, planNote, planSteps, stepKey, type NoteStep,
} from '../../lib/inbox-kinds';

export interface NoteActionsProps {
  item:       InboxItem;
  /** `sm` for rows (Today's Needs you), `md` for the detail pane. */
  size?:      'sm' | 'md';
  /** Called once the note is settled (it was marked read by one of the actions). Links do not call it. */
  onDone?:    () => void;
  /** Its "Got it" step marked the note read: the page shows its own toast (with Undo) instead of the plain one. Decisions never call it. */
  onRead?:    () => void;
  className?: string;
}

const SMALL: CSSProperties = { padding: '6px 12px' };
const NO_UNDERLINE: CSSProperties = { textDecoration: 'none' };

/** The agent with this handle anywhere in the tree. */
function findAgent(nodes: AgentNode[] | undefined, handle: string | null): AgentNode | null {
  if (!handle) return null;
  for (const n of nodes ?? []) {
    if (n.handle === handle) return n;
    const c = findAgent(n.children, handle);
    if (c) return c;
  }
  return null;
}

/** The text of a failed request: our English message for known failures, else the server's own. */
function failureText(e: unknown): string {
  const body = errorBody(e);
  const known = noteErrorMessage(e instanceof ApiError ? e.status : null, body?.error ?? null);
  return known ?? errorText(e);
}

export function NoteActions({ item, size = 'md', onDone, onRead, className }: NoteActionsProps) {
  const tree = useAgentTree();
  const agents = tree.data?.agents;
  const plan = useMemo(() => planNote(item, { tree: agents }), [item, agents]);
  const confirm = useConfirm();

  const markRead = useMarkInboxRead();
  const inboxAction = useInboxAction();
  const resume = useResumeSeries(plan.handle ?? '');
  const pause = usePauseSeries(plan.handle ?? '');
  const replan = useReplan();
  const refresh = useRefreshThreadsToken();
  const decideDirective = useDecideDirective();
  const contest = useContestDecision();
  const decidePlaybook = useDecidePlaybook();

  const [busy, setBusy] = useState<string | null>(null);
  const [autonomy, setAutonomy] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);

  const settled = !!item.readAt;
  const all = planSteps(plan);
  const steps = settled ? all.filter((s) => s.type === 'link') : all;

  // "Go live" and "Choose mode" change the agent's mode in another component: the note is done when that mode changes.
  const modeStep = all.find((s): s is Extract<NoteStep, { type: 'autonomy' | 'mode' }> => s.type === 'autonomy' || s.type === 'mode');
  const watched = findAgent(agents, modeStep?.handle ?? null);
  const modeAtStart = useRef<string | null>(null);
  useEffect(() => {
    const mode = watched?.mode ?? null;
    if (mode == null) return;
    if (modeAtStart.current == null) { modeAtStart.current = mode; return; }
    if (mode === modeAtStart.current) return;
    modeAtStart.current = mode;
    if (!item.readAt) markRead.mutate([item.id]);
    onDone?.();
  }, [watched?.mode]);

  if (!steps.length) return null;

  /** The owner acted: the note is read (unless the server already did) and the page can move on. */
  const finish = async (alreadyRead = false) => {
    if (!alreadyRead && !item.readAt) {
      try { await markRead.mutateAsync([item.id]); } catch { /* the toast of the failed mark; the action itself worked */ }
    }
    onDone?.();
  };

  /** A failed decision: already decided elsewhere (the note is stale: mark it done) or a real failure. */
  const decided = async (e: unknown) => {
    if (isAlreadyDecided(errorBody(e)?.error)) {
      toast.success('Somebody already decided this. Marked as done.');
      await finish();
    } else {
      toast.error(failureText(e));
    }
  };

  const exec = async (step: NoteStep): Promise<void> => {
    switch (step.type) {
      case 'link': return;
      case 'read': {
        await markRead.mutateAsync([item.id]);
        if (onRead) onRead();
        else toast.success('Marked as done');
        onDone?.();
        return;
      }
      case 'action': {
        try {
          const r = await inboxAction.mutateAsync({ id: item.id, key: step.key });
          const m = inboxActionMessage(r.code);
          if (m.tone === 'error') toast.error(m.text); else toast.success(m.text);
          if (isSettledCode(r.code)) await finish(!!r.item?.readAt);
        } catch (e) { toast.error(failureText(e)); }
        return;
      }
      case 'resume-series': {
        // Errors are toasted by the router's MutationCache.
        try { await resume.mutateAsync(step.pauseId); } catch { return; }
        toast.success(inboxActionMessage('resumed').text);
        await finish(true);
        return;
      }
      case 'pause-series': {
        try {
          await pause.mutateAsync({ key: step.key, label: step.seriesLabel });
          toast.success(inboxActionMessage('paused').text);
          await finish();
        } catch (e) { toast.error(failureText(e)); }
        return;
      }
      case 'replan': {
        // The hook toasts the start and the failure.
        try { await replan.mutateAsync({ key: step.channel, date: step.date }); } catch { return; }
        await finish();
        return;
      }
      case 'threads-refresh': {
        try { await refresh.mutateAsync(step.accountId); } catch { return; }
        toast.success('Threads token refreshed');
        await finish();
        return;
      }
      case 'directive': {
        const ok = step.decision === 'approve'
          ? await confirm('approve this directive', {
            danger: false, confirmLabel: 'Approve',
            details: <div className="callout-warning" style={{ flexDirection: 'column', gap: 4 }}>
              <strong>It is delivered to the agent on its next run.</strong>
              <span className="text-micro">Structural changes (cross-promo, pausing, strategy) act on real resources.</span>
            </div>,
          })
          : await confirm('decline this directive', { confirmLabel: 'Decline' });
        if (!ok) return;
        try {
          await decideDirective.mutateAsync({ id: step.id, decision: step.decision });
          toast.success(step.decision === 'approve' ? 'Directive approved' : 'Directive declined');
          await finish();
        } catch (e) { await decided(e); }
        return;
      }
      case 'contest': {
        const ok = step.decision === 'uphold'
          ? await confirm('uphold this directive', {
            danger: false, confirmLabel: 'Uphold',
            details: <div className="callout-warning" style={{ flexDirection: 'column', gap: 4 }}>
              <strong>The executor applies it now, over the agent’s refusal.</strong>
              <span className="text-micro">Health and capability guards still apply: if the change cannot be made now, nothing happens and the directive stays contested.</span>
            </div>,
          })
          : await confirm('accept the agent\'s refusal', {
            danger: false, confirmLabel: 'Accept refusal',
            details: <span className="text-micro">The directive is rejected, and @manager may not file another one of its kind to this agent for 48 hours.</span>,
          });
        if (!ok) return;
        try {
          await contest.mutateAsync({ id: step.id, decision: step.decision });
          toast.success(step.decision === 'uphold' ? 'Directive upheld. The executor is applying it' : 'Refusal accepted. The directive is rejected');
          await finish();
        } catch (e) {
          if (errorBody(e)?.error === 'not_executable') {
            const d = errorBody(e)?.details;
            toast.error(`It cannot be applied now: ${typeof d === 'string' ? d : 'a health or capability guard refused it'}. It stays contested.`);
          } else await decided(e);
        }
        return;
      }
      case 'playbook': {
        const ok = step.decision === 'approve'
          ? await confirm('approve this playbook', {
            danger: false, confirmLabel: 'Approve',
            details: <p className="text-micro ink-muted" style={{ margin: 0 }}>It becomes the active playbook at once, and the next plan follows it.</p>,
          })
          : await confirm('reject this playbook', { confirmLabel: 'Reject' });
        if (!ok) return;
        try {
          await decidePlaybook.mutateAsync({ id: step.id, decision: step.decision });
          toast.success(step.decision === 'approve' ? 'Playbook approved and active' : 'Playbook rejected');
          await finish();
        } catch (e) { await decided(e); }
        return;
      }
      case 'autonomy': setAutonomy(true); return;
      case 'mode':     setModeOpen((v) => !v); return;
      case 'network-offer': return;
    }
  };

  const run = async (step: NoteStep) => {
    if (busy) return;
    setBusy(stepKey(step));
    try { await exec(step); } catch (e) { toast.error(describeError(e)); } finally { setBusy(null); }
  };

  const style = size === 'sm' ? SMALL : undefined;
  const offer = steps.find((s): s is Extract<NoteStep, { type: 'network-offer' }> => s.type === 'network-offer');
  if (offer) {
    // The offer brings its own buttons and playbook link.
    return (
      <div className={className}>
        <NetworkOfferActions groupId={offer.groupId} handle={offer.handle} onDone={() => { void finish(); }} />
      </div>
    );
  }

  const modeNode = modeOpen && modeStep?.type === 'mode' ? findAgent(agents, modeStep.handle) : null;

  const render = (s: NoteStep, rank: number) => {
    const variant = rank === 0 ? 'primary' : rank === 1 ? 'secondary' : 'ghost';
    if (s.type === 'link') {
      const cls = rank === 0 ? (settled ? 'btn-secondary' : 'btn-primary') : rank === 1 ? 'btn-secondary' : 'link-accent text-micro';
      return (
        <Link key={stepKey(s)} to={s.link.to as any} params={s.link.params as any} search={s.link.search as any}
          className={rank < 2 && size === 'sm' ? `${cls} note-act` : cls} style={rank < 2 ? { ...NO_UNDERLINE, ...style } : NO_UNDERLINE}>
          {s.label}
        </Link>
      );
    }
    const isBusy = busy === stepKey(s);
    return (
      <Button key={stepKey(s)} type="button" variant={variant} className={rank >= 2 || size === 'sm' ? 'note-act' : undefined} style={rank < 2 ? style : undefined}
        disabled={!!busy} aria-busy={isBusy} onClick={() => { void run(s); }}>
        {s.label}{isBusy ? '…' : ''}
      </Button>
    );
  };

  return (
    <>
      <div className={className} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {steps.map((s, i) => render(s, i))}
        {modeNode && <div style={{ flexBasis: '100%' }}><AgentModeSwitch agent={modeNode} /></div>}
      </div>
      {autonomy && modeStep?.type === 'autonomy' && (
        <AutonomyDialog channel={modeStep.channel} title={watched?.name ?? null} onClose={() => setAutonomy(false)} />
      )}
    </>
  );
}
