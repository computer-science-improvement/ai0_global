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
import { parseResourceRef } from '../agents/agent.types';
import { capabilitiesSummary, implementedFormats } from '../platform/capabilities';
import type { PlatformSlotExtras } from '../platform/platform-tools';
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
  /**
   * Network context of a non-Telegram slot (spec 020): the playbook section for
   * the resource, its profile and limits. Optional; without it the platform
   * executor works from the slot and the capability matrix only.
   */
  platformContext?: (slot: EditorSlot, orchestratorId: string | null) => Promise<{ playbook?: string | null; profile?: string | null; maxPerDay?: number | null; vocabulary?: string[]; idea?: string | null } | null>;
  /** Spec 020: network planner and the idea pool for the single-channel planner. */
  network?: {
    runNetworkPlanner(card: EditorCard): Promise<AgentLoopResult | null>;
    plannerExtras(card: EditorCard): Promise<{ network: unknown; excludeTools: Set<string>; ideasNote: string | null } | null>;
  };
  /** Called after an executor run (spec 020: an idea becomes `used` once all its slots are done). */
  onSlotDone?: (slot: EditorSlot) => Promise<void>;
}

/** Telegram-only tools that must never run on a slot of another platform, and vice versa. */
const TELEGRAM_ONLY = new Set(['publish_post', 'lint_post', 'preview_post']);
const PLATFORM_ONLY = new Set(['publish_platform_post']);

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
      tools: this.d.registry.forRole(role, card.toolsAllow).filter((t) => !(extras.excludeTools as Set<string> | undefined)?.has(t.name)),
      maxSteps: MAX_STEPS[role],
      channelBudgetUsd: card.dailyBudgetUsd,
      agent: ctx?.agent
        ? { id: ctx.agent.id, handle: ctx.agent.handle, limitUsd: ctx.agent.dailyBudgetUsd ?? ctx.orchestrator?.dailyBudgetUsd ?? null }
        : null,
      extras: { card, skills, agent: ctx?.agent ?? null, orchestrator: ctx?.orchestrator ?? null, ...extras },
      ...(extras.systemOverride ? { system: String(extras.systemOverride) } : {}),
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
    if (this.d.network) {
      const net = await this.d.network.runNetworkPlanner(card).catch(() => null);
      if (net) return net;
    }
    const extra = this.d.network ? await this.d.network.plannerExtras(card).catch(() => null) : null;
    const reserved = await this.d.plans.reservedSlots(card.channelKey, dayStart, new Date(dayStart.getTime() + 86_400_000));
    const user = [plannerUserPrompt(card, now, reserved), extra?.ideasNote].filter(Boolean).join('\n');
    const res = await this.run('planner', card, user, null, {
      planDate, ...(extra ? { network: extra.network, excludeTools: extra.excludeTools } : { excludeTools: new Set(['submit_network_plan']) }),
    }, ctx);
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
    const target = slot.resourceRef ? parseResourceRef(slot.resourceRef) : null;
    const res = target && target.platform !== 'telegram'
      ? await this.runPlatformExecutor(slot, card, ctx, target.platform)
      : await this.run('executor', card, await this.executorUser(card, slot, ctx), slot.id, { excludeTools: PLATFORM_ONLY }, ctx);
    if (this.d.onSlotDone) await this.d.onSlotDone(slot).catch(() => {});
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

  /** The Telegram executor prompt, plus the pool idea the slot realises (spec 020). */
  private async executorUser(card: EditorCard, slot: EditorSlot, ctx: RunAgentContext | null): Promise<string> {
    const base = executorUserPrompt(card, slot, this.now());
    if (!slot.ideaId || !this.d.platformContext) return base;
    const pc = await this.d.platformContext(slot, ctx?.orchestrator?.id ?? null).catch(() => null);
    return pc?.idea ? `${base}\nІдея з пулу: ${pc.idea}` : base;
  }

  /** A slot that targets Instagram / Facebook / Threads / TikTok of the channel's network (spec 019 FR-008). */
  private async runPlatformExecutor(slot: EditorSlot, card: EditorCard, ctx: RunAgentContext | null, platform: string): Promise<AgentLoopResult> {
    const pc = this.d.platformContext ? await this.d.platformContext(slot, ctx?.orchestrator?.id ?? null).catch(() => null) : null;
    const skills = ctx?.skills ?? this.d.skills;
    const skill = skills.get(`platform-${platform}`);
    const memory = await this.d.memory.listActive(card.channelKey);
    const mode = (ctx?.orchestrator?.mode ?? card.mode) === 'live' && card.mode === 'live' ? 'live' : 'shadow';
    const system = [
      `Ти — автор нативних постів для ${platform} у мережі ai0 (ресурс ${slot.resourceRef}). Пишеш НЕ переробку Telegram-поста, а пост, що працює саме на цій платформі.`,
      'Усі тексти — українською, живою мовою, без AI-штампів. Факти — лише з джерел, які ти прочитав. Код перевіряє ліміти — якщо інструмент повернув error, виправ.',
      'Порядок: дослідження (джерела, бібліотека, стат), потім lint_platform_post, потім publish_platform_post. Слабкий чи неперевірений пост — skip_slot.',
      '',
      '## Можливості платформи',
      capabilitiesSummary([platform as any]),
      `Доступні формати зараз: ${implementedFormats(platform as any).join(', ')}.`,
      ...(pc?.profile ? ['', '## Профіль ресурсу', pc.profile] : []),
      ...(pc?.playbook ? ['', '## Плейбук для цього ресурсу', pc.playbook] : []),
      '',
      '## Памʼять мережі (правила власника і висновки)',
      memory.length ? memory.map((m) => `- [${m.kind}${m.createdBy === 'owner' ? ', власник' : ''}] ${m.text}`).join('\n') : '- (порожня)',
      '',
      '## Скіли',
      skill ? `### skill: ${skill.name}\n${skill.body}` : '- немає скіла платформи',
      skills.list('executor').filter((s) => s.name !== skill?.name).map((s) => `- ${s.name}: ${s.description}`).join('\n'),
    ].join('\n');
    const user = [
      `Слот на ${slot.scheduledAt.toISOString()} для ${slot.resourceRef}. Формат: ${slot.format}. Тема: ${slot.topic}.`,
      slot.angle ? `Кут подачі: ${slot.angle}` : '',
      pc?.idea ? `Ідея з пулу: ${pc.idea}` : '',
      slot.sourceHints.length ? `Підказки джерел: ${slot.sourceHints.join('; ')}` : '',
      mode === 'shadow' ? 'Режим shadow: пост збережеться як превʼю, нічого не публікується.' : '',
      'Підготуй пост і заверши publish_platform_post (після lint_platform_post) або skip_slot з причиною.',
    ].filter(Boolean).join('\n');
    const platformSlot: PlatformSlotExtras = {
      resourceRef: slot.resourceRef!, mode, maxPerDay: pc?.maxPerDay ?? null, vocabulary: pc?.vocabulary ?? [], bannedTerms: card.bannedTerms,
      agentId: ctx?.agent?.id ?? null,
    };
    return this.run('executor', card, user, slot.id, { excludeTools: TELEGRAM_ONLY, systemOverride: system, platformSlot }, ctx);
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
