import { effectiveMode, type EditorCard } from '../card';
import type { AgentLoop, AgentLoopResult } from '../harness/agent-loop';
import type { ToolRegistry } from '../harness/tool-registry';
import { resolveModel } from '../llm/model-registry';
import { agentModelIn, readModelContext, type Workspace } from '../llm/workspace';
import type { CardRole } from '../llm/llm.types';
import type { SkillSource } from '../skills/skill-library';
import type { AgentRuntime, RunAgentContext } from '../agents/agent-runtime';
import type { EditorPlansRepository, EditorSlot } from '../repo/editor-plans.repository';
import type { EditorMemoryRepository } from '../repo/editor-memory.repository';
import { agentInlineSkills, buildSystemPrompt, executorUserPrompt, ownerPreferencesSection, plannerUserPrompt, reviewerUserPrompt } from './prompts';
import { APPROVAL_PREFS_IN_PROMPT } from '../approval/owner-preferences';
import { parseResourceRef } from '../agents/agent.types';
import { capabilitiesSummary, implementedFormats } from '../platform/capabilities';
import type { PlatformSlotExtras } from '../platform/platform-tools';
import { isQuietHour, localDate, localHour, zonedToUtc } from './time';
import { isToolError, type EditorTool } from '../harness/tool';
import { DERIVED_STEPS, derivedPrompts, slotResource, type DerivedResolution } from '../network/derived-slots';
import type { VoicePrefs } from '../post/slop-lint';
import { attachVoiceSkills, VOICE_CORE, VOICE_SKILLS_BUDGET, voiceCoreSection, voiceReferenceLine } from './voice';
import { styleSection } from '../post/style/resource-style';
import { liveSlotLines, noFreshReason, type LiveScan } from '../live/live-slot';
import { CriticGate } from '../critic/critic-gate';
import { slotSkillsContext } from '../critic/critic-skills';
import { examplesPromptSection } from '../network/playbook';
import type { CriticService } from '../critic/critic.service';
import type { InboxItemInput } from '../agents/owner-inbox';
import { PREVIEW_FEATURE, PreviewSink, previewWithoutRun, type SlotPreview } from './preview-run';
import type { AgentBudget } from '../harness/budget.service';
import { alreadyUsedBlock } from '../post/variety/monotony';
import { intersectAllow, type LoadoutService } from '../loadout/loadout.service';
import type { AuditPost } from '../post/integrity/types';
import {
  classifyFailure, isRescued, LADDER_MAX_LATE_MS, ladderNote, ladderPlan, MAX_CRITIC_PASSES_PER_SLOT, MAX_LADDER_EXTRA_STEPS, priorCriticPasses, criticPasses, PublishProbe, stepRecord,
  type FallbackFinal, type FallbackStepRecord, type LadderStep, type SlotFailure,
} from '../silent/fallback-ladder';
import { EvergreenProbe } from '../silent/evergreen';
import { memoryWithoutRules, ownerRulesOf, ownerRulesSection } from '../rules/owner-rules-prompt';
import type { SteeringPromptRule } from '../steering/steering.types';
import { channelLanguage, readerLanguageRule } from '../post/channel-language';

export interface EditorRunnerDeps {
  loop:     Pick<AgentLoop, 'run'>;
  registry: Pick<ToolRegistry, 'forRole'>;
  skills:   SkillSource;
  /** Registry agents (spec 017): recorded agent, its DB skills, pause and budget. Optional for tests. */
  runtime?: Pick<AgentRuntime, 'forChannel'>;
  /** Spec 054: the agent's own tool set; its allowlist narrows the channel's. Optional for tests. */
  loadout?: Pick<LoadoutService, 'allowFor'>;
  plans:    Pick<EditorPlansRepository, 'reservedSlots' | 'getSlot' | 'updateSlot'>;
  memory:   Pick<EditorMemoryRepository, 'listActive'> & Partial<Pick<EditorMemoryRepository, 'ownerPreferences'>>;
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
  /**
   * Network context of a non-Telegram slot (spec 020): the playbook section for
   * the resource, its profile and limits. Optional; without it the platform
   * executor works from the slot and the capability matrix only.
   */
  platformContext?: (slot: EditorSlot, orchestratorId: string | null) => Promise<{
    playbook?: string | null; profile?: string | null; maxPerDay?: number | null; vocabulary?: string[]; idea?: string | null;
    /** Spec 024 FR-013: the target's format_prefs, rendered for the prompt. */
    formatPrefs?: string | null;
    /** Spec 034 FR-008: the resource's example posts (renderExamples) — executor few-shot and the critic's reference. */
    examples?: string | null;
  } | null>;
  /** Spec 020: network planner and the idea pool for the single-channel planner. */
  network?: {
    runNetworkPlanner(card: EditorCard, planDate?: string): Promise<AgentLoopResult | null>;
    plannerExtras(card: EditorCard, planDate?: string): Promise<{ network: unknown; excludeTools: Set<string>; ideasNote: string | null } | null>;
  };
  /** Spec 023 FR-008: the ≤ 1,500-char source catalog for the planner prompt. Optional. */
  catalogSummary?: (card: EditorCard) => Promise<string | null>;
  /** Spec 023 FR-005: a series / pin slot's context for the executor, or a code skip (required source exhausted). */
  seriesContext?: (slot: EditorSlot) => Promise<{ note: string | null; skip?: string }>;
  /** Called after an executor run (spec 020: an idea becomes `used` once all its slots are done). */
  onSlotDone?: (slot: EditorSlot) => Promise<void>;
  /**
   * Spec 024 FR-007: derived (duplicate / adapt) slots. `resolve` finds the
   * source; `formatPrefs` renders the target's format_prefs (FR-013);
   * `released` runs after the derived slot finished (held media of its source);
   * `inbox` gets the note when the agent's post failed lint twice.
   */
  derived?: {
    resolve(slot: EditorSlot): Promise<DerivedResolution>;
    formatPrefs?(ref: string): Promise<string | null>;
    released?(sourceSlotId: string): Promise<unknown>;
    inbox?(note: { agentId: string | null; title: string; body: string; slotId: string }): Promise<unknown>;
  };
  /**
   * Spec 034 FR-002: format_prefs humor / slang / emoji of a resource (the target of a platform or
   * derived slot). Optional: without it humour and slang are off. Telegram cards carry their own.
   */
  voiceOf?: (ref: string) => Promise<VoicePrefs | null>;
  /**
   * Spec 034 FR-010: the code-side scan of a live slot's feeds before the executor runs (fresh, not
   * posted, not a repeat). Nothing fresh → the slot is skipped with `no_fresh_item` without an LLM call.
   */
  live?: { scan(slot: EditorSlot, card: EditorCard): Promise<LiveScan | null> };
  /**
   * Spec 034 FR-004: the pre-publish critic. When set, every executor run (Telegram, platform, adapt; not a
   * duplicate, which keeps its reviewed source text) gets a CriticGate the publish tools call before storing,
   * sending or creating an approval card. `inbox` gets the "critic unavailable" item; `libraryText` is the
   * source excerpt behind a library_ref.
   */
  critic?: {
    service:      Pick<CriticService, 'review'>;
    inbox?:       (i: InboxItemInput) => Promise<unknown>;
    libraryText?: (ref: string) => Promise<string | null>;
  };
  /**
   * Spec 037 FR-010: the daily budget check the fallback ladder runs before each extra step (BudgetService.check:
   * global, channel and agent caps on the usage ledger, which already holds the executor's and the critic's spend).
   * Without it only a run's own `budget_exceeded` stops the ladder.
   */
  budget?: (card: EditorCard, agent: AgentBudget | null) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Spec 037 FR-009: the channel's last written posts (newest first) for the writer's «Уже було» block. Optional. */
  recentPosts?: (card: EditorCard, slot: EditorSlot) => Promise<AuditPost[]>;
  /** Spec 037 FR-010: the fallback ladder (default on); `maxLateMs` — no new step this long after the slot time. */
  /** `maxExtraSteps` (spec 053 FR-007): ladder steps after the first attempt (default MAX_LADDER_EXTRA_STEPS, env EDITOR_LADDER_EXTRA_STEPS). */
  ladder?: { enabled?: boolean; maxLateMs?: number; maxExtraSteps?: number };
  /**
   * Spec 037 FR-010 — the evergreen step of the fallback ladder (silent/evergreen.ts `EvergreenStep`, wired in
   * editor.module). Absent: the ladder goes from the lighter format straight to skip. When set, it runs after the
   * lighter format with the slot (status `running`) and the last failure, and returns the run (the slot is then
   * judged like every other step) or null when no evergreen post is possible today (cap, platform, switched off).
   */
  fallbackEvergreen?: (i: EvergreenRequest) => Promise<AgentLoopResult | null>;
  /**
   * Spec 046 FR-006: a slot skipped after the critic rejected a post written from `url` — the ideas of the same
   * orchestrator that rest on that one source (the slot's own included) are rejected. Returns how many.
   */
  deadSource?: (slot: EditorSlot, url: string, reason: string) => Promise<number>;
  /** Spec 037 T2: the "Active stories (14 days)" block of the planner / writer prompt (story/story-context.ts); null for none. */
  stories?: { activeBlock(card: EditorCard, role: 'planner' | 'executor', now: Date): Promise<string | null> };
}

/** What the evergreen step gets (spec 037 FR-010 seam). */
export interface EvergreenRequest {
  slot:    EditorSlot;
  card:    EditorCard;
  failure: SlotFailure;
  /** The ladder so far (initial, next candidate, lighter format). */
  steps:   FallbackStepRecord[];
  /**
   * Spec 037 T10: one executor run of the slot (critic included) with the evergreen probe — the post is marked
   * `story.kind = evergreen` by code. `slot` is the slot as the writer sees it (topic, format), `note` its instruction.
   */
  run:     (o: { slot: EditorSlot; note: string }) => Promise<AgentLoopResult>;
}

type PlatformContext = Awaited<ReturnType<NonNullable<EditorRunnerDeps['platformContext']>>>;

/** Telegram-only tools that must never run on a slot of another platform, and vice versa. */
const TELEGRAM_ONLY = new Set(['publish_post', 'lint_post', 'preview_post', 'request_story_repost']);
const PLATFORM_ONLY = new Set(['publish_platform_post', 'lint_platform_post']);

export const MAX_SLOT_ATTEMPTS = 2;
export const RETRY_DELAY_MS = 15 * 60_000;
/** Spec 046 FR-005: a slot the budget cannot afford waits this long, then tries again (the owner may raise a cap). */
export const BUDGET_RETRY_MS = 60 * 60_000;
/** ...but not later than this after its planned time — then it is skipped with the budget reason. */
export const BUDGET_MAX_LATE_MS = 6 * 3600_000;

const MAX_STEPS: Record<CardRole, number> = { planner: 10, executor: 14, reviewer: 14 };

/**
 * Spec 053 FR-001: tools a writer never needs — the card, its memory and the skill list are already in its prompt, and
 * raw SQL is the reviewer's. Every tool schema is re-sent on every step, so these are dropped for the executor unless the
 * channel's `tools_allow` names them.
 */
export const EXECUTOR_PREFS_IN_PROMPT = 10;

export const EXECUTOR_DENY = new Set(['sql_readonly', 'get_channel_card', 'get_channel_memory', 'list_skills']);

export function executorTools(role: CardRole, tools: EditorTool[], allow: string[] | null | undefined): EditorTool[] {
  if (role !== 'executor') return tools;
  const allowed = new Set(allow ?? []);
  return tools.filter((t) => !EXECUTOR_DENY.has(t.name) || allowed.has(t.name));
}

/** Tools of a duplicate's short formatting run (FR-007): lint, publish or skip — nothing else. */
const DUPLICATE_TOOLS: Record<'telegram' | 'platform', Set<string>> = {
  telegram: new Set(['lint_post', 'preview_post', 'publish_post', 'skip_slot']),
  platform: new Set(['lint_platform_post', 'publish_platform_post', 'skip_slot']),
};

/**
 * FR-007: on a lint failure the agent fixes its own post once; the second
 * failure of the publish tool ends the slot (`onSecond` marks it failed).
 */
export function lintOnce(tool: EditorTool, onSecond: (details: unknown) => Promise<void>): EditorTool {
  let fails = 0;
  return {
    ...tool,
    execute: async (input, ctx) => {
      const r = await tool.execute(input, ctx);
      if (isToolError(r) && r.error === 'lint_failed' && ++fails >= 2) {
        await onSecond(r.details);
        return { ok: true, failed: 'lint_failed', details: r.details };
      }
      return r;
    },
  };
}

/** One executor attempt of a slot (Telegram or platform), with the probe of its publish-tool errors. */
type Attempt = (slot: EditorSlot, note: string | null, scan: LiveScan | null, probe: PublishProbe) => Promise<AgentLoopResult>;

/** The extras that record the run's publish-tool errors (spec 037 FR-010). */
const probed = (probe: PublishProbe | null): Record<string, unknown> => (probe ? { wrapTools: (t: EditorTool[]) => probe.wrap(t) } : {});

const normUrl = (u: string): string => u.trim().replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();

/** Runs one role over the AgentLoop and applies the slot state machine around it. */
export class EditorRunnerService {
  constructor(private readonly d: EditorRunnerDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  private async agentOf(card: EditorCard, role: CardRole): Promise<RunAgentContext | null> {
    return this.d.runtime ? this.d.runtime.forChannel(card.channelKey, role) : null;
  }

  /** Spec 031 FR-008: the last owner preferences from approvals (planner and executor only). */
  private async prefs(role: CardRole, channelKey: string) {
    if ((role !== 'planner' && role !== 'executor') || !this.d.memory.ownerPreferences) return [];
    // Spec 053 FR-001: the writer gets the newest 10 (every one of its steps re-sends them), the planner all 20.
    return this.d.memory.ownerPreferences(channelKey, role === 'executor' ? EXECUTOR_PREFS_IN_PROMPT : APPROVAL_PREFS_IN_PROMPT).catch(() => []);
  }

  /** The voice settings of the resource a slot writes for (spec 034); a Telegram target falls back to the card. */
  private async voice(ref: string, card: EditorCard): Promise<VoicePrefs> {
    const own = ref === `telegram:${card.channelKey}` ? { humor: card.humor, slang: card.slang, emoji: card.emojiPref, readerQuestionsMax: card.readerQuestionsMax, style: card.style } : null;
    const v = this.d.voiceOf ? await this.d.voiceOf(ref).catch(() => null) : null;
    // Spec 037 FR-008: a channel's own style is the card's (the same the Telegram lint reads).
    return own?.style && v ? { ...v, style: own.style } : v ?? own ?? {};
  }

  /**
   * Spec 034 FR-004: the critic gate of one executor run (null without a critic). `pc` is the slot's network
   * context when the caller already has it; a Telegram slot reads its anchor resource's profile and playbook.
   */
  private async criticGate(
    slot: EditorSlot, card: EditorCard, ctx: RunAgentContext | null,
    target: { ref: string; platform: string; mode: 'live' | 'shadow' | 'approve'; voice: VoicePrefs }, pc?: PlatformContext,
    dry: PreviewSink | null = null,
  ): Promise<CriticGate | null> {
    if (!this.d.critic) return null;
    const context = pc !== undefined ? pc : this.d.platformContext
      ? await this.d.platformContext({ ...slot, resourceRef: target.ref }, ctx?.orchestrator?.id ?? null).catch(() => null)
      : null;
    // Spec 040 FR-011: the critic checks the channel's owner rules (its own axis).
    const ownerRules = ownerRulesOf(await this.d.memory.listActive(card.channelKey, 60).catch(() => []));
    // Spec 045 FR-005: what the owner steers towards — advice for format_fit only.
    const steering = await this.steeringFor(target.ref);
    return new CriticGate(
      // A dry-run preview (spec 034 FR-012): the verdict goes to the preview, never onto the slot or into the Inbox.
      dry
        ? { critic: this.d.critic.service, plans: dry.plans, libraryText: this.d.critic.libraryText }
        : { critic: this.d.critic.service, plans: this.d.plans, inbox: this.d.critic.inbox, libraryText: this.d.critic.libraryText },
      {
        slotId: slot.id, channelKey: card.channelKey, mode: target.mode, resourceRef: target.ref, platform: target.platform,
        topic: slot.topic, angle: slot.angle, card: { models: card.models, dailyBudgetUsd: card.dailyBudgetUsd, language: card.language }, voice: target.voice,
        brief: card.brief || null, profile: context?.profile ?? null, formatPrefs: context?.formatPrefs ?? null, playbook: context?.playbook ?? null,
        examples: context?.examples ?? null,
        agent: ctx?.agent
          ? { id: ctx.agent.id, handle: ctx.agent.handle, limitUsd: ctx.agent.dailyBudgetUsd ?? ctx.orchestrator?.dailyBudgetUsd ?? null }
          : null,
        inboxAgentId: ctx?.orchestrator?.id ?? null,
        // Spec 037 FR-012: the critic judges with the writer's skills (resource tone, format, topic).
        skills: slotSkillsContext(slot, card, ctx?.skills ?? this.d.skills),
        ownerRules, steering,
      },
    );
  }

  private async steeringFor(ref: string): Promise<SteeringPromptRule[]> {
    return this.d.steering ? this.d.steering(ref).catch(() => []) : [];
  }

  /** extras of a run with a critic: the gate, and the read tools wrapped so it sees the sources the executor read. */
  private static withGate(extras: Record<string, unknown>, gate: CriticGate | null): Record<string, unknown> {
    if (!gate) return extras;
    const own = extras.wrapTools as ((t: EditorTool[]) => EditorTool[]) | undefined;
    return { ...extras, critic: gate, wrapTools: (t: EditorTool[]) => gate.wrapTools(own ? own(t) : t) };
  }

  /**
   * Extras of a dry-run preview (spec 034 FR-012): the sink the publish tools stop at, the tools without act tools
   * and with a recording skip_slot, and the run's spend as `editor.preview`.
   */
  private static dryExtras(extras: Record<string, unknown>, dry: PreviewSink | null): Record<string, unknown> {
    if (!dry) return extras;
    const own = extras.wrapTools as ((t: EditorTool[]) => EditorTool[]) | undefined;
    return { ...extras, dryRun: dry, wrapTools: (t: EditorTool[]) => dry.wrapTools(own ? own(t) : t), usage: { feature: PREVIEW_FEATURE, shadow: false } };
  }

  private async run(
    role: CardRole, card: EditorCard, user: string, slotId: string | null, extras: Record<string, unknown> = {}, agentCtx?: RunAgentContext | null,
  ): Promise<AgentLoopResult> {
    const prefs = await this.prefs(role, card.channelKey);
    const memory = await this.d.memory.listActive(card.channelKey, 30, { excludeApprovalPrefs: prefs.length > 0 });
    const ctx = agentCtx === undefined ? await this.agentOf(card, role) : agentCtx;
    const skills = ctx?.skills ?? this.d.skills;
    // A role agent inherits its orchestrator's model and effort (spec 035: agent → channel → env → global default).
    const { workspace, defaultModel } = await readModelContext(this.d);
    const agentModel = agentModelIn(ctx?.agent, workspace) ?? agentModelIn(ctx?.orchestrator, workspace);
    const agentEffort = ctx?.agent?.reasoningEffort ?? ctx?.orchestrator?.reasoningEffort ?? null;
    // Spec 054: the agent's loadout, resolved once for the run; with the channel's allowlist it is an intersection.
    const loadoutAllow = this.d.loadout ? await this.d.loadout.allowFor(ctx?.agent, { role, registry: this.d.registry }) : null;
    return this.d.loop.run({
      role,
      channelKey: card.channelKey,
      slotId,
      model: resolveModel(role, this.d.env, card.models, { agentModel, defaultModel, reasoningEffort: agentEffort, workspace }),
      system: buildSystemPrompt(role, card, memory, skills, prefs, {
        examples: typeof extras.examples === 'string' ? extras.examples : null,
        steering: role === 'reviewer' || extras.systemOverride ? null : await this.steeringFor(`telegram:${card.channelKey}`),
        commitments: role === 'planner' && ctx?.orchestrator && this.d.commitments ? await this.d.commitments(ctx.orchestrator.id).catch(() => null) : null,
      }),
      user,
      tools: ((extras.wrapTools as ((t: EditorTool[]) => EditorTool[]) | undefined) ?? ((t) => t))(
        executorTools(role, this.d.registry.forRole(role, intersectAllow(card.toolsAllow, loadoutAllow)), card.toolsAllow)
          .filter((t) => !(extras.excludeTools as Set<string> | undefined)?.has(t.name))
          .filter((t) => !(extras.allowTools as Set<string> | undefined) || (extras.allowTools as Set<string>).has(t.name))),
      maxSteps: typeof extras.maxSteps === 'number' ? extras.maxSteps : MAX_STEPS[role],
      channelBudgetUsd: card.dailyBudgetUsd,
      agent: ctx?.agent
        ? { id: ctx.agent.id, handle: ctx.agent.handle, limitUsd: ctx.agent.dailyBudgetUsd ?? ctx.orchestrator?.dailyBudgetUsd ?? null }
        : null,
      extras: { card, skills, agent: ctx?.agent ?? null, orchestrator: ctx?.orchestrator ?? null, ...extras },
      ...(extras.systemOverride ? { system: String(extras.systemOverride) } : {}),
      ...(extras.usage ? { usage: extras.usage as { feature?: string; shadow?: boolean } } : {}),
    });
  }

  private paused(ctx: RunAgentContext | null): AgentLoopResult | null {
    if (!ctx?.paused) return null;
    return {
      runId: null, status: 'disabled', error: `agent @${ctx.orchestrator?.handle ?? ctx.agent?.handle} is paused`,
      totals: { steps: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 },
    };
  }

  /** `planDate` (spec 031): approval mode plans the next day ahead, so its batch is written and approved the evening before. */
  async runPlanner(card: EditorCard, opts: { planDate?: string } = {}): Promise<AgentLoopResult> {
    const now = this.now();
    const planDate = opts.planDate ?? localDate(now, card.timezone);
    const dayStart = zonedToUtc(planDate, '00:00', card.timezone);
    const ctx = await this.agentOf(card, 'planner');
    const off = this.paused(ctx);
    if (off) return off;
    if (this.d.network) {
      const net = await this.d.network.runNetworkPlanner(card, opts.planDate).catch(() => null);
      if (net) return net;
    }
    const extra = this.d.network ? await this.d.network.plannerExtras(card, planDate).catch(() => null) : null;
    const reserved = await this.d.plans.reservedSlots(card.channelKey, dayStart, new Date(dayStart.getTime() + 86_400_000));
    const catalog = this.d.catalogSummary ? await this.d.catalogSummary(card).catch(() => null) : null;
    const stories = this.d.stories ? await this.d.stories.activeBlock(card, 'planner', now).catch(() => null) : null;
    const user = [plannerUserPrompt(card, now, reserved, planDate), extra?.ideasNote, catalog ? `\n${catalog}` : null, stories ? `\n${stories}` : null].filter(Boolean).join('\n');
    const res = await this.run('planner', card, user, null, {
      planDate, ...(extra ? { network: extra.network, excludeTools: extra.excludeTools } : { excludeTools: new Set(['submit_network_plan']) }),
    }, ctx);
    if (res.terminalTool !== 'submit_plan') {
      await this.safeNotify(`🗓 Editor: планувальник ${card.channelKey} не склав план (${res.status}${res.error ? `: ${res.error}` : ''}).`);
    }
    return res;
  }

  /** `note` (spec 022): an extra instruction for this slot, e.g. a promo brief with its tracked link. */
  async runExecutor(slot: EditorSlot, cardIn: EditorCard, note?: string | null): Promise<AgentLoopResult> {
    const ctx = await this.agentOf(cardIn, 'executor');
    // Spec 031: the slot runs in the lowest of the orchestrator's and the card's mode; tools read it from the card.
    const card: EditorCard = { ...cardIn, mode: effectiveMode(ctx?.orchestrator?.mode, cardIn.mode) };
    const off = this.paused(ctx);
    if (off) {
      await this.d.plans.updateSlot(slot.id, { status: 'skipped', error: off.error ?? 'agent paused' });
      if (this.d.onSlotDone) await this.d.onSlotDone(slot).catch(() => {});
      return off;
    }
    const series = this.d.seriesContext ? await this.d.seriesContext(slot).catch(() => null) : null;
    if (series?.skip) return this.skipByCode(slot, series.skip);
    note = [note, series?.note].filter(Boolean).join('\n') || null;
    if ((slot.treatment === 'duplicate' || slot.treatment === 'adapt') && this.d.derived) return this.runDerived(slot, card, ctx);
    // Spec 034 FR-010: a live slot looks at its feeds first; with nothing fresh it is skipped by code.
    const scan = slot.topicMode === 'live' && slot.liveSpec && this.d.live ? await this.d.live.scan(slot, card).catch(() => null) : null;
    if (scan && slot.liveSpec && scan.feedsRead > 0 && !scan.items.length && !scan.otherSources.length) {
      return this.skipByCode(slot, noFreshReason(slot.liveSpec, scan));
    }
    const target = slot.resourceRef ? parseResourceRef(slot.resourceRef) : null;
    const attempt: Attempt = (s, n, sc, probe) => target && target.platform !== 'telegram'
      ? this.runPlatformExecutor(s, card, ctx, target.platform, n, sc, null, probe)
      : this.runTelegramExecutor(s, card, ctx, n, sc, null, probe);
    // Spec 046 FR-005: a slot that cannot afford a whole run waits for the budget instead of starting and failing.
    if (this.d.budget) {
      const b = await this.d.budget(card, EditorRunnerService.agentBudget(ctx)).catch(() => ({ ok: true as const }));
      if (!b.ok) return this.waitForBudget(slot, card, b.reason);
    }
    // Spec 053 FR-007: critic passes count across the slot's attempts — a retry does not start a fresh allowance.
    const priorPasses = priorCriticPasses(slot.fallback);
    if (priorPasses >= MAX_CRITIC_PASSES_PER_SLOT) {
      return this.skipByCode(slot, `critic_cap: ${priorPasses} critic passes on this slot (cap ${MAX_CRITIC_PASSES_PER_SLOT})`);
    }
    const probe = new PublishProbe();
    const first = await attempt(slot, note ?? null, scan, probe);
    await this.d.plans.updateSlot(slot.id, { runId: first.runId });
    // Spec 037 FR-010: a post the critic rejected or that failed lint / a guard climbs the fallback ladder.
    const res = await this.fallback(slot, card, ctx, { note: note ?? null, scan, platform: target?.platform ?? 'telegram' }, first, probe, attempt);

    const after = await this.d.plans.getSlot(slot.id);
    if (after && after.status === 'running') {
      // No terminal tool succeeded: retry once later unless budget is the cause or it would land in quiet hours.
      const retryAt = new Date(this.now().getTime() + RETRY_DELAY_MS);
      const quiet = isQuietHour(localHour(retryAt, card.timezone), card.quietStartHour, card.quietEndHour);
      const reason = `${res.status}${res.error ? `: ${res.error}` : ''}`;
      if (res.status === 'budget_exceeded') return this.waitForBudget(after, card, reason, res);
      // Spec 053 FR-007: a post that failed on its content (lint, a guard) is not rewritten from scratch in 15 minutes —
      // the ladder already had its step; the retry is for crashes and timeouts.
      const content = classifyFailure(after, probe);
      if (after.attempts < MAX_SLOT_ATTEMPTS && res.status !== 'disabled' && !quiet && !content) {
        // Spec 040 FR-008: the planned time stays, so the delay of the post that goes out is visible.
        // An attempt the critic read goes into the trace, so its passes count on the retry.
        const record = criticPasses(after) > 0 && !(after.fallback?.steps ?? []).some((x) => x.run_id && x.run_id === res.runId);
        await this.d.plans.updateSlot(slot.id, {
          status: 'planned', retryAt, error: `retry after ${reason}`,
          ...(!record ? {} : { fallback: { steps: [...(after.fallback?.steps ?? []), stepRecord('initial', slot.format, this.now(), after, null, res)], final: null } }),
        });
      } else {
        await this.d.plans.updateSlot(slot.id, { status: 'failed', error: content ? content.reason.slice(0, 500) : reason });
      }
    }
    if (this.d.onSlotDone) await this.d.onSlotDone(slot).catch(() => {});
    return res;
  }

  /** The registry agent's budget of a run (the same mapping the loop gets). */
  private static agentBudget(ctx: RunAgentContext | null): AgentBudget | null {
    return ctx?.agent
      ? { id: ctx.agent.id, handle: ctx.agent.handle, limitUsd: ctx.agent.dailyBudgetUsd ?? ctx.orchestrator?.dailyBudgetUsd ?? null }
      : null;
  }

  /** Formats a slot may fall back to: the card's formats with a weight (Telegram), the implemented native formats (platform). */
  private static allowedFormats(card: EditorCard, platform: string): Set<string> {
    if (platform !== 'telegram') return new Set(implementedFormats(platform as any));
    const tg = new Set(implementedFormats('telegram'));
    return new Set(Object.entries(card.formats ?? {}).filter(([f, w]) => Number(w) > 0 && tg.has(f)).map(([f]) => f));
  }

  /**
   * Spec 037 FR-010: the fallback ladder of a slot whose post failed for a content reason (see silent/fallback-ladder):
   * the next candidate once, a lighter allowed format, [the evergreen seam], else a skip with the recorded reason.
   * Each extra step is a full executor run (critic included) on the same slot, started only within the daily budget
   * and within LADDER_MAX_LATE_MS of the slot time. Every step and its reason are stored on `editor_slots.fallback`.
   * Not for promo / reserved slots (their post is fixed) or derived slots (runDerived, their own lint-twice rule).
   */
  private async fallback(
    slot: EditorSlot, card: EditorCard, ctx: RunAgentContext | null, o: { note: string | null; scan: LiveScan | null; platform: string },
    first: AgentLoopResult, probe: PublishProbe, attempt: Attempt,
  ): Promise<AgentLoopResult> {
    if (this.d.ladder?.enabled === false || slot.promo || slot.kind === 'reserved') return first;
    let after = await this.d.plans.getSlot(slot.id);
    let failure = after ? classifyFailure(after, probe) : null;
    if (!after || !failure) return first;

    // Spec 053 FR-007: the trace keeps the slot's earlier attempts (the retry), so critic passes add up across them.
    const steps: FallbackStepRecord[] = [...(slot.fallback?.steps ?? []), stepRecord('initial', slot.format, this.now(), after, failure, first)];
    const avoid: string[] = failure.sourceUrl ? [failure.sourceUrl] : [];
    const live = slot.topicMode === 'live' && !!slot.liveSpec;
    const plan = ladderPlan({ format: slot.format, allowed: EditorRunnerService.allowedFormats(card, o.platform), evergreen: !!this.d.fallbackEvergreen, live, failure: failure.kind });
    let ran = 0;
    const agent = EditorRunnerService.agentBudget(ctx);
    const maxLate = this.d.ladder?.maxLateMs ?? LADDER_MAX_LATE_MS;
    let res = first;
    let final: FallbackFinal | null = null;
    let last: LadderStep = 'initial';
    const skipped = (step: FallbackStepRecord['step'], format: string, outcome: 'no_candidate' | 'unavailable', reason: string): FallbackStepRecord =>
      ({ step, at: this.now().toISOString(), format, outcome, reason, verdict: null, run_id: null, cost_usd: 0 });

    // Spec 046 FR-006: sources the critic rejected (a sole-source idea built on one of them is dead).
    const rejectedSources = new Set<string>(failure.kind === 'critic_reject' && failure.sourceUrl ? [failure.sourceUrl] : []);
    for (const st of plan) {
      if (ran >= (this.d.ladder?.maxExtraSteps ?? MAX_LADDER_EXTRA_STEPS)) break;
      const passes = steps.reduce((n, x) => n + (x.critic_passes ?? 0), 0);
      if (passes >= MAX_CRITIC_PASSES_PER_SLOT) {
        final = { outcome: 'skipped', code: 'critic_cap', step: last, reason: `${passes} critic passes on this slot (cap ${MAX_CRITIC_PASSES_PER_SLOT})` };
        break;
      }
      // Budget: a run that hit a cap, or the caps on the usage ledger (executor + critic spend so far today).
      if (res.status === 'budget_exceeded') { final = { outcome: 'skipped', code: 'budget', step: last, reason: res.error ?? 'budget_exceeded' }; break; }
      if (this.now().getTime() - slot.scheduledAt.getTime() > maxLate) {
        final = { outcome: 'skipped', code: 'too_late', step: last, reason: `more than ${Math.round(maxLate / 60_000)} min after the slot time` };
        break;
      }
      if (this.d.budget) {
        const b = await this.d.budget(card, agent).catch(() => ({ ok: true as const }));
        if (!b.ok) { final = { outcome: 'skipped', code: 'budget', step: last, reason: b.reason }; break; }
      }
      // A live slot takes the next fresh item: the code re-reads its feeds without the items that already failed.
      let scan = o.scan;
      if (live && this.d.live) {
        const fresh = await this.d.live.scan(slot, card).catch(() => null);
        if (fresh) {
          const used = new Set(avoid.map(normUrl));
          const others = fresh.items.filter((i) => !used.has(normUrl(i.url)));
          if (st.step === 'next_candidate' && fresh.feedsRead > 0 && !others.length && !fresh.otherSources.length) {
            steps.push(skipped(st.step, st.format, 'no_candidate', 'no other fresh item in the feeds'));
            continue;
          }
          scan = { ...fresh, items: others.length || st.step === 'next_candidate' ? others : fresh.items };
        }
      }
      await this.d.plans.updateSlot(slot.id, { status: 'running', error: null, critic: null });
      const p = st.step === 'evergreen' ? new EvergreenProbe() : new PublishProbe();
      const stepSlot: EditorSlot = { ...slot, format: st.format };
      last = st.step;
      const r = st.step === 'evergreen'
        ? await this.d.fallbackEvergreen!({ slot: stepSlot, card, failure, steps: [...steps], run: (e) => attempt(e.slot, e.note, null, p) }).catch(() => null)
        : await attempt(stepSlot, [o.note, ladderNote(st.step, { failure, format: st.format, original: slot.format, avoid, live })].filter(Boolean).join('\n'), scan, p);
      if (!r) { steps.push(skipped(st.step, st.format, 'unavailable', 'no evergreen post today')); continue; }
      ran++;
      res = r;
      await this.d.plans.updateSlot(slot.id, { runId: r.runId });
      after = await this.d.plans.getSlot(slot.id);
      const f = after ? classifyFailure(after, p) : null;
      steps.push(stepRecord(st.step, st.format, this.now(), after, f, r));
      // Spec 037 T10: an evergreen post that did not go out (critic, guard, the writer's skip) skips the slot with the
      // MAIN post's reason; the evergreen's own reason is on its step.
      if (st.step === 'evergreen' && !isRescued(after?.status)) {
        final = { outcome: 'skipped', code: 'exhausted', step: 'evergreen', reason: failure.reason };
        break;
      }
      if (!f) {
        // Out (published / shadowed / waiting for the owner), or ended otherwise (skip, outage, cap): the slot keeps it.
        final = { outcome: isRescued(after?.status) ? 'rescued' : 'ended', code: after?.status ?? 'unknown', step: st.step, reason: after?.error ?? null };
        failure = null;
        break;
      }
      failure = f;
      if (f.sourceUrl && !avoid.includes(f.sourceUrl)) avoid.push(f.sourceUrl);
      if (f.kind === 'critic_reject' && f.sourceUrl) rejectedSources.add(f.sourceUrl);
    }
    if (failure) {
      final ??= { outcome: 'skipped', code: 'exhausted', step: last, reason: failure.reason };
      await this.d.plans.updateSlot(slot.id, { status: 'skipped', error: failure.reason.slice(0, 500) });
      if (this.d.deadSource) {
        for (const url of rejectedSources) await this.d.deadSource(slot, url, failure.reason).catch(() => 0);
      }
    }
    await this.d.plans.updateSlot(slot.id, { fallback: { steps, final } });
    return res;
  }

  /** The Telegram executor run of a slot (`dry`: the owner's dry-run preview, spec 034 FR-012). */
  private async runTelegramExecutor(
    slot: EditorSlot, card: EditorCard, ctx: RunAgentContext | null, note: string | null, scan: LiveScan | null, dry: PreviewSink | null = null,
    probe: PublishProbe | null = null,
  ): Promise<AgentLoopResult> {
    const tgRef = `telegram:${card.channelKey}`;
    // The Telegram resource's own context (playbook section, examples): the critic's and the few-shot's (spec 034 T5).
    const tgContext = this.d.platformContext
      ? await this.d.platformContext({ ...slot, resourceRef: tgRef }, ctx?.orchestrator?.id ?? null).catch(() => null)
      : null;
    const gate = await this.criticGate(slot, card, ctx, {
      ref: tgRef, platform: 'telegram',
      mode: card.mode === 'live' || card.mode === 'approve' ? card.mode : 'shadow',
      voice: { humor: card.humor, slang: card.slang, emoji: card.emojiPref, style: card.style },
    }, tgContext ?? undefined, dry);
    return this.run('executor', card, [await this.executorUser(card, slot, ctx, scan), note].filter(Boolean).join('\n'), slot.id,
      EditorRunnerService.withGate(EditorRunnerService.dryExtras({ excludeTools: PLATFORM_ONLY, examples: tgContext?.examples ?? null, ...probed(probe) }, dry), gate), ctx);
  }

  /**
   * Spec 034 FR-012: the owner's on-demand Preview of a fixed planned slot. The executor runs exactly as at
   * slot time (prompts, tools, every publish guard, the critic) but in dry mode: the publish tools stop before
   * storing, sending, creating an approval card or touching the content ledger; skip_slot only records its
   * reason; act tools are left out; the slot keeps its status, post and run. Live caps (daily cap, quiet hours,
   * min gap) are not checked — they depend on the moment of publishing. Spend: `editor.preview` (+ the
   * critic's `editor.checker`), against the channel, agent and blocking caps like every run.
   */
  async runPreview(slot: EditorSlot, cardIn: EditorCard): Promise<SlotPreview> {
    const startedAt = this.now().toISOString();
    const target = slot.resourceRef ? parseResourceRef(slot.resourceRef) : null;
    const platform = target?.platform ?? 'telegram';
    if (slot.topicMode === 'live') return previewWithoutRun('failed', 'preview_unavailable: a live slot picks its item at slot time', startedAt, platform);
    if (slot.treatment === 'duplicate' || slot.treatment === 'adapt') {
      return previewWithoutRun('failed', `preview_unavailable: a ${slot.treatment} is written from its source after the source is written`, startedAt, platform);
    }
    const ctx = await this.agentOf(cardIn, 'executor');
    const off = this.paused(ctx);
    if (off) return previewWithoutRun('failed', off.error ?? 'agent paused', startedAt, platform);
    // Shadow semantics for the tools (no live caps); the publish tools stop at the dry-run sink anyway.
    const card: EditorCard = { ...cardIn, mode: 'shadow' };
    const series = this.d.seriesContext ? await this.d.seriesContext(slot).catch(() => null) : null;
    if (series?.skip) return previewWithoutRun('skipped', series.skip, startedAt, platform);
    const dry = new PreviewSink();
    const res = target && target.platform !== 'telegram'
      ? await this.runPlatformExecutor(slot, card, ctx, target.platform, series?.note ?? null, null, dry)
      : await this.runTelegramExecutor(slot, card, ctx, series?.note ?? null, null, dry);
    return dry.outcome({
      platform, runId: res.runId, runCostUsd: res.totals?.costUsd ?? 0,
      runError: res.status === 'ok' && !res.error ? null : `${res.status}${res.error ? `: ${res.error}` : ''}`,
      startedAt, finishedAt: this.now().toISOString(),
    });
  }

  /** A slot skipped by code before any LLM call (spec 023 FR-005: a required series source is exhausted). */
  /**
   * Spec 046 FR-005 (review 2: two slots failed on budget and were never retried after the owner raised the cap):
   * the slot goes back to `planned` with retry_at in BUDGET_RETRY_MS and its attempt back; past BUDGET_MAX_LATE_MS
   * after the planned time, or when the retry would land in quiet hours, it is skipped with the budget reason.
   */
  private async waitForBudget(slot: EditorSlot, card: EditorCard, reason: string, res?: AgentLoopResult): Promise<AgentLoopResult> {
    const now = this.now();
    const retryAt = new Date(now.getTime() + BUDGET_RETRY_MS);
    const late = retryAt.getTime() - slot.scheduledAt.getTime() > BUDGET_MAX_LATE_MS;
    const quiet = isQuietHour(localHour(retryAt, card.timezone), card.quietStartHour, card.quietEndHour);
    const out = res ?? { runId: null, status: 'budget_exceeded' as const, error: reason, totals: { steps: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 } };
    if (late || quiet) {
      await this.d.plans.updateSlot(slot.id, { status: 'skipped', error: `budget: ${reason}` });
      if (this.d.onSlotDone) await this.d.onSlotDone(slot).catch(() => {});
      return out;
    }
    await this.d.plans.updateSlot(slot.id, { status: 'planned', retryAt, attempts: Math.max(0, slot.attempts - 1), error: `waiting for budget: ${reason}` });
    return out;
  }

  private async skipByCode(slot: EditorSlot, reason: string): Promise<AgentLoopResult> {
    await this.d.plans.updateSlot(slot.id, { status: 'skipped', error: reason });
    if (this.d.onSlotDone) await this.d.onSlotDone(slot).catch(() => {});
    return { runId: null, status: 'disabled', error: reason, totals: { steps: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 } };
  }

  /**
   * Spec 024 FR-007: a duplicate / adapt slot. The agent formats every target
   * post itself — a short run for a duplicate (source + draft + format_prefs +
   * its format notes), a native rewrite for an adapt; never a code-only mirror.
   * No retry: a run without a result fails the slot.
   */
  private async runDerived(slot: EditorSlot, card: EditorCard, ctx: RunAgentContext | null): Promise<AgentLoopResult> {
    const zero = { steps: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 };
    const r = await this.d.derived!.resolve(slot);
    if (r.kind === 'wait') {
      // The source has not finished yet (owner "run now", approval): back to planned, re-checked every tick.
      await this.d.plans.updateSlot(slot.id, { status: 'planned', error: 'waiting for its source' });
      return { runId: null, status: 'ok', totals: zero, error: 'waiting for its source' };
    }
    if (r.kind === 'skip') {
      await this.d.plans.updateSlot(slot.id, { status: 'skipped', error: r.details ? `${r.code}: ${r.details}`.slice(0, 500) : r.code });
      if (this.d.onSlotDone) await this.d.onSlotDone(slot).catch(() => {});
      return { runId: null, status: 'ok', terminalTool: 'skip_slot', totals: zero, error: r.code };
    }
    const targetRef = slotResource(slot);
    const platform = parseResourceRef(targetRef)?.platform ?? 'telegram';
    const tg = platform === 'telegram';
    // A derived slot of a shadowed source is always shadowed.
    const runCard: EditorCard = r.shadow ? { ...card, mode: 'shadow' } : card;
    const mode = runCard.mode === 'live' || runCard.mode === 'approve' ? runCard.mode : 'shadow';
    const pc = this.d.platformContext ? await this.d.platformContext(slot, ctx?.orchestrator?.id ?? null).catch(() => null) : null;
    const formatPrefs = this.d.derived!.formatPrefs
      ? await this.d.derived!.formatPrefs(targetRef).catch(() => null)
      : pc?.formatPrefs ?? null;
    const prefs = await this.prefs('executor', card.channelKey);
    const memory = await this.d.memory.listActive(card.channelKey, 30, { excludeApprovalPrefs: prefs.length > 0 });
    const skills = ctx?.skills ?? this.d.skills;
    const skill = skills.get(tg ? 'resource-decisions' : `platform-${platform}`) ?? null;
    const voice = await this.voice(targetRef, card);
    // Spec 034 FR-001: an adapt rewrites the text, so it gets the full voice skills (budget-aware); a duplicate keeps it.
    const vs = r.treatment === 'adapt' ? attachVoiceSkills(skills, VOICE_SKILLS_BUDGET, skill ? [skill.name] : []) : null;
    const { system, user } = derivedPrompts({
      slot, ready: r, targetRef, targetPlatform: platform, profile: pc?.profile ?? null, formatPrefs, playbook: pc?.playbook ?? null,
      memory: memoryWithoutRules(memory).map((m) => `- [${m.kind}${m.createdBy === 'owner' ? ', власник' : ''}] ${m.text}`).join('\n'), mode,
      ownerRules: ownerRulesOf(memory),
      skill: skill ? `### skill: ${skill.name}\n${skill.body}` : null, ownerPrefs: ownerPreferencesSection(prefs),
      voice, voiceSkills: vs ? [...vs.inline, voiceReferenceLine(vs.missing)].filter((x): x is string => !!x) : [], examples: pc?.examples ?? null,
      // Spec 040 FR-012: an adapt rewrites the text, so it gets the agent's own skills too.
      agentSkills: r.treatment === 'adapt' ? agentInlineSkills(skills, [...(skill ? [skill.name] : []), ...(vs?.names ?? [])]).inline : [],
    });
    let lintFailedTwice = false;
    const onSecond = async (details: unknown) => {
      lintFailedTwice = true;
      const codes = Array.isArray(details) ? details.map((x: any) => x?.code ?? String(x)).join(', ') : String(details ?? '');
      await this.d.plans.updateSlot(slot.id, { status: 'failed', error: `lint_failed twice: ${codes}`.slice(0, 500) });
      await this.d.derived!.inbox?.({
        agentId: ctx?.orchestrator?.id ?? null, slotId: slot.id,
        title: `A ${r.treatment} for ${targetRef} failed lint twice`,
        body: `The agent could not fix its ${r.treatment} of ${r.sourceRef} for ${targetRef} (${codes}). The slot is marked failed.`,
      })?.catch(() => {});
    };
    const extras: Record<string, unknown> = {
      systemOverride: system, maxSteps: DERIVED_STEPS[r.treatment],
      excludeTools: tg ? PLATFORM_ONLY : TELEGRAM_ONLY,
      ...(r.treatment === 'duplicate' ? { allowTools: DUPLICATE_TOOLS[tg ? 'telegram' : 'platform'] } : {}),
      wrapTools: (tools: EditorTool[]) => tools.map((t) => (t.name === 'publish_post' || t.name === 'publish_platform_post' ? lintOnce(t, onSecond) : t)),
      derived: { treatment: r.treatment, sourceRef: r.sourceRef, sourceSlotId: r.sourceSlotId },
      ...(tg ? {} : {
        platformSlot: {
          resourceRef: targetRef, mode, maxPerDay: pc?.maxPerDay ?? null, vocabulary: pc?.vocabulary ?? [], bannedTerms: card.bannedTerms,
          agentId: ctx?.agent?.id ?? null, voice,
        } satisfies PlatformSlotExtras,
      }),
    };
    // Spec 034 FR-004: an adapt is a new text, so the critic reads it; a duplicate keeps its reviewed source text.
    const gate = r.treatment === 'adapt'
      ? await this.criticGate(slot, runCard, ctx, { ref: targetRef, platform, mode, voice }, pc)
      : null;
    const res = await this.run('executor', runCard, user, slot.id, EditorRunnerService.withGate(extras, gate), ctx);
    await this.d.plans.updateSlot(slot.id, { runId: res.runId });
    const after = await this.d.plans.getSlot(slot.id);
    if (after && after.status === 'running' && !lintFailedTwice) {
      await this.d.plans.updateSlot(slot.id, { status: 'failed', error: `${res.status}${res.error ? `: ${res.error}` : ''}`.slice(0, 500) });
    }
    if (r.sourceSlotId && this.d.derived!.released) await this.d.derived!.released(r.sourceSlotId)?.catch(() => {});
    if (this.d.onSlotDone) await this.d.onSlotDone(slot).catch(() => {});
    return res;
  }

  /** The Telegram executor prompt, plus the pool idea the slot realises (spec 020). */
  private async executorUser(card: EditorCard, slot: EditorSlot, ctx: RunAgentContext | null, scan: LiveScan | null = null): Promise<string> {
    const stories = this.d.stories ? await this.d.stories.activeBlock(card, 'executor', this.now()).catch(() => null) : null;
    // Spec 037 FR-009: what the last posts already used (openings, phrases), so the writer avoids a third time.
    const used = this.d.recentPosts ? alreadyUsedBlock(await this.d.recentPosts(card, slot).catch(() => []), this.now()) : null;
    const base = [executorUserPrompt(card, slot, this.now(), scan, { alreadyUsed: used }), stories ? `\n${stories}` : null].filter(Boolean).join('\n');
    if (!this.d.platformContext) return base;
    const pc = await this.d.platformContext(slot, ctx?.orchestrator?.id ?? null).catch(() => null);
    return [
      base,
      slot.ideaId && pc?.idea ? `Ідея з пулу: ${pc.idea}` : '',
      // Spec 024 FR-013: the channel's own formatting (agent-owned; fields locked by the owner are binding).
      pc?.formatPrefs ? `Форматування цього ресурсу (format_prefs):\n${pc.formatPrefs}` : '',
    ].filter(Boolean).join('\n');
  }

  /** A slot that targets Instagram / Facebook / Threads / TikTok of the channel's network (spec 019 FR-008). */
  private async runPlatformExecutor(
    slot: EditorSlot, card: EditorCard, ctx: RunAgentContext | null, platform: string, note: string | null = null, scan: LiveScan | null = null,
    dry: PreviewSink | null = null, probe: PublishProbe | null = null,
  ): Promise<AgentLoopResult> {
    const pc = this.d.platformContext ? await this.d.platformContext(slot, ctx?.orchestrator?.id ?? null).catch(() => null) : null;
    const skills = ctx?.skills ?? this.d.skills;
    const skill = skills.get(`platform-${platform}`);
    const prefs = await this.prefs('executor', card.channelKey);
    const memory = await this.d.memory.listActive(card.channelKey, 30, { excludeApprovalPrefs: prefs.length > 0 });
    // `card.mode` is already the effective mode (runExecutor); `off` never publishes, so it runs as shadow.
    const mode = card.mode === 'live' || card.mode === 'approve' ? card.mode : 'shadow';
    // Spec 034 FR-001/FR-002: voice-core with the target's humour/slang setting, and the full voice skills budget-aware.
    const voice = await this.voice(slot.resourceRef!, card);
    const vs = attachVoiceSkills(skills, VOICE_SKILLS_BUDGET, skill ? [skill.name] : []);
    const own = agentInlineSkills(skills, [...(skill ? [skill.name] : []), ...vs.names]);
    const system = [
      `Ти — автор нативних постів для ${platform} у мережі ai0 (ресурс ${slot.resourceRef}). Пишеш НЕ переробку Telegram-поста, а пост, що працює саме на цій платформі.`,
      `${readerLanguageRule(channelLanguage(card))} Факти — лише з джерел, які ти прочитав. Код перевіряє ліміти — якщо інструмент повернув error, виправ.`,
      'Порядок: прочитай джерела ідеї (web_fetch), за потреби статистику, потім publish_platform_post (сам перевіряє lint; lint_platform_post — лише для складного посту). Слабкий чи неперевірений пост — skip_slot.',
      'Факти бери з джерел ідеї. Якщо джерело недоступне — не перебирай адреси навмання: одна спроба альтернативи, далі skip_slot з причиною. Хештеги — лише в полі hashtags, не в тексті підпису.',
      ...voiceCoreSection(voice, skills),
      ...styleSection(voice.style),
      ...examplesPromptSection(pc?.examples),
      // Spec 040 FR-011: the owner rules above the profile / playbook they override.
      ...ownerRulesSection(ownerRulesOf(memory)),
      '',
      '## Можливості платформи',
      capabilitiesSummary([platform as any]),
      `Доступні формати зараз: ${implementedFormats(platform as any).join(', ')}.`,
      ...(pc?.profile ? ['', '## Профіль ресурсу', pc.profile] : []),
      '',
      '## Форматування ресурсу (format_prefs)',
      pc?.formatPrefs || '- не задано: на твій розсуд, за нормами платформи (рекомендовані діапазони вище — орієнтир, не правило)',
      ...(pc?.playbook ? ['', '## Плейбук для цього ресурсу', pc.playbook] : []),
      '',
      '## Памʼять мережі (висновки)',
      memoryWithoutRules(memory).length
        ? memoryWithoutRules(memory).map((m) => `- [${m.kind}${m.createdBy === 'owner' ? ', власник' : ''}] ${m.text}`).join('\n')
        : '- (порожня)',
      ...ownerPreferencesSection(prefs),
      '',
      '## Скіли',
      skill ? `### skill: ${skill.name}\n${skill.body}` : '- немає скіла платформи',
      ...own.inline,
      ...vs.inline,
      ...[voiceReferenceLine(vs.missing)].filter((x): x is string => !!x),
      skills.list('executor').filter((s) => s.name !== skill?.name && s.name !== VOICE_CORE && !vs.names.includes(s.name))
        .map((s) => `- ${s.name}: ${s.description}`).join('\n'),
    ].join('\n');
    const user = [
      slot.topicMode === 'live' && slot.liveSpec
        ? [`Слот на ${slot.scheduledAt.toISOString()} для ${slot.resourceRef}. Формат: ${slot.format}.`, ...liveSlotLines(slot.liveSpec, { tz: card.timezone, scan })].join('\n')
        : `Слот на ${slot.scheduledAt.toISOString()} для ${slot.resourceRef}. Формат: ${slot.format}. Тема: ${slot.topic}.`,
      slot.angle ? `Кут подачі: ${slot.angle}` : '',
      pc?.idea ? `Ідея з пулу: ${pc.idea}` : '',
      slot.sourceHints.length ? `Підказки джерел: ${slot.sourceHints.join('; ')}` : '',
      mode === 'shadow' ? 'Режим shadow: пост збережеться як превʼю, нічого не публікується.' : '',
      mode === 'approve' ? 'Режим апруву: пост буде повністю підготовлений і чекатиме схвалення власника; публікує код у час слота після апруву.' : '',
      note ?? '',
      'Якщо цей пост варто також дати на інший ресурс мережі — до завершення виклич repurpose_post з source.slot_id цього слота (вийде після публікації цього поста).',
      'Підготуй пост і заверши publish_platform_post або skip_slot з причиною.',
    ].filter(Boolean).join('\n');
    const platformSlot: PlatformSlotExtras = {
      resourceRef: slot.resourceRef!, mode, maxPerDay: pc?.maxPerDay ?? null, vocabulary: pc?.vocabulary ?? [], bannedTerms: card.bannedTerms,
      agentId: ctx?.agent?.id ?? null, voice,
    };
    const gate = await this.criticGate(slot, card, ctx, { ref: slot.resourceRef!, platform, mode, voice }, pc, dry);
    return this.run('executor', card, user, slot.id,
      EditorRunnerService.withGate(EditorRunnerService.dryExtras({ excludeTools: TELEGRAM_ONLY, systemOverride: system, platformSlot, ...probed(probe) }, dry), gate), ctx);
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
