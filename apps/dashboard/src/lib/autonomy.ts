// Spec 090 FR-010: "Decided without you" on /app/health — the words and the state of a silent decision. Pure, node-tested.
import type { AutonomyDecision, DecisionAction } from '../api/autonomy';

/** The window the section shows. */
export const DECIDED_DAYS = 14;
export const DECIDED_LIMIT = 200;

export const FAMILY_LABEL: Record<string, string> = {
  directive: 'Directive', pending_action: 'Agent card', playbook: 'Playbook', audit_fix: 'Audit fix', readiness_fix: 'Readiness fix',
  series_pause: 'Series pause', setup_proposal: 'Channel setup', launch_graduation: 'Launch to Live',
};

export const familyLabel = (family: string): string => FAMILY_LABEL[family] ?? family.replace(/_/g, ' ');

/** ISO time `days` before `now` (the `since` of the list). */
export const sinceIso = (days: number, now: Date = new Date()): string => new Date(now.getTime() - days * 86_400_000).toISOString();

export type DecisionState = 'undone' | 'failed' | 'dropped' | 'done';

/** What the card shows: an undone decision is "Undone" whatever its original action was. */
export function decisionState(d: Pick<AutonomyDecision, 'action' | 'undoneAt'>): DecisionState {
  if (d.undoneAt || d.action === 'undone') return 'undone';
  if (d.action === 'failed') return 'failed';
  if (d.action === 'dropped') return 'dropped';
  return 'done';
}

export const STATE_LABEL: Record<DecisionState, string> = { undone: 'Undone', failed: 'Failed', dropped: 'Dropped', done: 'Done' };
export const STATE_TONE: Record<DecisionState, 'neutral' | 'success' | 'danger' | 'warning'> = {
  undone: 'neutral', failed: 'danger', dropped: 'warning', done: 'success',
};

export const ACTION_LABEL: Record<DecisionAction, string> = {
  applied: 'Applied', dropped: 'Dropped', resumed: 'Resumed', failed: 'Failed', undone: 'Undone',
};

/**
 * The cards to show: the log also holds the `undone` row an undo writes; it only repeats the original decision, which already
 * shows as "Undone", so it is left out. Failed decisions come first, then the newest.
 */
export function visibleDecisions(list: AutonomyDecision[]): AutonomyDecision[] {
  const real = list.filter((d) => d.action !== 'undone');
  const at = (d: AutonomyDecision) => new Date(d.decidedAt).getTime();
  const rank = (d: AutonomyDecision) => (decisionState(d) === 'failed' ? 0 : 1);
  return [...real].sort((a, b) => rank(a) - rank(b) || at(b) - at(a) || b.id - a.id);
}

/** The owner-facing text of an undo failure (the API answers `{error, details?}` as JSON text). */
export function undoErrorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  let code = raw;
  let details = '';
  try {
    const b = JSON.parse(raw);
    if (b && typeof b.error === 'string') { code = b.error; details = typeof b.details === 'string' ? b.details : ''; }
  } catch { /* plain text */ }
  switch (code) {
    case 'already_undone': return 'This decision was already undone.';
    case 'not_found': return 'This decision no longer exists.';
    case 'no_undo': return 'This decision cannot be undone.';
    case 'no_handler': return 'Undo is not available for this kind of decision yet.';
    case 'failed': return `Undo failed${details ? `: ${details}` : '.'}`;
    default: return raw || 'Undo failed.';
  }
}
