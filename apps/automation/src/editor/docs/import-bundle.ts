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
import { isFail, type ScheduleScope, type ScheduleService } from '../schedule/schedule.service';
import { scopeOf } from '../schedule/schedule-tools';
import { SERIES_PAUSE_RESUME_KIND } from '../series-pause/pause-resume-action';
import { seriesNameOfKey, type SeriesPause, type SeriesPausesRepository } from '../series-pause/series-pauses.repository';

/**
 * Spec 069 FR-002: «бери з X, не бери Y» is one card. `import_list` brings the dataset; the bundle is what the owner
 * confirms with the same Apply — the series bound to the new dataset (a required source), the rule «не бери Y», and the
 * skills that say otherwise — as follow-ups the card runs one by one (agents/pending-actions.ts). Nothing here writes:
 * every item is checked now (the series against the dataset that does not exist yet) and again when the card is applied.
 *
 * Wave fix 068 × 069: the dead-series breaker pauses a series (or a channel's plain slots) whose source is spent, so a card
 * that rebinds the series must also lift that pause or nothing is ever posted from the new source. The pause the series
 * has, if any, is a follow-up right after the series item (ticked); a pause of the channel itself is a soft suggestion
 * (unticked): it also holds the channel's other plain slots.
 */
export interface BundleDeps {
  schedule?: ScheduleService;
  agents?:   Pick<AgentsRepository, 'children' | 'get'>;
  skills?:   Pick<SkillStore, 'listForAgent' | 'findShared'>;
  /** The agent handles of the network (a rule naming an unknown @agent is refused, like add_owner_rule). */
  handles?:  () => Promise<string[]>;
  /** Open pauses (`series_pauses`, spec 060): the card resumes the pause of the series it rebinds. Without it no resume item is offered. */
  pauses?:   Pick<SeriesPausesRepository, 'open'>;
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
/** The series' own pause, lifted right after the series is bound (ticked); the channel's pause beside it (unticked). */
export const RESUME_ITEM = 'resume';
export const RESUME_CHANNEL_ITEM = 'resume_channel';
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
    then.push(...await resumeItems(d, scope, i, notes));
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

  const over = fitFollowUps(then, notes);
  if (over) return over;

  // Spec 069 FR-003 / A7: the skills that still tell the agent to use what the owner just dropped («не використовуй X»).
  if (i.stop_using && d.skills && d.agents && d.schedule && then.length < MAX_FOLLOW_UPS) {
    const sc = scope && !isFail(scope) ? scope : await scopeOf({ schedule: d.schedule }, ctx);
    if (!isFail(sc)) {
      const found = await conflictFollowUps({ agents: d.agents, skills: d.skills }, sc.agent, { body: `не використовуй ${i.stop_using}` },
        { skip: new Set(then.map((t) => t.key)), limit: MAX_FOLLOW_UPS - then.length, keep: [i.dataset] });
      for (const t of found.then) {
        then.push(t);
        notes.push(`скіл "${String(t.payload.skill)}" суперечить правилу — додано до картки ${t.ticked === false ? 'невідміченим' : 'відміченим'}: ${t.summary.replace(/^[^:]*: /, '')}`);
      }
      if (found.error) notes.push(`конфлікти зі скілами не перевірено: ${found.error}`);
    }
  }
  return { then, notes };
}

/**
 * A card carries at most MAX_FOLLOW_UPS items. The resume items are the only ones that can tip it over (series + rule + 5 skills
 * already make 7), and the unticked ones are only suggestions: the channel's goes first, then the series' own when the owner paused
 * it by hand. Each leaves a note for the model. Still over: the tool says so, instead of `propose` throwing.
 */
function fitFollowUps(then: FollowUp[], notes: string[]): BundleFail | null {
  const drop = (key: string, note: string): void => {
    const at = then.findIndex((t) => t.key === key && t.ticked === false);
    if (at < 0) return;
    then.splice(at, 1);
    notes.push(note);
  };
  if (then.length > MAX_FOLLOW_UPS) drop(RESUME_CHANNEL_ITEM, `паузу каналу не додано до картки: забагато пунктів (максимум ${MAX_FOLLOW_UPS}) — канал на паузі не планується, тож скажи власнику відновити його окремо (Overview → Paused series)`);
  if (then.length > MAX_FOLLOW_UPS) drop(RESUME_ITEM, `паузу серії, яку поставив власник, не додано до картки: забагато пунктів (максимум ${MAX_FOLLOW_UPS}) — її відновлюють окремо`);
  if (then.length <= MAX_FOLLOW_UPS) return null;
  return {
    error: 'too_many_follow_ups', details: `картка мала б ${then.length} пунктів, а максимум ${MAX_FOLLOW_UPS}`,
    hint: 'назви менше скілів у disable_skills (або без stop_using) і виклич ще раз',
  };
}

const CAUSE_TEXT: Record<SeriesPause['cause'], string> = {
  no_material: 'no material to post from', source_unreachable: 'source unreachable', owner: 'paused by the owner',
};
const oneLine = (t: string, n = 140): string => { const x = t.replace(/\s+/g, ' ').trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x; };
const why = (p: SeriesPause): string => `${CAUSE_TEXT[p.cause]}${p.reason ? `: ${oneLine(p.reason)}` : ''}`;

/**
 * The resume items of a card that binds `i.series`: the series' own open pause (`series:<name>`, only for an import that found
 * rows, and only if the series now reads the new dataset — ticked when the breaker made it, unticked when the owner paused the
 * series by hand: a new source is not a reason to undo their decision), and the channel's plain-slot pause (`resource:telegram:<channel>`,
 * unticked, a suggestion; a paused channel is not planned at all, the series included, so the text of the item says so). Each item stores
 * the pause id and its key: Apply looks the pause up again by key when the id was resumed meanwhile (pause-resume-action). A pause that
 * first opens after the card was proposed has no item. A read error offers nothing and says so in the notes.
 */
async function resumeItems(d: BundleDeps, scope: ScheduleScope, i: BundleInput, notes: string[]): Promise<FollowUp[]> {
  if (!d.pauses || !i.series) return [];
  let open: SeriesPause[];
  try { open = await d.pauses.open(scope.card.channelKey); } catch (err: any) {
    notes.push(`паузи серій не перевірено: ${String(err?.message ?? err).slice(0, 120)}`);
    return [];
  }
  const out: FollowUp[] = [];
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const own = open.find((p) => same(seriesNameOfKey(p.key) ?? '\u0000', i.series!));
  if (own) {
    out.push({
      key: RESUME_ITEM, kind: SERIES_PAUSE_RESUME_KIND, requires: 'main_rows', ...(own.cause === 'owner' ? { ticked: false } : {}),
      payload: { pause_id: own.id, key: own.key, channel_key: own.channelKey, series: i.series, dataset: i.dataset, agent_id: scope.agent.id },
      summary: `Resume series "${i.series}" on ${own.channelKey} (paused: ${why(own)})`,
    });
  }
  const channel = open.find((p) => same(p.key, `resource:telegram:${scope.card.channelKey}`));
  if (channel) {
    out.push({
      key: RESUME_CHANNEL_ITEM, kind: SERIES_PAUSE_RESUME_KIND, requires: 'main_rows', ticked: false,
      payload: { pause_id: channel.id, key: channel.key, channel_key: channel.channelKey },
      summary: `Resume the plain slots of ${channel.channelKey} (paused: ${why(channel)}) — unticked: while the channel is paused nothing on it is planned, the series bound on this card included`,
    });
  }
  return out;
}

/** One line for the card's summary: what follows the import. */
export function thenLine(then: readonly FollowUp[]): string {
  if (!then.length) return '';
  const part = (t: FollowUp): string =>
    t.key === SERIES_ITEM ? 'bind the series to the dataset (required)'
      : t.key === RULE_ITEM ? 'save the rule'
        : t.key === RESUME_ITEM ? (t.ticked === false ? 'suggest resuming the series you paused (unticked)' : 'resume the paused series')
          : t.key === RESUME_CHANNEL_ITEM ? 'suggest resuming the channel (unticked: the channel and the series bound on this card are not planned until it is ticked)'
            : t.kind === 'detach_skill' ? `${t.ticked === false ? 'suggest disabling' : 'disable'} skill “${String(t.payload.skill)}”${t.ticked === false ? ' (unticked)' : ''}`
              : t.summary.slice(0, 80);
  return `Then, in this order: ${then.map(part).join('; ')}. Untick what you do not want.`;
}
