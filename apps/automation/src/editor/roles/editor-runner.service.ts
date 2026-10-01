import type { EditorCard } from '../card';
import type { AgentLoop, AgentLoopResult } from '../harness/agent-loop';
import type { ToolRegistry } from '../harness/tool-registry';
import { resolveModel } from '../llm/model-registry';
import type { EditorRole } from '../llm/llm.types';
import type { SkillLibrary } from '../skills/skill-library';
import type { EditorPlansRepository, EditorSlot } from '../repo/editor-plans.repository';
import type { EditorMemoryRepository } from '../repo/editor-memory.repository';
import { buildSystemPrompt, executorUserPrompt, plannerUserPrompt, reviewerUserPrompt } from './prompts';
import { isQuietHour, localDate, localHour, zonedToUtc } from './time';

export interface EditorRunnerDeps {
  loop:     Pick<AgentLoop, 'run'>;
  registry: Pick<ToolRegistry, 'forRole'>;
  skills:   SkillLibrary;
  plans:    Pick<EditorPlansRepository, 'reservedSlots' | 'getSlot' | 'updateSlot'>;
  memory:   Pick<EditorMemoryRepository, 'listActive'>;
  env:      (key: string) => string | undefined;
  notify:   (text: string) => Promise<void>;
  now?:     () => Date;
}

export const MAX_SLOT_ATTEMPTS = 2;
export const RETRY_DELAY_MS = 15 * 60_000;

const MAX_STEPS: Record<Exclude<EditorRole, 'checker'>, number> = { planner: 10, executor: 14, reviewer: 14 };

/** Runs one role over the AgentLoop and applies the slot state machine around it. */
export class EditorRunnerService {
  constructor(private readonly d: EditorRunnerDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  private async run(role: Exclude<EditorRole, 'checker'>, card: EditorCard, user: string, slotId: string | null, extras: Record<string, unknown> = {}): Promise<AgentLoopResult> {
    const memory = await this.d.memory.listActive(card.channelKey);
    return this.d.loop.run({
      role,
      channelKey: card.channelKey,
      slotId,
      model: resolveModel(role, this.d.env, card.models),
      system: buildSystemPrompt(role, card, memory, this.d.skills),
      user,
      tools: this.d.registry.forRole(role, card.toolsAllow),
      maxSteps: MAX_STEPS[role],
      channelBudgetUsd: card.dailyBudgetUsd,
      extras: { card, ...extras },
    });
  }

  async runPlanner(card: EditorCard): Promise<AgentLoopResult> {
    const now = this.now();
    const planDate = localDate(now, card.timezone);
    const dayStart = zonedToUtc(planDate, '00:00', card.timezone);
    const reserved = await this.d.plans.reservedSlots(card.channelKey, dayStart, new Date(dayStart.getTime() + 86_400_000));
    const res = await this.run('planner', card, plannerUserPrompt(card, now, reserved), null, { planDate });
    if (res.terminalTool !== 'submit_plan') {
      await this.safeNotify(`🗓 Editor: планувальник ${card.channelKey} не склав план (${res.status}${res.error ? `: ${res.error}` : ''}).`);
    }
    return res;
  }

  async runExecutor(slot: EditorSlot, card: EditorCard): Promise<AgentLoopResult> {
    const res = await this.run('executor', card, executorUserPrompt(card, slot, this.now()), slot.id);
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
    const res = await this.run('reviewer', card, reviewerUserPrompt(card, this.now()), null);
    const summary = (res.terminalResult as any)?.summary;
    if (summary) await this.safeNotify(`📈 Тижневий огляд ${card.channelKey}:\n${summary}`);
    return res;
  }

  private async safeNotify(text: string): Promise<void> {
    try { await this.d.notify(text); } catch { /* alerts are best-effort */ }
  }
}
