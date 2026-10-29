// Spec 078 D6 / B3.2: the header of /app/agents/$handle — the xl glyph, name, kind chip, description and the
// "@handle → scope" line; the big 4-up mode switch with one line that says what the current mode does (it depends on the
// kind: @manager's Shadow is not an orchestrator's); and the actions: Run now, Chat with <name>, More (Set up from
// history, Pause / Resume, Edit profile). Going live still goes through the autonomy dialog / the confirmation inside
// AgentModeSwitch. A role agent has no switch: it shows what it follows.

import { useCallback, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { PageHeader } from '../ui/PageHeader';
import { Badge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { describeError, toast } from '../ui/Toast';
import { NavContextMenu, type NavMenuAction } from '../nav/NavContextMenu';
import { AgentGlyph, AgentModeSwitch, FollowsBadge, KIND_LABEL, PauseModal, scopeLabel } from './AgentsUi';
import { useAgentSetup } from '../setup/AgentSetupButton';
import { fmtDate } from '../../lib/format';
import { followedMode } from '../../lib/agent-mode';
import { followsHint, modeHint, runNowError, runNowState } from '../../lib/mode-hints';
import { zoneLabel } from '../../lib/zoned-time';
import { errorBody, usePatchAgent, useRunAgent, type AgentDetail } from '../../api/agents';
import { useRunManager } from '../../api/manager';
import { useNetworkPlan } from '../../api/network';

export function AgentHeader({ data, onEdit }: { data: AgentDetail; onEdit: () => void }) {
  const a = data.agent;
  const parent = data.parent;
  const manager = a.kind === 'manager';
  const orchestratorHandle = a.kind === 'orchestrator' ? a.handle : parent?.handle ?? a.handle;
  const telegramOrchestrator = a.kind === 'orchestrator' && !!data.channelKey && !!a.scopeId?.startsWith('telegram:');
  const mode = followedMode(a, null);

  // The plan's schedule names the evening batch hour and the zone for the "In approval" line.
  const schedule = useNetworkPlan(orchestratorHandle, '', !!data.channelKey).data?.schedule;
  const hint = modeHint(a.mode, { kind: a.kind, batchHour: schedule?.batchHour, zone: schedule ? zoneLabel(schedule.timezone) : null });

  const runAgent = useRunAgent();
  const runManager = useRunManager();
  const run = runNowState({ kind: a.kind, handle: a.handle, paused: a.paused, mode });
  const running = manager ? runManager.isPending : runAgent.isPending;
  const runNow = () => {
    const onError = (e: unknown) => toast.error(runNowError(errorBody(e)?.error, a.handle) ?? describeError(e));
    if (manager) {
      // The MANAGER has its own run endpoint (reads the KPI digest; may file directives).
      runManager.mutate(undefined, { onSuccess: () => toast.success('@manager run started — its review appears under Activity → Reviews in a minute'), onError });
    } else {
      runAgent.mutate(a.handle, { onError });
    }
  };

  // Chat: a role agent is spoken to through its orchestrator (the chat sends a role mention there).
  const chatHandle = parent ? parent.handle : a.handle;
  const chatName = parent ? parent.name : a.name;

  // More
  const patch = usePatchAgent(a.handle);
  const setup = useAgentSetup(telegramOrchestrator ? data.channelKey : null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [pausing, setPausing] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  // The More button toggles its menu; the menu returns focus to it (its `anchor`) when it closes.
  const openMenu = () => {
    const r = moreRef.current?.getBoundingClientRect();
    setMenu((open) => (open ? null : r ? { x: r.right - 210, y: r.bottom + 6 } : { x: 16, y: 120 }));
  };
  const closeMenu = useCallback(() => setMenu(null), []);
  const resume = () => {
    // Undo puts back the pause the agent had: an open-ended one stays open-ended; a date is sent only while it is ahead
    // (the server refuses a past one, and a stale paused_until can sit next to status 'paused').
    const until = a.pausedUntil && Date.parse(a.pausedUntil) > Date.now() ? a.pausedUntil : null;
    const was = a.status === 'paused' ? { status: 'paused' as const, ...(until ? { paused_until: until } : {}) } : { paused_until: until };
    patch.mutate({ status: 'active', paused_until: null }, {
      onSuccess: () => toast.success(`@${a.handle} resumed`, { action: { label: 'Undo', onClick: () => patch.mutate(was, { onError: (e) => toast.error(describeError(e)) }) } }),
      onError: (e) => toast.error(describeError(e)),
    });
  };
  const actions: NavMenuAction[] = [
    ...(telegramOrchestrator ? [{ label: setup.label, icon: 'sparkles' as const, title: setup.title, disabled: setup.busy, onSelect: setup.start }] : []),
    a.paused
      ? { label: 'Resume', icon: 'play' as const, onSelect: resume }
      : { label: 'Pause…', icon: 'pause' as const, onSelect: () => setPausing(true) },
    { label: 'Edit profile', icon: 'pencil' as const, onSelect: onEdit },
  ];

  const pausedBadge = a.paused && (
    <Badge tone="danger" title={a.pausedUntil ? `until ${fmtDate(a.pausedUntil)}` : 'until resumed'}>
      paused{a.pausedUntil ? ` · until ${fmtDate(a.pausedUntil)}` : ''}
    </Badge>
  );

  return (
    <>
      <div className="agent-head">
        <AgentGlyph agent={a} size="xl" />
        <div className="agent-head-main">
          <PageHeader
            eyebrow={parent ? (
              <>{KIND_LABEL[a.kind]} of{' '}
                <Link to="/app/agents/$handle" params={{ handle: parent.handle }} className="link-accent">{parent.emoji ? `${parent.emoji} ` : ''}{parent.name}</Link>
              </>
            ) : undefined}
            title={(
              <>
                {a.name}
                <span className="agent-title-tags">
                  <span className="chip mono">{KIND_LABEL[a.kind]}</span>
                  {pausedBadge}
                  {setup.status && <Badge tone={setup.status.tone} title="Setup from history">{setup.status.label}</Badge>}
                </span>
              </>
            )}
            subtitle={(
              <span className="agent-sub">
                {a.description && <span className="agent-desc clamp" title={a.description}>{a.description}</span>}
                <span className="agent-scope mono">@{a.handle} → {scopeLabel(a)}</span>
              </span>
            )}
            actions={(
              <>
                {run.show && (
                  <button type="button" className="btn-secondary" disabled={!run.enabled || running} title={run.title} onClick={runNow}>
                    <Icon name="rocket" size={14} /> {running ? 'Starting…' : 'Run now'}
                  </button>
                )}
                <Link to="/app/chat" search={{ q: `@${chatHandle} ` }} className="btn-secondary" title={`Open the chat with @${chatHandle}`}>
                  <Icon name="chat" size={14} /> Chat with {chatName}
                </Link>
                <button ref={moreRef} type="button" className="btn-ghost agent-more" aria-haspopup="menu" aria-expanded={!!menu} aria-label="More actions" onClick={openMenu}>
                  <Icon name="ellipsis" size={16} /> More
                </button>
              </>
            )}
          />
        </div>
      </div>

      <div className="agent-mode">
        <div className="agent-mode-switch">
          <div className="text-overline">Mode</div>
          {parent
            ? <div><FollowsBadge agent={a} parent={parent} /></div>
            : <AgentModeSwitch agent={a} size="lg" />}
        </div>
        <div className="agent-mode-hint text-body-sm" aria-live="polite">
          {parent ? followsHint(parent.handle) : hint}
          {!parent && a.mode === 'shadow' && a.shadowUntil && <span className="mono"> Shadow until {fmtDate(a.shadowUntil)}.</span>}
        </div>
      </div>

      {menu && <NavContextMenu x={menu.x} y={menu.y} title={`@${a.handle}`} actions={actions} onClose={closeMenu} anchor={moreRef.current} />}
      {pausing && <PauseModal handle={a.handle} onClose={() => setPausing(false)} />}
      {setup.dialog}
    </>
  );
}
