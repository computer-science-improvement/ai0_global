import type { ToolContext } from '../harness/tool';
import { channelOf } from '../harness/tool';
import type { Agent } from '../agents/agent.types';
import type { AgentsRepository } from '../agents/agents.repository';
import { MAX_FOLLOW_UPS, type FollowUp } from '../agents/pending-actions';
import { conflictFollowUps, detachKey } from '../agents/skill-conflict-followups';
import type { AgentChatExtras } from '../agents/builder-tools';
import type { SkillStore } from '../agents/skill-store';
import { lintOwnerRule } from '../agents/rule-lint';
import { OWNER_RULE_KIND, ruleSources, ruleToStore } from '../agents/agent-chat-tools';
import { isProtectedSkill } from '../skills/skill-library';
import { isFail, type ScheduleService } from '../schedule/schedule.service';
import { scopeOf } from '../schedule/schedule-tools';

/**
 * Spec 069 FR-002: «бери з X, не бери Y» is one card. `import_list` brings the dataset; the bundle is what the owner
 * confirms with the same Apply — the series bound to the new dataset (a required source), the rule «не бери Y», and the
 * skills that say otherwise — as follow-ups the card runs one by one (agents/pending-actions.ts). Nothing here writes:
 * every item is checked now (the series against the dataset that does not exist yet) and again when the card is applied.
 */
export interface BundleDeps {
  schedule?: ScheduleService;
  agents?:   Pick<AgentsRepository, 'children' | 'get'>;
  skills?:   Pick<SkillStore, 'listForAgent' | 'findShared'>;
  /** The agent handles of the network (a rule naming an unknown @agent is refused, like add_owner_rule). */
  handles?:  () => Promise<string[]>;
}

export interface BundleInput {
  dataset:         string;
  series?:         string;
  stop_using?:     string;
  disable_skills?: string[];
}

export interface BundleFail { error: string; details?: unknown; hint?: string }

/** Series item of the bundle: bound to the dataset the import creates (required: no other source fills the slot). */
export const SERIES_ITEM = 'series';
export const RULE_ITEM = 'rule';
export { detachKey };

const failOf = (f: { error: string; details?: unknown }): BundleFail => ({ error: f.error, ...(f.details !== undefined ? { details: f.details } : {}) });

/** The follow-ups of an `import_list` call, or the reason there are none. An empty bundle is a plain import card. */
export async function buildBundle(d: BundleDeps, ctx: ToolContext, i: BundleInput, dataset: { entity?: string | null }): Promise<{ then: FollowUp[]; notes: string[] } | BundleFail> {
  const then: FollowUp[] = [];
  const notes: string[] = [];
  const x = (ctx.extras ?? {}) as Partial<AgentChatExtras> & { agent?: Agent | null; skills?: { get(name: string): unknown } };

  // The agent whose series and skills these are: the orchestrator of the chat's channel.
  const needScope = !!i.series || !!i.disable_skills?.length;
  let scope: Awaited<ReturnType<typeof scopeOf>> | null = null;
  if (needScope) {
    if (!d.schedule) return { error: 'not_available', details: 'series and skills cannot be changed in this context' };
    scope = await scopeOf({ schedule: d.schedule }, ctx);
    if (isFail(scope)) return failOf(scope);
  }

  if (i.series && scope && !isFail(scope) && d.schedule) {
    const prep = await d.schedule.prepareSeriesChange(
      scope, 'update', { name: i.series, source: { kind: 'library', table: i.dataset }, source_mode: 'required' },
      { pendingTables: [i.dataset], ...(dataset.entity ? { pendingEntities: { [i.dataset]: dataset.entity } } : {}) });
    if (isFail(prep)) return failOf(prep);
    then.push({
      key: SERIES_ITEM, kind: 'series_change', requires: 'main_rows',
      payload: { agent_id: scope.agent.id, op: 'update', fields: prep.fields, before: prep.before },
      summary: `Series change for @${scope.agent.handle}: ${prep.diff}`,
    });
  }

  if (i.stop_using) {
    const channel = channelOf(ctx);
    if (!channel) return { error: 'no_channel', details: 'у цій розмові немає каналу — назви канал, для якого правило' };
    const handles = d.handles ? await d.handles().catch(() => undefined) : undefined;
    const lint = (t: string) => lintOwnerRule(t, {
      skillExists: async (name) => !!(x.skills?.get(name) || await d.skills?.findShared(name).catch(() => null)),
      handles,
    });
    // The same path as add_owner_rule: the owner's list if the text only points at it, then the rule lint.
    const built = await ruleToStore({ text: i.stop_using }, x.ownerText ?? '', lint);
    if (built.issues.length) {
      return {
        error: 'rule_lint_failed', details: built.issues.map((v) => `${v.code}: ${v.detail}`).join('; '),
        hint: 'stop_using — саме правило власника (чого не брати), його словами; нічого не запропоновано',
      };
    }
    const sources = ruleSources(built.text, x.ownerRecent?.length ? x.ownerRecent : [x.ownerText ?? '']);
    const quotes = sources.filter((s) => s.overlap > 0).slice(0, 3).map((s) => s.text.slice(0, 400));
    then.push({
      key: RULE_ITEM, kind: OWNER_RULE_KIND,
      payload: { channel, kind: 'avoid', text: built.text, quotes: quotes.length ? quotes : sources.slice(0, 2).map((s) => s.text.slice(0, 400)) },
      summary: `Owner rule for ${channel}: ${built.text}`,
    });
  }

  if (i.disable_skills?.length && scope && !isFail(scope)) {
    if (!d.skills || !d.agents) return { error: 'not_available', details: 'skills cannot be changed in this context' };
    const orch = scope.agent;
    const chain = [orch, ...await d.agents.children(orch.id)];
    const entries = await d.skills.listForAgent(chain.map((a) => a.id));
    const owners = new Map(chain.map((a) => [a.id, a]));
    for (const name of new Set(i.disable_skills)) {
      const e = entries.find((s) => s.skill.name === name);
      if (!e) {
        return {
          error: 'unknown_skill', details: `скіла "${name}" немає у ${orch.handle}`,
          hint: `скіли агента: ${entries.filter((s) => s.enabled).map((s) => s.skill.name).slice(0, 40).join(', ') || '—'}`,
        };
      }
      if (e.skill.safety || isProtectedSkill(name)) return { error: 'safety_skill', details: `"${name}" — системний скіл голосу чи безпеки, його не вимикають карткою імпорту` };
      if (!e.enabled) { notes.push(`скіл "${name}" уже вимкнений`); continue; }
      // The handle patchSkill needs is the agent that owns the skill; a shared skill is switched off on the orchestrator.
      const handle = (e.skill.agentId ? owners.get(e.skill.agentId) : null)?.handle ?? orch.handle;
      then.push({ key: detachKey(name), kind: 'detach_skill', payload: { handle, skill: name }, summary: `Disable skill "${name}" for @${handle}` });
    }
  }

  // Spec 069 FR-003 / A7: the skills that still tell the agent to use what the owner just dropped («не використовуй X»).
  if (i.stop_using && d.skills && d.agents && d.schedule && then.length < MAX_FOLLOW_UPS) {
    const sc = scope && !isFail(scope) ? scope : await scopeOf({ schedule: d.schedule }, ctx);
    if (!isFail(sc)) {
      const found = await conflictFollowUps({ agents: d.agents, skills: d.skills }, sc.agent, { body: `не використовуй ${i.stop_using}` },
        { skip: new Set(then.map((t) => t.key)), limit: MAX_FOLLOW_UPS - then.length });
      for (const t of found.then) {
        then.push(t);
        notes.push(`скіл "${String(t.payload.skill)}" суперечить правилу — додано до картки ${t.ticked === false ? 'невідміченим' : 'відміченим'}: ${t.summary.replace(/^[^:]*: /, '')}`);
      }
      if (found.error) notes.push(`конфлікти зі скілами не перевірено: ${found.error}`);
    }
  }
  return { then, notes };
}

/** One line for the card's summary: what follows the import. */
export function thenLine(then: readonly FollowUp[]): string {
  if (!then.length) return '';
  const part = (t: FollowUp): string =>
    t.key === SERIES_ITEM ? 'bind the series to the dataset (required)'
      : t.key === RULE_ITEM ? 'save the rule'
        : t.kind === 'detach_skill' ? `${t.ticked === false ? 'suggest disabling' : 'disable'} skill “${String(t.payload.skill)}”${t.ticked === false ? ' (unticked)' : ''}`
          : t.summary.slice(0, 80);
  return `Then, in this order: ${then.map(part).join('; ')}. Untick what you do not want.`;
}
