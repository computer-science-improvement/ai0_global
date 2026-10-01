import type { EditorCard } from '../card';
import type { AgentLoop, AgentLoopResult } from '../harness/agent-loop';
import type { ToolRegistry } from '../harness/tool-registry';
import { resolveModel } from '../llm/model-registry';
import type { CardRole } from '../llm/llm.types';
import type { SkillSource } from '../skills/skill-library';
import type { AgentRuntime, RunAgentContext } from '../agents/agent-runtime';
import type { EditorPlansRepository, EditorSlot } from '../repo/editor-plans.repository';
import type { EditorMemoryRepository } from '../repo/editor-memory.repository';
import { buildSystemPrompt, executorUserPrompt, plannerUserPrompt, reviewerUserPrompt } from './prompts';
import { isQuietHour, localDate, localHour, zonedToUtc } from './time';

export interface EditorRunnerDeps {
  loop:     Pick<AgentLoop, 'run'>;
  registry: Pick<ToolRegistry, 'forRole'>;
  skills:   SkillSource;
  /** Registry agents (spec 017): recorded agent, its DB skills, pause and budget. Optional for tests. */
  runtime?: Pick<AgentRuntime, 'forChannel'>;
  plans:    Pick<EditorPlansRepository, 'reservedSlots' | 'getSlot' | 'updateSlot'>;
  memory:   Pick<EditorMemoryRepository, 'listActive'>;
  env:      (key: string) => string | undefined;
  notify:   (text: string) => Promise<void>;
  now?:     () => Date;
}

export const MAX_SLOT_ATTEMPTS = 2;
export const RETRY_DELAY_MS = 15 * 60_000;

const MAX_STEPS: Record<CardRole, number> = { planner: 10, executor: 14, reviewer: 14 };

/** Runs one role over the AgentLoop and applies the slot state machine around it. */
export class EditorRunnerService {
  constructor(private readonly d: EditorRunnerDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  private async agentOf(card: EditorCard, role: CardRole): Promise<RunAgentContext | null> {
    return this.d.runtime ? this.d.runtime.forChannel(card.channelKey, role) : null;
  }

  private async run(
    role: CardRole, card: EditorCard, user: string, slotId: string | null, extras: Record<string, unknown> = {}, agentCtx?: RunAgentContext | null,
  ): Promise<AgentLoopResult> {
    const memory = await this.d.memory.listActive(card.channelKey);
    const ctx = agentCtx === undefined ? await this.agentOf(card, role) : agentCtx;
    const skills = ctx?.skills ?? this.d.skills;
    const agentModel = ctx?.agent?.model ?? ctx?.orchestrator?.model ?? null;
    return this.d.loop.run({
      role,
      channelKey: card.channelKey,
      slotId,
      model: resolveModel(role, this.d.env, agentModel ? { ...card.models, [role]: agentModel } : card.models),
      system: buildSystemPrompt(role, card, memory, skills),
      user,
      tools: this.d.registry.forRole(role, card.toolsAllow),
      maxSteps: MAX_STEPS[role],
      channelBudgetUsd: card.dailyBudgetUsd,
      agent: ctx?.agent
        ? { id: ctx.agent.id, handle: ctx.agent.handle, limitUsd: ctx.agent.dailyBudgetUsd ?? ctx.orchestrator?.dailyBudgetUsd ?? null }
        : null,
      extras: { card, skills, agent: ctx?.agent ?? null, orchestrator: ctx?.orchestrator ?? null, ...extras },
    });
  }

  private paused(ctx: RunAgentContext | null): AgentLoopResult | null {
    if (!ctx?.paused) return null;
    return {
      runId: null, status: 'disabled', error: `agent @${ctx.orchestrator?.handle ?? ctx.agent?.handle} is paused`,
      totals: { steps: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 },
    };
  }

  async runPlanner(card: EditorCard): Promise<AgentLoopResult> {
    const now = this.now();
    const planDate = localDate(now, card.timezone);
    const dayStart = zonedToUtc(planDate, '00:00', card.timezone);
    const ctx = await this.agentOf(card, 'planner');
    const off = this.paused(ctx);
    if (off) return off;
    const reserved = await this.d.plans.reservedSlots(card.channelKey, dayStart, new Date(dayStart.getTime() + 86_400_000));
    const res = await this.run('planner', card, plannerUserPrompt(card, now, reserved), null, { planDate }, ctx);
    if (res.terminalTool !== 'submit_plan') {
      await this.safeNotify(`🗓 Editor: планувальник ${card.channelKey} не склав план (${res.status}${res.error ? `: ${res.error}` : ''}).`);
    }
    return res;
  }

  async runExecutor(slot: EditorSlot, card: EditorCard): Promise<AgentLoopResult> {
    const ctx = await this.agentOf(card, 'executor');
    const off = this.paused(ctx);
    if (off) {
      await this.d.plans.updateSlot(slot.id, { status: 'skipped', error: off.error ?? 'agent paused' });
      return off;
    }
    const res = await this.run('executor', card, executorUserPrompt(card, slot, this.now()), slot.id, {}, ctx);
    await this.d.plans.updateSlot(slot.id, { runId: res.runId });

    const after = await this.d.plans.getSlot(slot.id);
    if (after && after.status === 'running') {
      // No terminal tool succeeded: retry once later unless budget is the cause or it would land in quiet hours.
      const retryAt = new Date(this.now().getTime() + RETRY_DELAY_MS);
      const quiet = isQuietHour(localHour(retryAt, card.timezone), card.quietStartHour, card.quietEndHour);
      const reason = `${res.status}${res.error ? `: ${res.error}` : ''}`;
      if (after.attempts < MAX_SLOT_ATTEMPTS && res.status !== 'budget_exceeded' && res.status !== 'disabled' && !quiet) {
        await this.d.plans.updateSlot(slot.id, { status: 'planned', scheduledAt: retryAt, error: `retry after ${reason}` });
      } else {
        await this.d.plans.updateSlot(slot.id, { status: 'failed', error: reason });
      }
    }
    return res;
  }

  async runReviewer(card: EditorCard): Promise<AgentLoopResult> {
    const ctx = await this.agentOf(card, 'reviewer');
    const off = this.paused(ctx);
    if (off) return off;
    const res = await this.run('reviewer', card, reviewerUserPrompt(card, this.now()), null, {}, ctx);
    const summary = (res.terminalResult as any)?.summary;
    if (summary) await this.safeNotify(`📈 Тижневий огляд ${card.channelKey}:\n${summary}`);
    return res;
  }

  private async safeNotify(text: string): Promise<void> {
    try { await this.d.notify(text); } catch { /* alerts are best-effort */ }
  }
}
