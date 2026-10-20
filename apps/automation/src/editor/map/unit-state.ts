import type { Agent, AgentMode } from '../agents/agent.types';
import { isPaused } from '../agents/agent.types';
import type { UnitState } from './map.types';

/**
 * Spec 056 FR-002: what a unit is doing right now, derived from rows the engine already writes. Pure: the service
 * gathers the facts (a few batched queries for all agents), this decides. The first rule that matches wins:
 * paused · off · a running run · a recent error · publishing · waiting for the owner · idle.
 */

const MIN = 60_000;
/** A run that started longer ago than this and is still `running` is stuck, not working. */
export const RUN_FRESH_MS = 30 * MIN;
/** Errors (a failed run, a failed slot) show for this long. */
export const ERROR_WINDOW_MS = 120 * MIN;
/** An approved post due within this window counts as "publishing". */
export const PUBLISH_SOON_MS = 10 * MIN;

/** Run statuses that count as a failure (the same set the level score and the error state use). */
export const RUN_ERROR_STATUSES = ['error', 'budget_exceeded', 'max_steps', 'no_terminal'] as const;

export interface UnitFacts {
  /** The channel card's mode (what runs and publishing follow); falls back to the agent's own mode. */
  effectiveMode: AgentMode;
  /** The unit's home resource has an active pause (spec 025). */
  resourcePaused: boolean;
  /** The agent's newest run still `running`. */
  runningRun?:  { role: string; startedAt: Date; topic: string | null } | null;
  /** The agent's newest finished run. */
  lastRun?:     { status: string; finishedAt: Date | null; error: string | null } | null;
  /** Slot facts of the resource(s) the agent runs (orchestrators only). */
  slots?: {
    failed?:   { at: Date; error: string | null } | null;
    running?:  { at: Date; topic: string | null } | null;
    /** The earliest approved post (the service passes those due soon; the window is checked here too). */
    approvedDue?: { at: Date; topic: string | null } | null;
    awaiting?: number;
    awaitingSince?: Date | null;
  };
  lastRunAt?: Date | null;
}

export interface UnitStateResult { state: UnitState; since: Date | null; detail: string | null }

/** The work state a running run puts its agent in, by the run's role. */
export function stateOfRole(role: string): UnitState {
  switch (role) {
    case 'executor': case 'composer': return 'writing';
    case 'reviewer': case 'checker': case 'idea_reviewer': return 'reviewing';
    default: return 'planning'; // planner, orchestrator, manager, onboarder, builder
  }
}

/** The states in which the unit is busy (the page polls faster while any unit is). */
export const WORKING_STATES: readonly UnitState[] = ['planning', 'writing', 'reviewing', 'publishing'];

const oneLine = (s: string | null | undefined, n = 140): string | null => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t ? (t.length > n ? `${t.slice(0, n - 1)}…` : t) : null;
};

/** A slot error reduced to its code (`publish_failed: 400` → `publish_failed`): the text after it may quote a post. */
export function errorCode(e: string | null | undefined): string | null {
  const head = (e ?? '').split(':')[0];
  return oneLine(head, 60);
}

const RUN_STATUS_TEXT: Record<string, string> = {
  error: 'the last run failed', budget_exceeded: 'the last run hit its budget', max_steps: 'the last run ran out of steps', no_terminal: 'the last run ended without a result',
};

export function unitState(
  agent: Pick<Agent, 'kind' | 'status' | 'pausedUntil'>, f: UnitFacts, now: Date,
): UnitStateResult {
  // 1. paused: the agent, or its home resource
  if (isPaused(agent, now)) {
    return { state: 'paused', since: null, detail: agent.status === 'paused' ? 'paused by the owner' : 'paused until a set time' };
  }
  if (f.resourcePaused) return { state: 'paused', since: null, detail: 'the resource is paused' };

  // 2. off
  if (f.effectiveMode === 'off') return { state: 'off', since: null, detail: null };

  // 3. a run in progress
  const run = f.runningRun;
  if (run && now.getTime() - run.startedAt.getTime() <= RUN_FRESH_MS) {
    return { state: stateOfRole(run.role), since: run.startedAt, detail: oneLine(run.topic) ?? run.role };
  }

  // 4. a recent error: the last finished run, or a failed slot of its resource
  const lastRun = f.lastRun;
  const runFailed = lastRun && lastRun.finishedAt
    && (RUN_ERROR_STATUSES as readonly string[]).includes(lastRun.status)
    && now.getTime() - lastRun.finishedAt.getTime() <= ERROR_WINDOW_MS;
  const slotFailed = f.slots?.failed && now.getTime() - f.slots.failed.at.getTime() <= ERROR_WINDOW_MS ? f.slots.failed : null;
  if (runFailed || slotFailed) {
    // The newer of the two is the one to show.
    const runAt = runFailed ? lastRun!.finishedAt!.getTime() : -1;
    if (slotFailed && slotFailed.at.getTime() >= runAt) {
      return { state: 'error', since: slotFailed.at, detail: errorCode(slotFailed.error) ?? 'a post failed' };
    }
    return { state: 'error', since: lastRun!.finishedAt, detail: oneLine(lastRun!.error) ?? RUN_STATUS_TEXT[lastRun!.status] ?? 'the last run failed' };
  }

  // 5. publishing: a slot running, or an approved one due within 10 minutes
  const running = f.slots?.running;
  if (running) return { state: 'publishing', since: running.at, detail: oneLine(running.topic) ?? 'publishing a post' };
  const due = f.slots?.approvedDue;
  if (due && due.at.getTime() <= now.getTime() + PUBLISH_SOON_MS) {
    return { state: 'publishing', since: due.at, detail: oneLine(due.topic) ?? 'an approved post is about to go out' };
  }

  // 6. waiting for the owner: an orchestrator whose resource has posts to approve
  if (agent.kind === 'orchestrator' && (f.slots?.awaiting ?? 0) > 0) {
    const n = f.slots!.awaiting!;
    return { state: 'waiting', since: f.slots?.awaitingSince ?? null, detail: `${n} post${n === 1 ? '' : 's'} wait${n === 1 ? 's' : ''} for you` };
  }

  return { state: 'idle', since: f.lastRunAt ?? null, detail: null };
}
