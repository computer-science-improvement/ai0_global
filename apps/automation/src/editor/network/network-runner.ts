import type { EditorCard } from '../card';
import type { AgentLoop, AgentLoopResult } from '../harness/agent-loop';
import type { ToolRegistry } from '../harness/tool-registry';
import { resolveModel } from '../llm/model-registry';
import type { EditorRole } from '../llm/llm.types';
import type { EditorMemoryRepository } from '../repo/editor-memory.repository';
import type { EditorPlansRepository, EditorSlot } from '../repo/editor-plans.repository';
import { buildSystemPrompt, plannerUserPrompt } from '../roles/prompts';
import { localDate, zonedToUtc } from '../roles/time';
import type { AgentRuntime, RunAgentContext } from '../agents/agent-runtime';
import type { Agent } from '../agents/agent.types';
import { renderProfile, ResourceProfilesRepository } from '../agents/resource-profile';
import { networkContext, NetworkContextDeps, NetworkCtx } from './network-context';
import type { NetworkRepository } from './network.repository';
import {
  ideaReviewerSystemPrompt, ideaReviewerUserPrompt, networkPlannerBlock, orchestratorDailyPrompt, orchestratorSystemPrompt, playbookBuildPrompt,
} from './network-prompts';
import { renderSection } from './playbook';

export interface NetworkRunnerDeps {
  loop:     Pick<AgentLoop, 'run'>;
  registry: Pick<ToolRegistry, 'forRole'>;
  runtime:  Pick<AgentRuntime, 'forChannel'>;
  memory:   Pick<EditorMemoryRepository, 'listActive'>;
  repo:     NetworkRepository;
  plans:    Pick<EditorPlansRepository, 'reservedSlots'>;
  profiles: Pick<ResourceProfilesRepository, 'get'>;
  usable?:  NetworkContextDeps['usable'];
  /** Spec 021: open directives for the orchestrator, rendered for the prompt (null when none). */
  directives?: (orch: Agent) => Promise<string | null>;
  env:      (key: string) => string | undefined;
  notify:   (text: string) => Promise<void>;
  now?:     () => Date;
}

const STEPS: Record<string, number> = { orchestrate: 30, playbook: 18, ideaReview: 25, plan: 14 };
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
    const net = await networkContext({ repo: this.d.repo, usable: this.d.usable }, agentCtx.orchestrator, card);
    return net ? { agentCtx, net } : null;
  }

  private async profileText(net: NetworkCtx): Promise<string | null> {
    const p = (await this.d.profiles.get(`telegram:${net.anchorKey}`))?.profile
      ?? (net.groupId ? (await this.d.profiles.get(`network:${net.groupId}`))?.profile : null);
    return p ? renderProfile(p) : null;
  }

  private async run(role: EditorRole, card: EditorCard, c: { agentCtx: RunAgentContext; net: NetworkCtx }, system: string, user: string, steps: number, extras: Record<string, unknown> = {}, exclude?: Set<string>): Promise<AgentLoopResult> {
    const agent = c.agentCtx.agent ?? c.agentCtx.orchestrator!;
    const model = agent.model ?? c.agentCtx.orchestrator?.model ?? null;
    return this.d.loop.run({
      role, channelKey: card.channelKey, model: resolveModel(role, this.d.env, model ? { [role]: model } : card.models),
      system, user, tools: this.d.registry.forRole(role, card.toolsAllow).filter((t) => !exclude?.has(t.name)), maxSteps: steps,
      channelBudgetUsd: card.dailyBudgetUsd,
      agent: { id: agent.id, handle: agent.handle, limitUsd: agent.dailyBudgetUsd ?? c.agentCtx.orchestrator?.dailyBudgetUsd ?? null },
      extras: { card, network: c.net, skills: c.agentCtx.skills, agent, orchestrator: c.agentCtx.orchestrator, ...extras },
    });
  }

  private paused(c: { agentCtx: RunAgentContext } | null): boolean {
    return !c || c.agentCtx.paused;
  }

  /** The daily run: directives, then the idea pool (and minor playbook upkeep). Builds a playbook first when there is none. */
  async runOrchestrator(card: EditorCard): Promise<AgentLoopResult | null> {
    const c = await this.context(card);
    if (this.paused(c)) return null;
    const { net } = c!;
    if (!net.playbook && !(await this.d.repo.pendingPlaybook(net.orchestrator.id))) return this.runPlaybookBuild(card, card.brief || null);
    await this.d.repo.expireIdeas(net.orchestrator.id, this.now());
    const open = await this.d.repo.listIdeas(net.orchestrator.id, ['new', 'accepted', 'needs_revision'], 200);
    const perDay = net.playbook ? net.playbook.platforms.reduce((a, s) => a + s.per_day.max, 0) : card.postsPerDayMax;
    const target = Math.max(3, Math.ceil(perDay * 2 / Math.max(1, net.resources.length)));
    const directives = this.d.directives ? await this.d.directives(net.orchestrator) : null;
    const memory = await this.d.memory.listActive(card.channelKey);
    const res = await this.run('orchestrator', card, c!,
      orchestratorSystemPrompt({ net, card, profile: await this.profileText(net), memory, skills: c!.agentCtx.skills, directives }),
      orchestratorDailyPrompt({ net, card, now: this.now(), open, target, hasDirectives: !!directives }),
      STEPS.orchestrate, { brief: card.brief });
    await this.runIdeaReview(card);
    return res;
  }

  /** Brief → playbook (spec 020 FR-003); one build at a time per agent. */
  async runPlaybookBuild(card: EditorCard, brief: string | null): Promise<AgentLoopResult | null> {
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
        STEPS.playbook, { brief });
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
    const fresh = (await this.d.repo.listIdeas(c!.net.orchestrator.id, ['new'], 100)).length;
    const pending = !!(await this.d.repo.pendingPlaybook(c!.net.orchestrator.id));
    if (!fresh && !pending) return null;
    const memory = await this.d.memory.listActive(card.channelKey);
    return this.run('idea_reviewer', card, c!,
      ideaReviewerSystemPrompt({ net: c!.net, profile: await this.profileText(c!.net), memory, skills: c!.agentCtx.skills }),
      ideaReviewerUserPrompt({ fresh, pendingPlaybook: pending }), STEPS.ideaReview);
  }

  /**
   * The planner of an orchestrated network (FR-007). Returns null when the
   * channel is not the anchor of an orchestrated network with a playbook — the
   * caller then runs the single-channel planner (which can use the idea pool too).
   */
  async runNetworkPlanner(card: EditorCard): Promise<AgentLoopResult | null> {
    const c = await this.context(card, 'planner');
    if (!c || c.net.mode !== 'orchestrated' || !c.net.playbook) return null;
    if (c.agentCtx.paused) return null;
    const now = this.now();
    const planDate = localDate(now, card.timezone);
    const dayStart = zonedToUtc(planDate, '00:00', card.timezone);
    const reserved = await this.d.plans.reservedSlots(card.channelKey, dayStart, new Date(dayStart.getTime() + 86_400_000));
    const accepted = await this.d.repo.listIdeas(c.net.orchestrator.id, ['accepted'], 100);
    const memory = await this.d.memory.listActive(card.channelKey);
    const system = `${buildSystemPrompt('planner', card, memory, c.agentCtx.skills)}\n\n${networkPlannerBlock({ net: c.net, accepted, now, tz: card.timezone })}`;
    const res = await this.run('planner', card, c, system, plannerUserPrompt(card, now, reserved), STEPS.plan, { planDate }, TERMINAL_EXCLUDE_NETWORK);
    if (res.terminalTool !== 'submit_network_plan') {
      await this.safeNotify(`🗓 @${c.net.orchestrator.handle}: план мережі не складено (${res.status}${res.error ? `: ${res.error}` : ''}).`);
    }
    return res;
  }

  /** Extras the single-channel planner needs to see the idea pool (list_ideas works on ctx.extras.network). */
  async plannerExtras(card: EditorCard): Promise<{ network: NetworkCtx; excludeTools: Set<string>; ideasNote: string | null } | null> {
    const c = await this.context(card, 'planner');
    if (!c) return null;
    const accepted = await this.d.repo.listIdeas(c.net.orchestrator.id, ['accepted'], 30);
    return {
      network: c.net, excludeTools: TERMINAL_EXCLUDE_SINGLE,
      ideasNote: accepted.length ? `У пулі ${accepted.length} прийнятих ідей (list_ideas) — плануй насамперед з них і вказуй idea_id.` : null,
    };
  }

  /** Context of a non-Telegram slot for the platform executor (019 hook). */
  async platformContext(slot: EditorSlot, orchestratorId: string | null) {
    if (!orchestratorId) return null;
    const pb = await this.d.repo.activePlaybook(orchestratorId);
    const sec = pb?.body.platforms.find((p) => p.resource_ref === slot.resourceRef) ?? null;
    const profile = slot.resourceRef ? (await this.d.profiles.get(slot.resourceRef))?.profile ?? null : null;
    const idea = slot.ideaId ? await this.d.repo.idea(slot.ideaId) : null;
    return {
      playbook: sec ? renderSection(sec) : null,
      profile: profile ? renderProfile(profile) : null,
      maxPerDay: sec?.per_day.max ?? null,
      vocabulary: sec?.hashtag_policy.vocab ?? [],
      idea: idea ? `«${idea.title}»${idea.angle ? ` — ${idea.angle}` : ''}. Джерела: ${idea.sources.join('; ') || '—'}. ${idea.variants.find((v) => v.resource_ref === slot.resourceRef)?.note ?? ''}` : null,
    };
  }

  private async safeNotify(t: string): Promise<void> {
    try { await this.d.notify(t); } catch { /* best-effort */ }
  }
}
