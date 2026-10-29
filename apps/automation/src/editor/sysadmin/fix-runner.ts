import type { Agent } from '../agents/agent.types';
import { applyHostProxyAdd, applySourceDrop, type HostProxyAddDeps, type SourceDropDeps } from '../sources/source-fixes';
import type { Fix } from './audit.types';
import { clip } from './audit-text';
import { errText } from '../../common/err-text';

/**
 * Spec 055 FR-003 / spec 072 FR-004: the closed list of fixes and the one place that applies them. The weekly audit
 * (`AuditService.apply`) and the channel readiness (`ReadinessService.fix`) both call `runFix`; each fix is one call to the
 * service that owns the change, and anything that does not apply throws with the reason (`{ response: { error, details } }`,
 * the shape the controllers read). `tryFix` is the same call that never throws, for code that applies several fixes.
 */

/** The existing services the weekly audit's fixes call, narrowed to what they need. */
export interface AuditFixPorts {
  agentByHandle(handle: string): Promise<Agent | null>;
  /** AgentsService.patchSkill: throws a Nest exception when the agent or the skill is gone. */
  patchSkill(handle: string, name: string, patch: { enabled?: boolean; inline?: boolean }): Promise<unknown>;
  /** Retires a reviewer row (never an owner row); false when nothing was retired. */
  retireMemory(channel: string, id: number): Promise<boolean>;
  /** ConfigConflictsService.apply. The weekly audit passes neither field: every conflict of the orchestrator's group. */
  applyConflicts(orch: Agent, o?: { codes?: string[]; ref?: string }): Promise<{ applied: string[]; remaining: unknown[] }>;
}

/** A paused series as the `series_resume` fix needs to see it: the cause decides whether code may lift it. */
export interface PauseRef { cause: string; resumed: boolean }

/** Spec 072: the audit's ports plus the ones the readiness fixes call. A missing port refuses with `fix_unavailable`. */
export interface FixPorts extends AuditFixPorts {
  /** Adds tools to the card's allow list. Never called for a card whose list is null (no limit): see `mergeToolsAllow`. */
  addCardTools?(channelKey: string, tools: string[]): Promise<unknown>;
  setHashtagMin?(channelKey: string, min: number): Promise<unknown>;
  /** The pause's cause and whether it is already resumed; null = no such pause. */
  seriesPause?(pauseId: string): Promise<PauseRef | null>;
  /** SeriesPauseActions.resume(id, 'dashboard'). */
  resumeSeriesPause?(pauseId: string): Promise<unknown>;
  /** ScheduleService.commitSeriesChange 'update' `{ name, source_mode: 'required' }`; a refusal (`series_invalid`) throws. */
  requireSeriesSource?(channelKey: string, series: string): Promise<unknown>;
  /** Spec 076: what `applySourceDrop` (`sources/source-fixes.ts`) needs: the card as saved and the validating card save. */
  sourceDrop?: SourceDropDeps;
  /** Spec 076: what `applyHostProxyAdd` needs: the live settings and the save of `EGRESS_PROXY_HOSTS`. */
  hostProxy?: HostProxyAddDeps;
}

/** What a fix did. A fix that proposes a card instead of writing (075's `bind_dataset`) returns `proposal`. */
export interface FixResult { ok: boolean; applied?: string; proposal?: { actionId: string }; error?: string }

/** The refusal shape the controllers and the audit tests read. */
export const refusal = (error: string, details: string): Error => Object.assign(new Error(error), { response: { error, details } });

/** "<code>: <details>" of a thrown fix error, clipped: the text `AuditService.apply` stores on a failed finding. */
export function fixErrorText(err: any): string {
  const msg = clip(String(err?.response?.error ?? errText(err)), 200);
  const detail = err?.response?.details ? `: ${clip(String(err.response.details), 150)}` : '';
  return `${msg}${detail}`;
}

/**
 * The card's allow list after adding `tools`. `null` when the card has no list (null = no limit): a list is never
 * written for it, since "allow these" would turn "everything" into "only these".
 */
export function mergeToolsAllow(current: readonly string[] | null, add: readonly string[]): string[] | null {
  if (current === null) return null;
  return [...new Set([...current, ...add])];
}

/** "<n> skills …" — what a fix did, in one line (English, no Cyrillic). */
export function describeFix(fix: Fix, extra?: string): string {
  switch (fix.kind) {
    case 'skill_disable':          return `Skill ${fix.skill} switched off for @${fix.agent}`;
    case 'skill_inline_off':       return `Skill ${fix.skill} is no longer loaded inline for @${fix.agent}`;
    case 'memory_retire':          return `Memory row #${fix.id} of ${fix.channel} retired`;
    case 'conflicts_resolve':      return `Config conflicts of @${fix.agent}${fix.channel ? ` (${fix.channel})` : ''} resolved${extra ? ` (${extra})` : ''}`;
    case 'tools_allow_add':        return `Tools ${fix.tools.join(', ')} allowed for ${fix.channel}`;
    case 'hashtag_min_zero':       return `Minimum hashtags of ${fix.channel} set to 0`;
    case 'series_resume':          return `Paused series of ${fix.channel} resumed`;
    case 'series_source_require':  return `Series "${fix.series}" of ${fix.channel} now requires its source (locked as the owner's)`;
    case 'source_drop':            return `Source ${fix.sourceId} removed from ${fix.channel}`;
    case 'host_proxy_add':         return `${fix.host} is now read through the proxy`;
  }
}

/** The button text of a fix (English). A fix that locks a series says so. */
export function fixLabel(fix: Fix): string {
  switch (fix.kind) {
    case 'skill_disable':          return 'Switch the skill off';
    case 'skill_inline_off':       return 'Stop loading the skill inline';
    case 'memory_retire':          return 'Retire the row';
    case 'conflicts_resolve':      return fix.channel ? 'Resolve for this channel' : 'Resolve the conflicts';
    case 'tools_allow_add':        return `Allow ${fix.tools.join(', ')}`;
    case 'hashtag_min_zero':       return 'Set minimum hashtags to 0';
    case 'series_resume':          return 'Resume the series';
    case 'series_source_require':  return 'Require the source (the series becomes yours and is locked)';
    case 'source_drop':            return 'Remove the source from the card';
    case 'host_proxy_add':         return `Read ${fix.host} through the proxy`;
  }
}

const unavailable = (what: string) => refusal('fix_unavailable', `${what} is not wired in this process`);

/** A 076 fix's answer as a fix result; its refusal (`source_not_found`, `proxy_not_configured`, …) is thrown like the others. */
function sourceFixResult(r: { ok: boolean; applied?: string; error?: string }, subject: string, fix: Fix): FixResult {
  if (!r.ok) throw refusal(r.error ?? 'fix_failed', subject);
  return { ok: true, applied: r.applied ?? describeFix(fix) };
}

/** Each fix is one call to the service that owns the change; anything that does not apply throws with the reason. */
export async function runFix(p: FixPorts, fix: Fix): Promise<FixResult> {
  switch (fix.kind) {
    case 'skill_disable':
      await p.patchSkill(fix.agent, fix.skill, { enabled: false });
      return { ok: true, applied: describeFix(fix) };
    case 'skill_inline_off':
      await p.patchSkill(fix.agent, fix.skill, { inline: false });
      return { ok: true, applied: describeFix(fix) };
    case 'memory_retire': {
      if (!(await p.retireMemory(fix.channel, fix.id))) throw refusal('nothing_to_retire', 'the row is already inactive');
      return { ok: true, applied: describeFix(fix) };
    }
    case 'conflicts_resolve': {
      const orch = await p.agentByHandle(fix.agent);
      if (!orch) throw refusal('agent_not_found', `@${fix.agent}`);
      const scope = fix.codes?.length || fix.channel
        ? { ...(fix.codes?.length ? { codes: fix.codes } : {}), ...(fix.channel ? { ref: `telegram:${fix.channel}` } : {}) }
        : null;
      // The weekly audit's fix passes no scope: the call is the one it always made.
      const r = scope ? await p.applyConflicts(orch, scope) : await p.applyConflicts(orch);
      if (!r.applied.length) throw refusal('nothing_to_apply', 'the conflicts are already resolved or need a manual change');
      return { ok: true, applied: describeFix(fix, `${r.applied.length} applied, ${r.remaining.length} left`) };
    }
    case 'tools_allow_add': {
      if (!p.addCardTools) throw unavailable('allowing a tool');
      if (!fix.tools.length) throw refusal('nothing_to_apply', 'no tool to allow');
      await p.addCardTools(fix.channel, fix.tools);
      return { ok: true, applied: describeFix(fix) };
    }
    case 'hashtag_min_zero': {
      if (!p.setHashtagMin) throw unavailable('the hashtag minimum');
      await p.setHashtagMin(fix.channel, 0);
      return { ok: true, applied: describeFix(fix) };
    }
    case 'series_resume': {
      if (!p.seriesPause || !p.resumeSeriesPause) throw unavailable('resuming a series');
      const pause = await p.seriesPause(fix.pauseId);
      if (!pause) throw refusal('pause_not_found', fix.pauseId);
      if (pause.cause === 'owner') throw refusal('owner_pause', 'the owner paused this series; only the owner resumes it');
      if (pause.resumed) throw refusal('already_resumed', fix.pauseId);
      await p.resumeSeriesPause(fix.pauseId);
      return { ok: true, applied: describeFix(fix) };
    }
    case 'series_source_require': {
      if (!p.requireSeriesSource) throw unavailable('requiring a series source');
      await p.requireSeriesSource(fix.channel, fix.series);
      return { ok: true, applied: describeFix(fix) };
    }
    // Spec 076 (lead, 076 merge): the two source fixes run through 076's own functions, which the Sources panel's buttons call too.
    case 'source_drop': {
      if (!p.sourceDrop) throw unavailable('removing a source');
      return sourceFixResult(await applySourceDrop(p.sourceDrop, fix), `${fix.channel} ${fix.sourceId}`, fix);
    }
    case 'host_proxy_add': {
      if (!p.hostProxy) throw unavailable('the source proxy');
      return sourceFixResult(await applyHostProxyAdd(p.hostProxy, fix), fix.host, fix);
    }
  }
}

/** `runFix` that never throws: a refusal or a failure becomes `{ ok: false, error: '<code>: <details>' }`. */
export async function tryFix(p: FixPorts, fix: Fix): Promise<FixResult> {
  try {
    return await runFix(p, fix);
  } catch (err: any) {
    return { ok: false, error: fixErrorText(err) };
  }
}
