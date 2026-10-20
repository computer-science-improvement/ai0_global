import type { SteeringPromptRule } from '../steering/steering.types';
import { RECENT_TOPIC_DAYS, recentTopicsBlock, recentTopicsOf } from '../story/recent-topics';
import { plannerStyleLine } from '../rules/owner-style-overlay';
import type { EditorCard } from '../card';
import type { AgentLoop, AgentLoopResult } from '../harness/agent-loop';
import type { ToolRegistry } from '../harness/tool-registry';
import { resolveModel } from '../llm/model-registry';
import { agentModelIn, readModelContext, type Workspace } from '../llm/workspace';
import type { EditorRole } from '../llm/llm.types';
import type { EditorMemoryRepository } from '../repo/editor-memory.repository';
import { APPROVAL_PREFS_IN_PROMPT } from '../approval/owner-preferences';
import type { EditorPlansRepository, EditorSlot } from '../repo/editor-plans.repository';
import { buildSystemPrompt, plannerUserPrompt } from '../roles/prompts';
import { localDate, zonedToUtc } from '../roles/time';
import type { AgentRuntime, RunAgentContext } from '../agents/agent-runtime';
import type { Agent } from '../agents/agent.types';
import { intersectAllow, type LoadoutService } from '../loadout/loadout.service';
import { profileCaps, renderFormatPrefs, renderProfile, ResourceProfile, ResourceProfilesRepository } from '../agents/resource-profile';
import { networkContext, NetworkContextDeps, NetworkCtx } from './network-context';
import type { IdeaRow, NetworkRepository } from './network.repository';
import { ideaQuota, REVIEW_BATCH } from './network-tools';
import {
  ideaNovelty, ideaReviewerSystemPrompt, ideaReviewerUserPrompt, networkPlannerBlock, orchestratorDailyPrompt, orchestratorSystemPrompt, playbookBuildPrompt,
} from './network-prompts';
import { renderExamples, renderSection } from './playbook';
import { renderExperimentQuotas, type ExperimentQuota } from '../manager/experiment-quota';

export interface NetworkRunnerDeps {
  loop:     Pick<AgentLoop, 'run'>;
  registry: Pick<ToolRegistry, 'forRole'>;
  runtime:  Pick<AgentRuntime, 'forChannel'>;
  /** Spec 054: the agent's own tool set; its allowlist narrows the channel's. Optional for tests. */
  loadout?: Pick<LoadoutService, 'allowFor'>;
  memory:   Pick<EditorMemoryRepository, 'listActive'> & Partial<Pick<EditorMemoryRepository, 'ownerPreferences'>>;
  repo:     NetworkRepository;
  plans:    Pick<EditorPlansRepository, 'reservedSlots'>;
  profiles: Pick<ResourceProfilesRepository, 'get'> & Partial<Pick<ResourceProfilesRepository, 'formatOf'>>;
  usable?:  NetworkContextDeps['usable'];
  /** Spec 024: per-resource zones and quiet hours. */
  time?:    NetworkContextDeps['time'];
  /** Spec 025 FR-013: resources paused by a pause_resource directive stay out of every run's network. */
  paused?:  NetworkContextDeps['paused'];
  /** Spec 021: open directives for the orchestrator, rendered for the prompt (null when none). */
  directives?: (orch: Agent) => Promise<string | null>;
  /** Spec 021: after an orchestrator run, accepted directives become applied. */
  afterOrchestration?: (orch: Agent) => Promise<unknown>;
  env:      (key: string) => string | undefined;
  /** The owner's global default model (spec 035, app_settings `ai.default_model`); cached by ModelDefaultsStore. */
  defaultModel?: (ws?: Workspace) => Promise<string | null>;
  /** Spec 038: the active model workspace. */
  workspace?: () => Promise<Workspace>;
  notify:   (text: string) => Promise<void>;
  now?:     () => Date;
  /** Spec 045 FR-005: the steering rules of a resource's active sets (enabled, non-conflicting); absent = none. */
  steering?: (targetRef: string) => Promise<SteeringPromptRule[]>;
  /** Spec 046 FR-003: the manager's advice / directives the orchestrator accepted and that are in force (planner block). */
  commitments?: (orchestratorId: string) => Promise<string | null>;
  /** Spec 023 FR-008: the ≤ 1,500-char source catalog for the orchestrator and planner prompts. */
  catalogSummary?: (card: EditorCard) => Promise<string | null>;
  /** Spec 023 FR-008: low_runway Inbox items for datasets the active series use (after the daily run). */
  runwayCheck?: (orch: Agent, playbook: unknown) => Promise<unknown>;
  /** Spec 025 FR-014: open experiment quotas of an anchor for a plan date (shown to the planners). */
  experimentQuotas?: (anchorKey: string, planDate: string, now: Date) => Promise<ExperimentQuota[]>;
  /** Spec 053 FR-005: the network's last 7 days as prompt lines (network-stats.ts); null for none. */
  statsSummary?: (refs: string[]) => Promise<string | null>;
  /** Spec 037 T2: the "Active stories (14 days)" block of the planner / writer prompt (story/story-context.ts); null for none. */
  stories?: { activeBlock(card: EditorCard, role: 'planner' | 'executor', now: Date): Promise<string | null> };
  /** Spec 049 FR-004: the card's failing sources the daily run is asked to replace today (a prompt block); null for none. */
  sourcesToReplace?: (card: EditorCard, orchestratorId: string) => Promise<string | null>;
}

const STEPS: Record<string, number> = { orchestrate: 15, playbook: 18, ideaReview: 6, plan: 14 };
/**
 * Spec 053 FR-005: tools the daily orchestration never needs — the playbook is in its prompt, raw SQL and dataset
 * edits are other roles' work. Every tool schema is re-sent on every step.
 */
export const ORCHESTRATOR_EXCLUDE = new Set(['get_playbook', 'sql_readonly', 'edit_data_schema', 'search_library']);
/**
 * Spec 053 FR-004: the reviewer's tools — the batch verdict, the playbook review, a source check and its skill. Novelty
 * is computed by code into the prompt, so get_network_posts and SQL (9.6 calls a run) are not offered.
 */
export const IDEA_REVIEW_TOOLS = new Set(['review_ideas', 'review_playbook', 'get_playbook', 'list_ideas', 'web_fetch', 'load_skill', 'finish_idea_review']);
/** Spec 053 FR-004: fewer new ideas than this wait for the next run — unless the oldest has waited a day. */
export const IDEA_REVIEW_MIN = 3;
const IDEA_REVIEW_MAX_WAIT_MS = 24 * 3600_000;
const TERMINAL_EXCLUDE_SINGLE = new Set(['submit_network_plan']);
const TERMINAL_EXCLUDE_NETWORK = new Set(['submit_plan']);

/**
 * Orchestrator-level runs (spec 020): the daily orchestration (directives,
 * idea pool), playbook builds, the idea reviewer and the network day planner.
 * Every run is recorded on its registry agent like the editor roles.
 */
export class NetworkRunner {
  private readonly building = new Set<string>();

  constructor(private readonly d: NetworkRunnerDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  async context(card: EditorCard, role: EditorRole = 'orchestrator'): Promise<{ agentCtx: RunAgentContext; net: NetworkCtx } | null> {
    const agentCtx = await this.d.runtime.forChannel(card.channelKey, role);
    if (!agentCtx.orchestrator) return null;
    const net = await networkContext({ repo: this.d.repo, usable: this.d.usable, time: this.d.time, paused: this.d.paused }, agentCtx.orchestrator, card);
    return net ? { agentCtx, net } : null;
  }

  private async profileText(net: NetworkCtx): Promise<string | null> {
    const p = (await this.d.profiles.get(`telegram:${net.anchorKey}`))?.profile
      ?? (net.groupId ? (await this.d.profiles.get(`network:${net.groupId}`))?.profile : null);
    return p ? renderProfile(p, { now: this.now(), ref: `telegram:${net.anchorKey}` }) : null;
  }

  private async run(role: EditorRole, card: EditorCard, c: { agentCtx: RunAgentContext; net: NetworkCtx }, system: string, user: string, steps: number, extras: Record<string, unknown> = {}, exclude?: Set<string>, allow?: Set<string>): Promise<AgentLoopResult> {
    const agent = c.agentCtx.agent ?? c.agentCtx.orchestrator!;
    const { workspace, defaultModel } = await readModelContext(this.d);
    const model = agentModelIn(agent, workspace) ?? agentModelIn(c.agentCtx.orchestrator, workspace);
    const effort = agent.reasoningEffort ?? c.agentCtx.orchestrator?.reasoningEffort ?? null;
    const loadoutAllow = this.d.loadout ? await this.d.loadout.allowFor(agent, { role, registry: this.d.registry }) : null;
    return this.d.loop.run({
      role, channelKey: card.channelKey, model: resolveModel(role, this.d.env, card.models, { agentModel: model, defaultModel, reasoningEffort: effort, workspace }),
      system, user, tools: this.d.registry.forRole(role, intersectAllow(card.toolsAllow, loadoutAllow)).filter((t) => !exclude?.has(t.name) && (!allow || allow.has(t.name))), maxSteps: steps,
      channelBudgetUsd: card.dailyBudgetUsd,
      agent: { id: agent.id, handle: agent.handle, limitUsd: agent.dailyBudgetUsd ?? c.agentCtx.orchestrator?.dailyBudgetUsd ?? null },
      extras: { card, network: c.net, skills: c.agentCtx.skills, agent, orchestrator: c.agentCtx.orchestrator, ...extras },
    });
  }

  /** Spec 023 FR-008: the source catalog summary (best-effort; a prompt never fails on it). */
  private async catalog(card: EditorCard): Promise<string | null> {
    return this.d.catalogSummary ? this.d.catalogSummary(card).catch(() => null) : null;
  }

  private paused(c: { agentCtx: RunAgentContext } | null): boolean {
    return !c || c.agentCtx.paused;
  }

  /** The daily run: directives, then the idea pool (and minor playbook upkeep). Builds a playbook first when there is none. */
  async runOrchestrator(card: EditorCard, o: { wake?: boolean } = {}): Promise<AgentLoopResult | null> {
    const c = await this.context(card);
    if (this.paused(c)) return null;
    const { net } = c!;
    const directives = this.d.directives ? await this.d.directives(net.orchestrator) : null;
    // Spec 046 FR-007: a wake-up run is for the directives that woke it — none left (delivered by another run) → no run.
    if (o.wake && !directives) return null;
    // Directives are always answered first; a playbook build waits for a run without them.
    if (!directives && !net.playbook && !(await this.d.repo.pendingPlaybook(net.orchestrator.id))) {
      // A playbook the owner rejected recently is not rebuilt every day: ideas go on without one until the owner asks.
      const last = (await this.d.repo.playbookHistory(net.orchestrator.id, 1))[0];
      const recentlyRejected = last?.status === 'rejected' && last.decidedAt && this.now().getTime() - last.decidedAt.getTime() < 7 * 86_400_000;
      if (!recentlyRejected) return this.runPlaybookBuild(card, card.brief || null);
    }
    await this.d.repo.expireIdeas(net.orchestrator.id, this.now());
    const open = await this.d.repo.listIdeas(net.orchestrator.id, ['new', 'accepted', 'needs_revision'], 200);
    // Spec 046 FR-007: one idea feeds every resource it has a variant for, so a day needs about the busiest resource's slots.
    const slotsPerDay = net.playbook?.platforms.length ? Math.max(...net.playbook.platforms.map((s) => s.per_day.max)) : card.postsPerDayMax;
    const quota = ideaQuota(slotsPerDay, open.filter((i) => i.status === 'accepted' || i.status === 'new').length);
    await this.d.repo.releaseStalePlanned(net.orchestrator.id);
    // Spec 049 FR-004: sources that keep failing are work too — the run looks for a replacement and proposes it.
    const sources = this.d.sourcesToReplace ? await this.d.sourcesToReplace(card, net.orchestrator.id).catch(() => null) : null;
    // Spec 053 FR-005: nothing to answer, no ideas to add or revise — the day's upkeep runs without the model.
    if (!directives && !quota && !open.some((i) => i.status === 'needs_revision') && !sources) {
      if (this.d.afterOrchestration) await this.d.afterOrchestration(net.orchestrator).catch(() => {});
      if (this.d.runwayCheck) await this.d.runwayCheck(net.orchestrator, net.playbook).catch(() => {});
      await this.runIdeaReview(card);
      return null;
    }
    const memory = await this.d.memory.listActive(card.channelKey);
    const res = await this.run('orchestrator', card, c!,
      orchestratorSystemPrompt({ net, card, profile: await this.profileText(net), memory, skills: c!.agentCtx.skills, directives, profiles: await this.memberProfiles(net) }),
      [orchestratorDailyPrompt({ net, card, now: this.now(), open, quota, hasDirectives: !!directives }), await this.catalog(card),
        // Spec 041 FR-004: the network's topics of 30 days (add_idea refuses an evergreen idea on one).
        recentTopicsBlock(recentTopicsOf(await this.d.repo.recentExcerpts(net.resources.map((r) => r.ref), RECENT_TOPIC_DAYS).catch(() => []))),
        this.d.statsSummary ? await this.d.statsSummary(net.resources.map((r) => r.ref)).catch(() => null) : null, sources].filter(Boolean).join('\n\n'),
      STEPS.orchestrate, { brief: card.brief, ideaQuota: quota, newsRefs: await this.newsRefs(net) }, ORCHESTRATOR_EXCLUDE);
    if (this.d.afterOrchestration) await this.d.afterOrchestration(net.orchestrator).catch(() => {});
    if (this.d.runwayCheck) await this.d.runwayCheck(net.orchestrator, net.playbook).catch(() => {});
    await this.runIdeaReview(card);
    return res;
  }

  /**
   * Brief → playbook (spec 020 FR-003); one build at a time per agent. `directiveId` (spec 025 FR-015): a build for
   * a strategy directive — its version goes to the owner and carries the directive id.
   */
  async runPlaybookBuild(card: EditorCard, brief: string | null, opts: { directiveId?: string } = {}): Promise<AgentLoopResult | null> {
    const c = await this.context(card);
    if (this.paused(c)) return null;
    const key = c!.net.orchestrator.id;
    if (this.building.has(key)) return null;
    this.building.add(key);
    try {
      const memory = await this.d.memory.listActive(card.channelKey);
      const res = await this.run('orchestrator', card, c!,
        orchestratorSystemPrompt({ net: c!.net, card, profile: await this.profileText(c!.net), memory, skills: c!.agentCtx.skills }),
        playbookBuildPrompt({ net: c!.net, brief, now: this.now(), tz: card.timezone }),
        STEPS.playbook, { brief, ...(opts.directiveId ? { directiveId: opts.directiveId } : {}) });
      if (res.terminalTool === 'submit_playbook') await this.runIdeaReview(card);
      else await this.safeNotify(`📘 @${c!.net.orchestrator.handle}: не вдалося скласти плейбук (${res.status}${res.error ? `: ${res.error}` : ''}).`);
      return res;
    } finally {
      this.building.delete(key);
    }
  }

  async runIdeaReview(card: EditorCard): Promise<AgentLoopResult | null> {
    const c = await this.context(card, 'idea_reviewer');
    if (this.paused(c)) return null;
    // Spec 040 FR-004: the oldest new ideas go into the prompt, so the reviewer starts reviewing at once.
    const queue = await this.d.repo.pageIdeas(c!.net.orchestrator.id, ['new'], { limit: REVIEW_BATCH, offset: 0, oldestFirst: true });
    const fresh = queue.total;
    const pending = !!(await this.d.repo.pendingPlaybook(c!.net.orchestrator.id));
    // Spec 053 FR-004: one or two new ideas wait for company (a run costs the same prompt), but not longer than a day.
    const oldest = queue.rows[0]?.createdAt?.getTime() ?? Infinity;
    const due = fresh >= IDEA_REVIEW_MIN || this.now().getTime() - oldest >= IDEA_REVIEW_MAX_WAIT_MS;
    if (!pending && (!fresh || !due)) return null;
    const memory = await this.d.memory.listActive(card.channelKey);
    const system = ideaReviewerSystemPrompt({ net: c!.net, profile: await this.profileText(c!.net), memory, skills: c!.agentCtx.skills });
    const novelty = await this.novelty(c!.net, queue.rows);
    const res = await this.run('idea_reviewer', card, c!, system, ideaReviewerUserPrompt({ fresh, batch: queue.rows, pendingPlaybook: pending, novelty }), STEPS.ideaReview, {}, undefined, IDEA_REVIEW_TOOLS);
    // Spec 046 FR-007: a backlog over one batch gets a second batch at once (only when the first one moved it).
    if (fresh <= REVIEW_BATCH || res.status !== 'ok') return res;
    const next = await this.d.repo.pageIdeas(c!.net.orchestrator.id, ['new'], { limit: REVIEW_BATCH, offset: 0, oldestFirst: true });
    if (!next.total || next.total >= fresh) return res;
    return this.run('idea_reviewer', card, c!, system,
      ideaReviewerUserPrompt({ fresh: next.total, batch: next.rows, pendingPlaybook: false, novelty: await this.novelty(c!.net, next.rows) }),
      STEPS.ideaReview, {}, undefined, IDEA_REVIEW_TOOLS);
  }

  /** Spec 053 FR-004: the novelty line of each idea of a batch (best-effort: no line when the history is unreadable). */
  private async novelty(net: NetworkCtx, ideas: IdeaRow[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!ideas.length) return out;
    const refs = net.resources.map((r) => r.ref);
    const recent = await this.d.repo.recentExcerpts(refs, 14).catch(() => null);
    if (!recent) return out;
    const topics = recentTopicsOf(await this.d.repo.recentExcerpts(refs, RECENT_TOPIC_DAYS).catch(() => []));
    for (const i of ideas) out.set(i.id, ideaNovelty(i, recent, topics));
    return out;
  }

  /**
   * The planner of an independent network (020 FR-007, 024 FR-002). Returns null when the
   * channel is not the anchor of an independent network with a playbook — the
   * caller then runs the single-channel planner (which can use the idea pool too).
   */
  async runNetworkPlanner(card: EditorCard, planDateIn?: string): Promise<AgentLoopResult | null> {
    const c = await this.context(card, 'planner');
    if (!c || c.net.mode !== 'independent' || !c.net.playbook) return null;
    if (c.agentCtx.paused) return null;
    const now = this.now();
    // Spec 031: approval mode plans the next day ahead (its batch is written at 20:00).
    const planDate = planDateIn ?? localDate(now, card.timezone);
    const dayStart = zonedToUtc(planDate, '00:00', card.timezone);
    const reserved = await this.d.plans.reservedSlots(card.channelKey, dayStart, new Date(dayStart.getTime() + 86_400_000));
    const accepted = await this.d.repo.listIdeas(c.net.orchestrator.id, ['accepted'], 100);
    // Spec 031 FR-008: the owner's last approval edits and rejections in their own section.
    const prefs = this.d.memory.ownerPreferences ? await this.d.memory.ownerPreferences(card.channelKey, APPROVAL_PREFS_IN_PROMPT).catch(() => []) : [];
    const memory = await this.d.memory.listActive(card.channelKey, 30, { excludeApprovalPrefs: prefs.length > 0 });
    const profiles = await this.memberProfiles(c.net);
    const steering = this.d.steering ? await this.d.steering(`telegram:${card.channelKey}`).catch(() => []) : [];
    const commitments = this.d.commitments ? await this.d.commitments(c.net.orchestrator.id).catch(() => null) : null;
    // Spec 041 FR-003: the anchor's effective style (owner rules on top) as one line.
    const styleLine = plannerStyleLine(card.style, card.slang);
    const system = `${buildSystemPrompt('planner', card, memory, c.agentCtx.skills, prefs, { steering, commitments })}\n\n${networkPlannerBlock({ net: c.net, accepted, now, tz: card.timezone, planDate, profiles })}${styleLine ? `\n\n${styleLine}` : ''}`;
    const quotas = await this.quotas(card.channelKey, planDate);
    const stories = this.d.stories ? await this.d.stories.activeBlock(card, 'planner', now).catch(() => null) : null;
    const user = [plannerUserPrompt(card, now, reserved, planDate), renderExperimentQuotas(quotas), await this.catalog(card), stories].filter(Boolean).join('\n\n');
    const res = await this.run('planner', card, c, system, user, STEPS.plan, { planDate }, TERMINAL_EXCLUDE_NETWORK);
    if (res.terminalTool !== 'submit_network_plan') {
      await this.safeNotify(`🗓 @${c.net.orchestrator.handle}: план мережі не складено (${res.status}${res.error ? `: ${res.error}` : ''}).`);
    }
    return res;
  }

  /** Spec 046 FR-007: the network's news resources (content_kind news, or a news topic) — their ideas need 2 sources. */
  private async newsRefs(net: NetworkCtx): Promise<string[]> {
    const kinds = await Promise.all(net.resources.map(async (r) => {
      const p = (await this.d.profiles.get(r.ref).catch(() => null))?.profile ?? null;
      return profileCaps(p).kind === 'news' ? r.ref : null;
    }));
    return kinds.filter((r): r is string => !!r);
  }

  /** Spec 024 FR-012: each member resource's own profile (the anchor's is the network profile above), for the per-resource decisions. */
  private async memberProfiles(net: NetworkCtx): Promise<Array<{ ref: string; profile: ResourceProfile | null }>> {
    if (net.mode === 'single') return [];
    const anchor = `telegram:${net.anchorKey}`;
    return Promise.all(net.resources.filter((r) => r.ref !== anchor).map(async (r) => ({
      ref: r.ref, profile: (await this.d.profiles.get(r.ref).catch(() => null))?.profile ?? null,
    })));
  }

  /** Spec 025 FR-014: open experiment quotas (best-effort; a prompt never fails on it). */
  private async quotas(anchorKey: string, planDate: string): Promise<ExperimentQuota[]> {
    return this.d.experimentQuotas ? this.d.experimentQuotas(anchorKey, planDate, this.now()).catch(() => []) : [];
  }

  /**
   * Extras the single-channel planner needs to see the idea pool (list_ideas works on ctx.extras.network) and,
   * spec 025 FR-014, the experiment quotas on this channel.
   */
  async plannerExtras(card: EditorCard, planDate?: string): Promise<{ network: NetworkCtx; excludeTools: Set<string>; ideasNote: string | null } | null> {
    const c = await this.context(card, 'planner');
    if (!c) return null;
    const accepted = await this.d.repo.listIdeas(c.net.orchestrator.id, ['accepted'], 30);
    const anchor = `telegram:${card.channelKey}`;
    const quotas = (await this.quotas(card.channelKey, planDate ?? localDate(this.now(), card.timezone))).filter((q) => q.resourceRef === anchor);
    const notes = [
      accepted.length ? `У пулі ${accepted.length} прийнятих ідей (list_ideas) — плануй насамперед з них і вказуй idea_id.` : null,
      renderExperimentQuotas(quotas),
    ].filter(Boolean);
    return { network: c.net, excludeTools: TERMINAL_EXCLUDE_SINGLE, ideasNote: notes.length ? notes.join('\n') : null };
  }

  /** Context of a non-Telegram slot for the platform executor (019 hook). */
  async platformContext(slot: EditorSlot, orchestratorId: string | null) {
    if (!orchestratorId) return null;
    const pb = await this.d.repo.activePlaybook(orchestratorId);
    const sec = pb?.body.platforms.find((p) => p.resource_ref === slot.resourceRef) ?? null;
    const profile = slot.resourceRef ? (await this.d.profiles.get(slot.resourceRef))?.profile ?? null : null;
    const idea = slot.ideaId ? await this.d.repo.idea(slot.ideaId) : null;
    // Spec 024 FR-013: the target's format_prefs (Telegram slots: the anchor channel's).
    const fmt = this.d.profiles.formatOf ? await this.d.profiles.formatOf(slot.resourceRef ?? `telegram:${slot.channelKey}`).catch(() => null) : null;
    return {
      formatPrefs: fmt ? renderFormatPrefs(fmt.prefs, fmt.locks) : null,
      playbook: sec ? renderSection(sec) : null,
      // Spec 034 FR-008: up to 3 good + 2 bad examples of this resource, the slot's format first (few-shot, critic).
      examples: renderExamples(pb?.body.examples, { resourceRef: slot.resourceRef ?? `telegram:${slot.channelKey}`, format: slot.format }),
      profile: profile ? renderProfile(profile, { now: this.now(), ref: slot.resourceRef ?? undefined }) : null,
      maxPerDay: sec?.per_day.max ?? null,
      vocabulary: sec?.hashtag_policy.vocab ?? [],
      idea: idea ? `«${idea.title}»${idea.angle ? ` — ${idea.angle}` : ''}. Джерела: ${idea.sources.join('; ') || '—'}. ${idea.variants.find((v) => v.resource_ref === slot.resourceRef)?.note ?? ''}` : null,
    };
  }

  private async safeNotify(t: string): Promise<void> {
    try { await this.d.notify(t); } catch { /* best-effort */ }
  }
}
