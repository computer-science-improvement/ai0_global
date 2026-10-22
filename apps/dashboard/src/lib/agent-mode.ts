import type { EditorMode } from '../api/types';

// Spec 064 FR-008: a role agent (planner, executor, ideas of a channel) has no mode of its own. Its runs follow the
// mode of its orchestrator (the channel card's publishing switch), so a child is never shown with a mode control or
// with its own stored mode — only with what it follows.

const MODE_NAME: Record<EditorMode, string> = { off: 'off', shadow: 'shadow', approve: 'in approval', live: 'live' };

/** The badge text: «Follows @pdr (live)». */
export function followsText(parentHandle: string, mode: EditorMode): string {
  return `Follows @${parentHandle} (${MODE_NAME[mode]})`;
}

/** The tooltip: why the child has no mode switch and where the mode is changed. */
export function followsTitle(handle: string, parentHandle: string, mode: EditorMode): string {
  return `@${handle} has no mode of its own. It runs in the mode of @${parentHandle}, which is ${MODE_NAME[mode]}. Change the mode on @${parentHandle}.`;
}

/** The mode a child really runs in: what its orchestrator's channel says, else the orchestrator's own mode. */
export function followedMode(child: { effectiveMode?: EditorMode; mode: EditorMode }, parent?: { mode: EditorMode } | null): EditorMode {
  return child.effectiveMode ?? parent?.mode ?? child.mode;
}
