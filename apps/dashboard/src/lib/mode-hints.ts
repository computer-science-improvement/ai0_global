// Words of the agent page header (spec 078 D6): the one-line explanation under the big mode switch, what "Run now" does for
// each kind of agent, and the readable text of the errors it can answer with. The handoff cites a data contract (section 9.3)
// that is not in the repo, so the strings are written here, kind-aware: @manager's Shadow differs from an orchestrator's.
// Pure: no React, node-tested (mode-hints.test.ts).

import type { AgentKind } from '../api/agents';
import type { EditorMode } from '../api/types';

const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

export interface HintCtx {
  kind: AgentKind;
  /** The evening hour when approval mode plans the next day (`schedule.batchHour` of the plan; 20 when unknown). */
  batchHour?: number | null;
  /** Zone label to name next to the hour ("Kyiv"). */
  zone?: string | null;
}

/**
 * One line under the mode switch. Orchestrators (and the generic fallback): off does nothing, shadow writes and publishes
 * nothing, approval plans tomorrow in the evening and waits for the owner, live publishes through code guards.
 * @manager has no posts: its mode decides whether its directives act (it files them as previews unless it is Live).
 */
export function modeHint(mode: EditorMode, ctx: HintCtx): string {
  if (ctx.kind === 'manager') {
    switch (mode) {
      case 'off':     return 'Off — no scheduled reviews and no new directives.';
      case 'shadow':  return 'Shadow — directives are filed as previews; nothing acts on them.';
      case 'approve': return 'In approval — directives are filed as previews until you switch @manager to Live.';
      case 'live':    return 'Live — directives bind the agents; structural changes still wait for you.';
    }
  }
  if (ctx.kind === 'builder' || ctx.kind === 'auditor') {
    switch (mode) {
      case 'off':     return 'Off — the agent does nothing.';
      case 'shadow':  return 'Shadow — it works and reports, but changes nothing.';
      case 'approve': return 'In approval — what it wants to change waits for you.';
      case 'live':    return 'Live — it acts on its own through code guards.';
    }
  }
  switch (mode) {
    case 'off':     return 'Off — the agent does nothing.';
    case 'shadow':  return 'Shadow — plans and writes next to you, publishes nothing.';
    case 'approve': return `In approval — tomorrow's posts are planned at ${hh(ctx.batchHour ?? 20)}${ctx.zone ? ` ${ctx.zone}` : ''} and wait for you.`;
    case 'live':    return 'Live — publishes on its own through code guards.';
  }
}

/** The line under a role agent's badge: it has no mode of its own. */
export function followsHint(parentHandle: string): string {
  return `Runs in the mode of @${parentHandle}. Change it there.`;
}

// ── Run now ──────────────────────────────────────────────────────────────────

export interface RunNowState {
  /** false for kinds that run only on their own schedule: the button is not drawn at all. */
  show: boolean;
  enabled: boolean;
  /** The tooltip / accessible description: what the button does, or why it is off. */
  title: string;
}

/**
 * What "Run now" does (editor.module.ts runNow): an orchestrator or planner replans the rest of today, a reviewer starts a
 * reviewer run, @manager has its own endpoint; every other kind answers `started:false` ("runs on its own schedule"), so it
 * gets no button. `mode` is the mode the agent really runs in (a role agent follows its orchestrator).
 */
export function runNowState(a: { kind: AgentKind; handle: string; paused: boolean; mode: EditorMode }): RunNowState {
  const runnable = a.kind === 'orchestrator' || a.kind === 'planner' || a.kind === 'reviewer' || a.kind === 'manager';
  if (!runnable) return { show: false, enabled: false, title: `@${a.handle} runs on its own schedule` };
  if (a.paused) return { show: true, enabled: false, title: 'Resume the agent first' };
  if (a.mode === 'off') {
    return { show: true, enabled: false, title: a.kind === 'manager' ? '@manager is off — switch it to Shadow or Live first' : 'The channel is off — switch it to Shadow, In approval or Live first' };
  }
  if (a.kind === 'manager') return { show: true, enabled: true, title: 'Start a review now: it reads the KPI digest and may file directives' };
  if (a.kind === 'reviewer') return { show: true, enabled: true, title: 'Start a reviewer run now' };
  return { show: true, enabled: true, title: 'Replans the rest of today; posts already written stay' };
}

/** The readable text of an error code Run now can answer with; `null` = not one of ours (show the server's own text). */
export function runNowError(code: string | undefined, handle: string): string | null {
  switch (code) {
    case 'agent_paused':        return `@${handle} is paused — resume it first`;
    case 'channel_off':         return 'The channel is off — switch it to Shadow, In approval or Live first';
    case 'replan_in_progress':  return 'A replan is already running — wait for it to finish';
    case 'editor_disabled':     return 'The editor is switched off on the server';
    case 'manager_off':         return '@manager is off — switch it to Shadow or Live first';
    case 'no_manager':          return 'There is no @manager agent to run';
    default:                    return null;
  }
}

// ── after Resume ─────────────────────────────────────────────────────────────

/** "Next plan at 06:00 Kyiv." after the owner resumes a paused series; approval mode plans in the evening batch. */
export function nextPlanLine(s: { planHour: number; approval: boolean; batchHour?: number | null; zone?: string | null }): string {
  const hour = s.approval ? (s.batchHour ?? 20) : s.planHour;
  return `Next plan at ${hh(hour)}${s.zone ? ` ${s.zone}` : ''}.`;
}
