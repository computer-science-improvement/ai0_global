import { Inject, Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import type { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import { ChannelConfigModule } from '../config/config.module';
import { ChannelConfigService } from '../config/channel-config.service';
import { PublishersModule } from '../publishers/publishers.module';
import { TelegramNotifier } from '../publishers/telegram-notifier.service';
import { PostingThrottleService } from '../publishers/posting-throttle.service';
import { TelegraphService } from '../publishers/telegraph.service';
import { SlideHostingService } from '../publishers/hosting/slide-hosting.service';
import { RecipeCarouselRendererService } from '../common/carousel/recipe-carousel-renderer.service';
import { CrossPostService } from '../publishers/cross-post.service';
import { tgPostLink } from '../publishers/crosspost-content';
import { GroupFanOutService } from '../common/content-strategy/group-fanout.service';
import { OpenRouterClient } from './llm/openrouter.client';
import { AgentLoop } from './harness/agent-loop';
import { ToolRegistry } from './harness/tool-registry';
import { PgRunRecorder } from './harness/run-recorder';
import { BudgetService } from './harness/budget.service';
import { ReadonlyQueryService } from './db/readonly-query.service';
import { SkillLibrary } from './skills/skill-library';
import { buildReadTools } from './tools/read-tools';
import { scanLive } from './live/feed-items';
import { NewsWatchService } from './live/news-watch';
import { buildComposeTools } from './tools/compose-tools';
import { buildRoleTools } from './tools/role-tools';
import { buildApiTools } from './tools/api-tools';
import { applyDataSchemaSuggestion, buildDataTools } from './tools/data-tools';
import { DataStore } from '../data/data-store';
import { EditorChannelsRepository } from './repo/editor-channels.repository';
import { EditorPlansRepository } from './repo/editor-plans.repository';
import { EditorMemoryRepository } from './repo/editor-memory.repository';
import { PgRichCapability } from './publish/rich-capability';
import { TelegramEditorPublisher } from './publish/telegram-editor.publisher';
import { SponsoredPublisher } from './publish/sponsored.publisher';
import { EditorMediaPreparer } from './publish/prepare-media';
import { EditorCrossPoster } from './publish/editor-crosspost';
import { MediaHolds } from './publish/media-holds';
import { DerivedSlots } from './network/derived-slots';
import { ResourceTime } from './time/resource-time';
import { safeGetBytes } from './net/safe-http';
import { AdOrdersRepository } from '../payments/ad-orders.repository';
import { EditorRunnerService, type EditorRunnerDeps } from './roles/editor-runner.service';
import { EditorScheduler } from './editor.scheduler';
import { htmlToPlain } from './post/inline-markup';
import { EditorRunsRepository } from './repo/editor-runs.repository';
import { EditorChatRepository } from './repo/editor-chat.repository';
import { ReservedDispatcher } from './publish/reserved-dispatcher';
import type { PublishSpecDeps } from './publish/publish-spec';
import { DraftsService } from './chat/drafts.service';
import { buildComposerTools } from './chat/composer-tools';
import { EditorChatService } from './chat/editor-chat.service';
import { EDITOR_CHAT, EDITOR_DRAFTS, EditorChatController } from './api/editor-chat.controller';
import { EditorOpsService } from './api/editor-ops.service';
import { EDITOR_OPS, EditorController } from './api/editor.controller';
import { AuthModule } from '../auth/auth.module';
import { AgentsRepository } from './agents/agents.repository';
import { SkillStore } from './agents/skill-store';
import { OwnerInbox } from './agents/owner-inbox';
import { TelegramScopeKpi } from './agents/scope-kpi';
import type { ScopeKpi } from './agents/scope-kpi';
import { AgentRuntime } from './agents/agent-runtime';
import { AgentRegistrySync } from './agents/agent-registry-sync';
import { SkillVersionEvaluator } from './agents/skill-version-evaluator';
import { buildAgentSkillTools } from './agents/agent-skill-tools';
import { AgentsService } from './agents/agents.service';
import { AGENTS_SERVICE, AgentsController } from './agents/agents.controller';
import { telegramKeyOf, parseResourceRef, resourceRef } from './agents/agent.types';
import type { Agent } from './agents/agent.types';
import { renderFormatPrefs, ResourceProfilesRepository } from './agents/resource-profile';
import { ResourceCatalog, makeTelegramAccessCheck } from './agents/resource-catalog';
import { PendingActionsRepository, PendingActionsService } from './agents/pending-actions';
import { AgentCreator } from './agents/agent-creator';
import { buildBuilderTools } from './agents/builder-tools';
import { buildAgentChatTools } from './agents/agent-chat-tools';
import type { AgentChatPort } from './chat/editor-chat.service';
import { MetaAccountsRepository } from '../config/meta-accounts.repository';
import { TikTokTokenService } from '../config/tiktok-token.service';
import { SecretsService } from '../common/crypto/secrets.service';
import { PublisherDispatcher } from '../publishers/publisher-dispatcher.service';
import { TikTokCarouselPublisher } from '../publishers/tiktok/tiktok-carousel.publisher';
import { FACEBOOK_GRAPH, THREADS_GRAPH, graphGet, graphPost, graphVersion, threadsVersion } from '../publishers/meta-graph.util';
import { PlatformPostsRepository } from './platform/platform-posts.repository';
import { ResourcePublisher } from './platform/resource-publisher';
import type { PublishPlatformDeps } from './platform/publish-platform';
import { buildPlatformTools } from './platform/platform-tools';
import { PlatformStatsCollector } from './platform/platform-stats.collector';
import { ResourceHealthService } from './platform/resource-health.service';
import { NetworkRepository } from './network/network.repository';
import { NetworkRunner } from './network/network-runner';
import { buildNetworkTools } from './network/network-tools';
import { buildRepurposeTools, RepurposeInput, RepurposeService } from './network/repurpose-tool';
import { buildFormatTools } from './network/format-tools';
import { SqlPollCaps } from './roles/poll-cap';
import { networkContext } from './network/network-context';
import { buildSeriesTools } from './network/series-tools';
import { buildHighlightsTools } from './tools/highlights-tools';
import { catalogSummaryOf, checkLowRunway } from './tools/catalog-context';
import { isSeriesLocked, seriesSourceCatalog } from './network/series-edit';
import { NetworkService } from './network/network.service';
import { NetworkOffers } from './network/network-offers';
import { buildNetworkModeTool } from './network/network-mode-tool';
import { NETWORK_SERVICE, NetworkController } from './network/network.controller';
import { DirectivesRepository } from './manager/directives.repository';
import { KpiDigestService } from './manager/kpi-digest.service';
import { ManagerRunner } from './manager/manager-runner';
import { buildDirectiveTools, fileDirective, FileDirectiveInput } from './manager/directive-tools';
import { ManagerService } from './manager/manager.service';
import { MANAGER_SERVICE, ManagerController } from './manager/manager.controller';
import type { Playbook } from './network/playbook';
import {
  DirectiveExecution, executionContextOf, experimentExecutor, formatShiftExecutor, frequencyExecutor, pauseResourceExecutor, pauseSeriesExecutor,
  PlaybookBuildPort, promoVerifier, SqlExperimentQuotas, SqlPlanObserver, strategyExecutor, taskRefCheck,
} from './manager/executors';
import { channelHeldBy, ResourcePauseService } from './pauses/resource-pauses';
import { RESOURCE_PAUSES, ResourcePausesApi, ResourcePausesController } from './pauses/resource-pauses.controller';
import { TrackedLinks } from './promo/tracked-links';
import { PromoPlanner } from './promo/promo-planner';
import { PromoExecutor } from './promo/promo-executor';
import { PromoService } from './promo/promo.service';
import { PROMO_SERVICE, PromoController, PromoRedirectController } from './promo/promo.controller';
import { onChatMember } from '../publishers/chat-member-bus';
import { createHash, randomBytes } from 'crypto';
import { TrackingAuthGuard } from '../tracking/api/tracking-auth.guard';
import { PriceService } from '../common/ai/usage/price.service';
import { LlmPricesRepository } from '../common/ai/usage/llm-prices.repository';
import { ModelDefaultsStore } from './llm/model-defaults';
import { ModelCatalog } from './models/model-catalog';
import { ModelsService, fallbackCatalog } from './models/models.service';
import { MODELS_SERVICE, ModelsController } from './models/models.controller';
import { LlmBudgetService, capDefaults } from '../common/ai/usage/llm-budget.service';
import { effectiveMode } from './card';
import type { ChannelMode, EditorCard } from './card';
import { ApprovalsRepository } from './approval/approvals.repository';
import { ApprovalPublisher } from './approval/approval-publisher';
import { ApprovalUpkeep } from './approval/approval-upkeep';
import { ApprovalAlerts } from './approval/approval-alerts';
import { ApprovalsService } from './approval/approvals.service';
import { APPROVALS_SERVICE, ApprovalsController } from './approval/approvals.controller';
import { ApprovalStatsRepository } from './approval/approval-stats';
import { AutonomyService, ReadyForAutonomy, readyForAutonomyText } from './approval/autonomy';
import { ScheduleService } from './schedule/schedule.service';
import { ScheduleRepository } from './schedule/schedule.repository';
import { buildScheduleTools, registerScheduleActions } from './schedule/schedule-tools';
import { SCHEDULE_SERVICE, ScheduleController } from './schedule/schedule.controller';
import { buildCatalog } from '../data/data-catalog';
import { kyivMonthDay } from '../data/data-query';
import { AUTONOMY_SERVICE, AutonomyController } from './approval/autonomy.controller';
import { ConfigEventsPublisher } from '../config/config-events.publisher';
import { StrategyMigrationService } from './migration/strategy-migration.service';
import { buildMigrationTools, registerMigrationActions } from './migration/migration-actions';
import { STRATEGY_MIGRATION, StrategyMigrationController, type StrategyMigrationInfra } from './migration/strategy-migration.controller';
import { StrategyMigrationUpkeep } from './migration/migration-upkeep';
import { UPCOMING_SLOTS, UpcomingSlotsController, upcomingSlots, type UpcomingSlotsPort } from './schedule/upcoming';

export const EDITOR_RUNNER    = 'EDITOR_RUNNER';
export const EDITOR_SCHEDULER = 'EDITOR_SCHEDULER';
export const EDITOR_REPOS     = 'EDITOR_REPOS';
export const EDITOR_SKILLS    = 'EDITOR_SKILLS';
export const EDITOR_REGISTRY  = 'EDITOR_REGISTRY';
/** Live publish ports shared by publish_post and the chat (Telegram sender, media stage, mirrors). */
export const EDITOR_PUBLISH   = 'EDITOR_PUBLISH';
/** Cross-promo between own resources and tracked links (spec 022). */
export const PROMO_INFRA      = 'PROMO_INFRA';

export interface PromoInfra {
  links:   TrackedLinks;
  planner: PromoPlanner;
}

/** Bot API call on a channel's bot (invite links, forwards). */
async function botCall(channelConfig: ChannelConfigService, channelKey: string, method: string, params: Record<string, unknown>): Promise<any> {
  const ch = channelConfig.resolveChannel(channelKey);
  const res = await fetch(`https://api.telegram.org/bot${ch.botToken}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: ch.chatId, ...params }), signal: AbortSignal.timeout(15_000),
  });
  const body: any = await res.json();
  if (!body?.ok) throw new Error(body?.description ?? `${method} failed`);
  return body.result;
}

/** The MANAGER, its digest and directives (spec 021). */
export const EDITOR_MANAGER   = 'EDITOR_MANAGER';

export interface ManagerInfra {
  repo:   DirectivesRepository;
  digest: KpiDigestService;
  runner: ManagerRunner;
  /** Spec 025 FR-015: the strategy executor's playbook builder, bound to NetworkRunner.runPlaybookBuild. */
  buildPort: PlaybookBuildPort;
}

/** Orchestrator-level runs and the idea pool (spec 020). */
export const EDITOR_NETWORK   = 'EDITOR_NETWORK';
/** The AgentLoop of scheduled runs (shared by the editor roles and the orchestrator runs). */
export const EDITOR_LOOP      = 'EDITOR_LOOP';
/** Spec 035: the owner's global default model (app_settings `ai.default_model`), cached in-process for every runner. */
export const MODEL_DEFAULTS   = 'MODEL_DEFAULTS';

/** Approval mode (spec 031): storage, the publisher of approved posts and the tick lane. */
export const APPROVAL_INFRA   = 'APPROVAL_INFRA';

export interface ApprovalInfra {
  repo:      ApprovalsRepository;
  publisher: ApprovalPublisher;
  upkeep:    ApprovalUpkeep;
  /** Effective mode of a channel: its orchestrator's mode ∧ the card's. */
  mode(card: EditorCard): Promise<ChannelMode>;
  /** Decisions of the last N days (switch dialog, agent page, 029 Agents card). */
  stats:     ApprovalStatsRepository;
  /** The MANAGER's weekly "ready for autonomy" signal (an info Inbox item; never a mode change). */
  ready:     ReadyForAutonomy;
}

/** Owner schedule rules, pins and series context (spec 023 T4/T5): one ScheduleService. */
export const SCHEDULE_INFRA   = SCHEDULE_SERVICE;

/** The planner prompt's source catalog plus the owner's schedule for today and tomorrow (spec 023 FR-004/FR-008). */
function withSchedule(catalog: (card: EditorCard) => Promise<string | null>, schedule: ScheduleService) {
  return async (card: EditorCard): Promise<string | null> => {
    const parts = [await catalog(card).catch(() => null), await schedule.plannerBlock(card).catch(() => null)].filter(Boolean);
    return parts.length ? parts.join('\n\n') : null;
  };
}

/** Native multi-platform publishing (spec 019): repository, publish path, stats, health. */
export const PLATFORM_INFRA   = 'PLATFORM_INFRA';

export interface PlatformInfra {
  posts:   PlatformPostsRepository;
  publish: PublishPlatformDeps;
  stats:   PlatformStatsCollector;
  health:  ResourceHealthService;
}

/** Agent registry infrastructure (spec 017): repository, DB skills, owner inbox, scope KPI, run-time resolver. */
export const AGENT_INFRA      = 'AGENT_INFRA';

export interface AgentInfra {
  agents:   AgentsRepository;
  skills:   SkillStore;
  inbox:    OwnerInbox;
  kpi:      ScopeKpi;
  runtime:  AgentRuntime;
  registry: AgentRegistrySync;
  profiles: ResourceProfilesRepository;
  catalog:  ResourceCatalog;
  actions:  PendingActionsService;
  actionsRepo: PendingActionsRepository;
  creator:  AgentCreator;
  /** The Telegram channel an orchestrator publishes to: its resource, or its network's channel. */
  channelKeyOf(agent: Agent): Promise<string | null>;
}
export { EDITOR_OPS, EDITOR_CHAT, EDITOR_DRAFTS };

type PublishPorts = Pick<PublishSpecDeps, 'publisher' | 'media' | 'crosspost'> & {
  /** Spec 024 FR-007: hosted slides of sources with pending derived slots. */
  holds?: MediaHolds;
};

/** Spec 024 FR-007: the runner's derived-slot ports (source resolution, held media, the lint-twice Inbox note). */
function derivedPorts(pool: Pool, net: NetworkRepository, infra: AgentInfra, holds: MediaHolds | null): NonNullable<EditorRunnerDeps['derived']> {
  const slots = new DerivedSlots({
    pool,
    heldUrls: holds ? (id) => holds.urls(id) : undefined,
    // Membership regardless of health: a resource that is only unhealthy has not left the network.
    networkRefs: async (key) => {
      const g = await net.groupOfChannel(key);
      return g ? [`telegram:${key}`, ...(await net.groupResources(g.id)).map((r) => r.ref)] : null;
    },
  });
  return {
    resolve: (slot) => slots.resolve(slot),
    formatPrefs: async (ref) => { const f = await infra.profiles.formatOf(ref); return renderFormatPrefs(f.prefs, f.locks); },
    released: holds ? (id) => holds.sweep(new Date(), id) : undefined,
    inbox: (n) => infra.inbox.post({
      agentId: n.agentId, kind: 'derived_post_failed', severity: 'action', title: n.title, body: n.body, refType: 'slot', refId: n.slotId,
    }),
  };
}

/** Spec 024 FR-008: the network and anchor card of a chat agent (its orchestrator's Telegram anchor). */
function chatNetwork(pool: Pool, repos: EditorRepos, infra: AgentInfra, usable?: (ref: string) => Promise<boolean>) {
  return async (agent: Agent) => {
    const orch = agent.parentId ? (await infra.agents.get(agent.parentId)) ?? agent : agent;
    const key = telegramKeyOf(orch);
    const card = key ? await repos.channels.get(key) : null;
    if (!card) return null;
    const net = await networkContext({ repo: new NetworkRepository(pool), usable, time: resourceTime(repos, infra.profiles) }, orch, card);
    return net ? { net, card } : null;
  };
}

/** Spec 024 FR-004: one per-resource time resolver (card for Telegram, then the profile, then Kyiv). */
function resourceTime(repos: Pick<EditorRepos, 'channels'>, profiles: ResourceProfilesRepository): ResourceTime {
  const logger = new Logger('ResourceTime');
  return new ResourceTime({
    card:    (k) => repos.channels.get(k),
    profile: (ref) => profiles.rawProfile(ref),
    warn:    async (ref, detail) => { logger.warn(`${ref}: ${detail}`); await profiles.noteHealthDetail(ref, detail); },
  });
}

/** Spec 025 FR-006: every resource in an orchestrator's scope (its anchor and its group), usable or not. */
function directiveScope(pool: Pool): (orch: Agent) => Promise<string[]> {
  return async (orch) => {
    const key = telegramKeyOf(orch);
    if (!key) return [];
    const network = new NetworkRepository(pool);
    const group = await network.groupOfChannel(key);
    const refs = group ? (await network.groupResources(group.id)).map((r) => r.ref) : [];
    return [...new Set([resourceRef('telegram', key), ...refs])];
  };
}

/**
 * Spec 025 FR-009: the directive executors (frequency, format_shift, pause_series, pause_resource; T5: experiment, strategy) and
 * the promo verifiers, with their runner. `buildPort` is bound only for the MANAGER's instance (it applies).
 */
function directiveExecution(pool: Pool, repos: EditorRepos, infra: AgentInfra, platform: PlatformInfra, buildPort = new PlaybookBuildPort()): DirectiveExecution {
  const logger = new Logger('DirectiveExecution');
  const network = new NetworkRepository(pool);
  const deps = { network, channels: repos.channels, observer: new SqlPlanObserver(pool) };
  const quotas = new SqlExperimentQuotas(pool);
  const pauses = new ResourcePauseService({ pool, inbox: infra.inbox });
  return new DirectiveExecution({
    repo: new DirectivesRepository(pool), inbox: infra.inbox, agents: infra.agents,
    context: executionContextOf({ repo: network, channels: repos.channels, usable: (ref) => platform.health.usable(ref), time: resourceTime(repos, infra.profiles), pauses }),
    executors: [
      frequencyExecutor(deps), formatShiftExecutor(deps), pauseSeriesExecutor(deps), pauseResourceExecutor({ pauses }),
      experimentExecutor({ quotas }), strategyExecutor({ network, builder: buildPort }),
    ],
    verifiers: [promoVerifier(pool, 'cross_promo'), promoVerifier(pool, 'repost')],
    quotas,
    log: (m) => logger.warn(m),
  });
}

/** Spec 034 FR-005: poll caps and the polls already in the 7-day window (plan validators). */
const pollCapsOf = (pool: Pool) => {
  const q = new SqlPollCaps(pool);
  return (o: { refs: string[]; planDate: string; tz: string; defaultRef?: string }) => q.load(o);
};

/** Spec 025 FR-014: open experiment quotas of an anchor (plan validators and planner prompts). */
const experimentQuotasOf = (pool: Pool) => {
  const q = new SqlExperimentQuotas(pool);
  return (anchorKey: string, planDate: string, now: Date) => q.open(anchorKey, planDate, now);
};

export interface EditorRepos {
  channels: EditorChannelsRepository;
  plans:    EditorPlansRepository;
  memory:   EditorMemoryRepository;
  runs:     EditorRunsRepository;
  chat:     EditorChatRepository;
}

/** A numeric env var; an empty value (e.g. `EDITOR_DAILY_BUDGET_USD=`) means "use the default", never 0. */
function envNum(env: (k: string) => string | undefined, key: string, def: number): number {
  const v = env(key)?.trim();
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : def;
}

/**
 * The editor's budget gate (spec 029 FR-008): caps come from llm_budgets (seeded from
 * EDITOR_DAILY_BUDGET_USD $2 / EDITOR_CHANNEL_DAILY_BUDGET_USD $0.30 / AI_DAILY_BUDGET_USD $3);
 * the env values are only the fallback when the ledger module is absent.
 */
function editorBudget(pool: Pool, env: (k: string) => string | undefined, alert: (t: string) => Promise<void>, caps?: LlmBudgetService): BudgetService {
  const d = capDefaults(env);
  return new BudgetService(pool, { globalDailyUsd: d.agentsDailyUsd, channelDailyUsd: d.resourceDailyUsd }, alert, caps);
}

/** The agents' cap (`editor.*` row of llm_budgets) for the KPI digest; the env default without the ledger module. */
function agentsCapUsd(env: (k: string) => string | undefined, caps?: LlmBudgetService): () => Promise<number> {
  return async () => (await caps?.caps())?.find((r) => r.scopeKind === 'feature_prefix' && r.scopeKey === 'editor.')?.dailyUsd
    ?? capDefaults(env).agentsDailyUsd;
}

const isEnabled = (cfg: ConfigService) => cfg.get<string>('EDITOR_ENABLED') === 'true';

/** Owner alerts are plain text, so the rendered preview is flattened. */
const previewMessage = (channelKey: string, html: string) => `👁 Shadow-превʼю ${channelKey}\n\n${htmlToPlain(html)}`;

@Injectable()
export class EditorCron {
  constructor(@Inject(EDITOR_SCHEDULER) private readonly scheduler: EditorScheduler) {}

  @Cron('* * * * *', { name: 'editor-tick' })
  async tick(): Promise<void> {
    await this.scheduler.cronTick();
  }
}

/**
 * Agent registry upkeep (spec 017): builtin skills and card → agent sync at
 * boot and hourly; the daily evaluation of agent skill self-edits.
 */
@Injectable()
export class AgentsUpkeep implements OnModuleInit {
  private readonly logger = new Logger('Agents');

  constructor(
    @Inject(AGENT_INFRA) private readonly infra: AgentInfra,
    @Inject(EDITOR_SKILLS) private readonly files: SkillLibrary,
    @Inject(EDITOR_REPOS) private readonly repos: EditorRepos,
    @Inject(PLATFORM_INFRA) private readonly platform: PlatformInfra,
    @Inject(EDITOR_MANAGER) private readonly manager: ManagerInfra,
    @Inject(PROMO_INFRA) private readonly promo: PromoInfra,
    @Inject(APPROVAL_INFRA) private readonly approval: ApprovalInfra,
    @Inject(NETWORK_SERVICE) private readonly network: NetworkService,
  ) {}

  /** Spec 024 FR-010: once-per-group offers to convert legacy auto-duplicate networks (idempotent by group). */
  @Cron('29 * * * *', { name: 'network-offers' })
  async networkOffers(): Promise<void> {
    try {
      const done = await this.network.runOffers();
      if (done.length) this.logger.log(`network offers: ${done.map((d) => `${d.groupId} ${d.step}`).join(', ')}`);
    } catch (err: any) {
      this.logger.warn(`network offers failed: ${err?.message ?? err}`);
    }
  }

  /** Spec 031 FR-010: "ready for autonomy" for resources in approval mode (deduped weekly per resource). */
  @Cron('25 9 * * *', { name: 'ready-for-autonomy' })
  async readyForAutonomy(): Promise<void> {
    try {
      const filed = await this.approval.ready.run();
      if (filed.length) this.logger.log(`ready for autonomy: ${filed.join(', ')}`);
    } catch (err: any) {
      this.logger.warn(`ready-for-autonomy check failed: ${err?.message ?? err}`);
    }
  }

  /** Owner-card timeouts, unresolved expiry and directive effect evaluation (spec 021). */
  @Cron('47 * * * *', { name: 'directives-housekeeping' })
  async directives(): Promise<void> {
    try {
      const r = await this.manager.runner.housekeeping();
      if (r.timedOut || r.expired || r.evaluated || r.executed || r.failed || r.resumed || r.verified || r.autoApplied || r.ignored || r.contestTimedOut) {
        this.logger.log(`directives: timed out ${r.timedOut}, expired ${r.expired}, auto-applied ${r.autoApplied}, ignored ${r.ignored}, contest timeouts ${r.contestTimedOut}, executed ${r.executed}, failed ${r.failed}, resumed ${r.resumed}, verified ${r.verified}, evaluated ${r.evaluated}`);
      }
    } catch (err: any) {
      this.logger.warn(`directives housekeeping failed: ${err?.message ?? err}`);
    }
  }

  /** Platform post metrics + daily follower rollup (spec 019 FR-009). */
  @Cron('35 */3 * * *', { name: 'platform-stats' })
  async platformStats(): Promise<void> {
    try {
      const r = await this.platform.stats.run();
      if (r.posts || r.failed) this.logger.log(`platform stats: ${r.posts} posts, ${r.failed} failed, ${r.resources} resources`);
    } catch (err: any) {
      this.logger.warn(`platform stats failed: ${err?.message ?? err}`);
    }
  }

  /** Daily access check of every resource (spec 019 FR-011). */
  @Cron('10 6 * * *', { name: 'resource-health' })
  async resourceHealth(): Promise<void> {
    try { await this.platform.health.run(); } catch (err: any) { this.logger.warn(`resource health failed: ${err?.message ?? err}`); }
  }

  async onModuleInit(): Promise<void> {
    // Joins through tracked invite links (spec 022): the admin bot forwards chat_member updates.
    onChatMember(async (u) => {
      await this.promo.links.recordJoin({
        inviteLinkUrl: u.invite_link?.invite_link ?? null, inviteLinkName: u.invite_link?.name ?? null,
        userId: u.new_chat_member.user.id, status: u.new_chat_member.status,
      });
    });
    await this.sync();
  }

  @Cron('17 * * * *', { name: 'agents-sync' })
  async sync(): Promise<void> {
    try {
      const s = await this.infra.skills.syncBuiltins(this.files);
      const r = await this.infra.registry.run();
      if (s.inserted || s.updated || r.created || r.updated) {
        this.logger.log(`skills +${s.inserted}/~${s.updated}; agents +${r.created}/~${r.updated}; runs linked ${r.linkedRuns}`);
      }
    } catch (err: any) {
      this.logger.warn(`agent registry sync failed: ${err?.message ?? err}`);
    }
  }

  /**
   * Expire stale confirmation cards. Spec 031 replaced the 3-day shadow start
   * (and its "go live" card) with approval mode; an agent still finishing a
   * legacy shadow period is offered approval mode instead of live.
   */
  @Cron('23 * * * *', { name: 'agents-housekeeping' })
  async housekeeping(): Promise<void> {
    try {
      await this.infra.actionsRepo.expireOld(new Date());
      for (const a of await this.infra.agents.list()) {
        if (a.parentId || a.mode !== 'shadow' || !a.shadowUntil || a.shadowUntil.getTime() > Date.now()) continue;
        await this.infra.inbox.post({
          agentId: a.id, kind: 'shadow_ended', severity: 'action',
          title: `🚦 @${a.handle}: shadow period ended — switch to approval mode?`,
          body: 'In approval mode the agent writes real posts, but each one waits for your approval. Switch the mode on the agent page.',
          alert: {
            title: `🚦 @${a.handle}: shadow-період завершено — перевести в режим «На апруві»?`,
            body: 'У режимі апруву агент пише справжні пости, але кожен чекає вашого схвалення. Режим перемикається на сторінці агента.',
          },
          refType: 'agent', refId: a.handle,
        });
        await this.infra.agents.update(a.id, { shadowUntil: null });
      }
    } catch (err: any) {
      this.logger.warn(`agents housekeeping failed: ${err?.message ?? err}`);
    }
  }

  @Cron('40 5 * * *', { name: 'agents-skill-review' })
  async reviewSkills(): Promise<void> {
    try {
      const evaluator = new SkillVersionEvaluator({
        skills: this.infra.skills, agents: this.infra.agents, kpi: this.infra.kpi, inbox: this.infra.inbox,
        remember: async (agent, text, evidence) => {
          const key = telegramKeyOf(agent.parentId ? (await this.infra.agents.get(agent.parentId)) ?? agent : agent);
          if (key) await this.repos.memory.add(key, 'avoid', text, evidence, 'reviewer');
        },
        log: (m) => this.logger.warn(m),
      });
      const r = await evaluator.run();
      if (r.kept || r.rolledBack || r.postponed) this.logger.log(`skill self-edits: kept ${r.kept}, rolled back ${r.rolledBack}, postponed ${r.postponed}`);
    } catch (err: any) {
      this.logger.warn(`skill evaluation failed: ${err?.message ?? err}`);
    }
  }
}

/** Owner-confirmed mutations proposed by @ai0 and channel agents in the chat (spec 018 FR-005). */
function registerAgentActions(infra: AgentInfra, svc: AgentsService, ops: EditorOpsService): void {
  const a = infra.actions;
  a.register('create_agent', async (p) => {
    const r = await infra.creator.create(p);
    if ('error' in r) throw new Error(`${r.error}${r.details ? `: ${typeof r.details === 'string' ? r.details : JSON.stringify(r.details)}` : ''}`);
    return { handle: r.agent.handle, id: r.agent.id, cardCreated: r.cardCreated };
  });
  a.register('update_agent', async (p) => {
    // Spec 031 FR-010: a mode never changes through an agent's card, whatever the stored payload says.
    const { mode: _mode, ...patch } = (p.patch ?? {}) as Record<string, unknown>;
    if (_mode !== undefined) throw new Error('mode_owner_only: only the owner switches the mode, in the dashboard');
    return svc.patch(String(p.handle), patch);
  });
  a.register('set_brief', async (p) => {
    const agent = await svc.require(String(p.handle));
    const key = await infra.channelKeyOf(agent);
    if (key && (!agent.scopeId || parseResourceRef(agent.scopeId)?.platform === 'telegram')) await ops.upsertChannel(key, { brief: String(p.brief) });
    await svc.onBrief(agent, String(p.brief));
    return { ok: true, channel: key };
  });
  a.register('set_resource_profile', async (p) => {
    await svc.setProfile(String(p.ref), p.profile, 'owner');
    return { ok: true };
  });
  a.register('write_skill', async (p) => {
    const r = await svc.putSkill(String(p.handle), String(p.name), { description: p.description, applies_to: p.applies_to, body: p.body });
    if (p.inline) await svc.patchSkill(String(p.handle), String(p.name), { inline: true });
    return { version: r.version };
  });
  a.register('attach_skill', async (p) => {
    await svc.patchSkill(String(p.handle), String(p.skill), { enabled: true, ...(p.inline ? { inline: true } : {}) });
    return { ok: true };
  });
  a.register('detach_skill', async (p) => {
    await svc.patchSkill(String(p.handle), String(p.skill), { enabled: false });
    return { ok: true };
  });
}

/**
 * Editor agent (specs/003–006). Always imported; does nothing unless
 * EDITOR_ENABLED=true AND a channel's editorial card has mode shadow/live.
 */
export const EDITOR_PROVIDERS = [
    {
      provide: MODEL_DEFAULTS,
      inject: [DB_POOL],
      useFactory: (pool: Pool) => {
        const logger = new Logger('Models');
        return new ModelDefaultsStore(pool, { onError: (m) => logger.warn(m) });
      },
    },
    {
      // Spec 035: the Models page (catalog from OpenRouter's public list, cached 24 h; offline fallback from llm_prices).
      provide: MODELS_SERVICE,
      inject: [DB_POOL, ConfigService, AGENT_INFRA, MODEL_DEFAULTS, { token: PriceService, optional: true }],
      useFactory: (pool: Pool, cfg: ConfigService, infra: AgentInfra, defaults: ModelDefaultsStore, prices?: PriceService) => {
        const logger = new Logger('Models');
        const catalog = new ModelCatalog({
          fetch: (url, init) => fetch(url, init),
          fallback: async () => fallbackCatalog(await new LlmPricesRepository(pool).list()),
          log: (m) => logger.warn(m),
        });
        return new ModelsService({
          pool, agents: infra.agents, catalog, defaults, prices, env: (k) => cfg.get<string>(k) ?? undefined, log: (m) => logger.log(m),
        });
      },
    },
    {
      provide: EDITOR_REPOS,
      inject: [DB_POOL],
      useFactory: (pool: Pool): EditorRepos => ({
        channels: new EditorChannelsRepository(pool),
        plans:    new EditorPlansRepository(pool),
        memory:   new EditorMemoryRepository(pool),
        runs:     new EditorRunsRepository(pool),
        chat:     new EditorChatRepository(pool),
      }),
    },
    { provide: EDITOR_SKILLS, useFactory: () => new SkillLibrary() },
    {
      provide: AGENT_INFRA,
      inject: [DB_POOL, ConfigService, EDITOR_REPOS, EDITOR_SKILLS, TelegramNotifier, ChannelConfigService],
      useFactory: (
        pool: Pool, cfg: ConfigService, repos: EditorRepos, files: SkillLibrary, notifier: TelegramNotifier, channelConfig: ChannelConfigService,
      ): AgentInfra => {
        const logger = new Logger('Agents');
        const agents = new AgentsRepository(pool);
        const skills = new SkillStore(pool);
        const profiles = new ResourceProfilesRepository(pool);
        const registry = new AgentRegistrySync({ agents, channels: repos.channels, log: (m) => logger.log(m) });
        const catalog = new ResourceCatalog({
          pool,
          telegramAccess: makeTelegramAccessCheck((key) => {
            const r = channelConfig.resolveChannel(key);
            return { chatId: r.chatId, botToken: r.botToken };
          }),
        });
        const actionsRepo = new PendingActionsRepository(pool);
        const channelKeyOf = async (agent: Agent): Promise<string | null> => {
          const orch = agent.parentId ? (await agents.get(agent.parentId)) ?? agent : agent;
          const direct = telegramKeyOf(orch);
          if (direct) return direct;
          if (orch.scope === 'network' && orch.scopeId) {
            const { rows } = await pool.query(`SELECT channel_key FROM tracked_channels WHERE group_id = $1 AND channel_key IS NOT NULL LIMIT 1`, [orch.scopeId]);
            return rows[0]?.channel_key ?? null;
          }
          return null;
        };
        return {
          agents, skills, profiles, catalog, registry, actionsRepo, channelKeyOf,
          inbox: new OwnerInbox(pool, (t) => notifier.notifyAlert(t), cfg.get<string>('DASHBOARD_URL') ?? null),
          kpi: new TelegramScopeKpi(pool),
          runtime: new AgentRuntime({ agents, store: skills, fallback: files, log: (m) => logger.warn(m) }),
          actions: new PendingActionsService(actionsRepo),
          creator: new AgentCreator({ agents, registry, catalog, profiles, channels: repos.channels }),
        };
      },
    },
    {
      provide: EDITOR_PUBLISH,
      inject: [
        ChannelConfigService, RecipeCarouselRendererService, SlideHostingService, TelegraphService, CrossPostService, GroupFanOutService, DB_POOL,
      ],
      useFactory: (
        channelConfig: ChannelConfigService, renderer: RecipeCarouselRendererService, hosting: SlideHostingService,
        telegraph: TelegraphService, crossPost: CrossPostService, groupFanOut: GroupFanOutService, pool: Pool,
      ): PublishPorts => {
        const holds = new MediaHolds(pool, hosting, (m) => new Logger('MediaHolds').warn(m));
        return {
        holds,
        publisher: new TelegramEditorPublisher({
          resolveChannel:     (k) => channelConfig.resolveChannel(k),
          isPublishPausedFor: (k) => channelConfig.isPublishPausedFor(k),
        }, undefined, {
          // Spec 033 FR-003: a hard "rich unsupported" answer is remembered per channel for 7 days.
          richCapability: new PgRichCapability(pool),
          log: (m) => new Logger('TelegramEditorPublisher').warn(m),
        }),
        // Carousel slides and longread pages are produced only by a live publish (spec 009 T002).
        media: new EditorMediaPreparer({
          renderSlides: (slides) => renderer.renderSlides(slides),
          hosting,
          createPage:   (a) => telegraph.createPage(a),
          fetchImage:   async (url) => {
            const r = await safeGetBytes(url);
            return r.status < 400 ? r.body : null;
          },
          holds,
        }),
        // Live posts are mirrored like the legacy strategies' (spec 009 T003); card.crosspost=false opts out.
        crosspost: new EditorCrossPoster({
          crossPost, groupFanOut,
          postLink: (k, id) => tgPostLink(channelConfig.getChannelMeta(k)?.username ?? null, id),
          autoDuplicateActive: (k) => new NetworkRepository(pool).autoDuplicateActiveForChannel(k),
          // Spec 025 FR-013: no mirror copy on a resource paused by a pause_resource directive.
          pausedPlatforms: (k) => new ResourcePauseService({ pool }).pausedMirrorPlatforms(k),
        }),
        };
      },
    },
    {
      provide: PLATFORM_INFRA,
      inject: [
        DB_POOL, ConfigService, EDITOR_PUBLISH, AGENT_INFRA, PostingThrottleService,
        { token: MetaAccountsRepository, optional: true }, { token: SecretsService, optional: true },
        { token: PublisherDispatcher, optional: true }, { token: TikTokCarouselPublisher, optional: true },
        { token: TikTokTokenService, optional: true },
      ],
      useFactory: (
        pool: Pool, cfg: ConfigService, ports: PublishPorts, infra: AgentInfra, throttle: PostingThrottleService,
        metaRepo?: MetaAccountsRepository, secrets?: SecretsService, dispatcher?: PublisherDispatcher,
        tiktok?: TikTokCarouselPublisher, tiktokTokens?: TikTokTokenService,
      ): PlatformInfra => {
        const logger = new Logger('Platforms');
        const posts = new PlatformPostsRepository(pool);
        const metaToken = async (id: string): Promise<string | null> => {
          const a = metaRepo ? await metaRepo.findById(id) : null;
          if (!a || !secrets) return null;
          return secrets.resolveToken({ enc: a.token_enc, env: a.token_env }, (k) => cfg.get<string>(k)) ?? null;
        };
        const unavailable = () => { throw new Error('platform publishers are not available in this process'); };
        const publisher = new ResourcePublisher({
          metaAccount: async (id) => {
            const a = metaRepo ? await metaRepo.findById(id) : null;
            if (!a) return null;
            return { platform: a.platform, targetId: a.target_id, token: await metaToken(id), active: a.active, username: a.username ?? null };
          },
          dispatcher: dispatcher ?? { publish: unavailable, publishCarousel: unavailable } as any,
          tiktok: tiktok ?? { publishCarousel: unavailable } as any,
          igComment: async (mediaId, token, message) => {
            await graphPost(`${FACEBOOK_GRAPH}/${graphVersion(cfg)}/${mediaId}/comments`, { message, access_token: token }, 15_000, token);
          },
        });
        const publish: PublishPlatformDeps = {
          posts, publisher, pool,
          hostSlides: (slides, key) => (ports.media as EditorMediaPreparer).hostSlides(slides, key),
          health: async (ref) => (await infra.profiles.get(ref))?.health ?? null,
          recordPublish: (k) => throttle.recordPublish(k),
        };
        const stats = new PlatformStatsCollector({
          pool, posts, metaToken,
          graphGet: (url, params) => graphGet(url, params, 15_000, params.access_token ?? ''),
          graphBase: { facebook: `${FACEBOOK_GRAPH}/${graphVersion(cfg)}`, threads: `${THREADS_GRAPH}/${threadsVersion(cfg)}` },
          tiktokFollowers: tiktokTokens ? async (id) => {
            const token = await tiktokTokens.getValidAccessToken(id);
            const res = await fetch('https://open.tiktokapis.com/v2/user/info/?fields=follower_count', {
              headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
            });
            const body: any = await res.json();
            const n = body?.data?.user?.follower_count;
            return typeof n === 'number' ? n : null;
          } : undefined,
          log: (m) => logger.warn(m),
        });
        const health = new ResourceHealthService({ catalog: infra.catalog, profiles: infra.profiles, inbox: infra.inbox });
        return { posts, publish, stats, health };
      },
    },
    {
      provide: SCHEDULE_INFRA,
      inject: [DB_POOL, EDITOR_REPOS, AGENT_INFRA, PLATFORM_INFRA],
      useFactory: (pool: Pool, repos: EditorRepos, infra: AgentInfra, platform: PlatformInfra): ScheduleService => {
        const svc = new ScheduleService({
          pool, rules: new ScheduleRepository(pool), network: new NetworkRepository(pool), agents: infra.agents,
          card: (k) => repos.channels.get(k), plans: repos.plans, inbox: infra.inbox,
          time: resourceTime(repos, infra.profiles), usable: (ref) => platform.health.usable(ref),
          sourceCatalog: (card) => seriesSourceCatalog(pool, card),
          unposted: async (ref, dataset) => (await buildCatalog(pool, { dataset, resource: ref, today: kyivMonthDay() }))[0]?.unposted_here ?? null,
        });
        // Spec 023 FR-006: the chat's series_change / schedule_rule / slot_change cards.
        registerScheduleActions(infra.actions, svc);
        return svc;
      },
    },
    {
      // Spec 023 FR-013: the Overview's "Upcoming slots" (series instances and pins of every agent).
      provide: UPCOMING_SLOTS,
      inject: [SCHEDULE_INFRA, AGENT_INFRA],
      useFactory: (schedule: ScheduleService, infra: AgentInfra): UpcomingSlotsPort => ({
        list: (o) => upcomingSlots({ schedule, agents: infra.agents }, o),
      }),
    },
    {
      // Spec 023 FR-011/FR-012: strategy bindings → agent series (proposal, cards, cutover, rollback).
      provide: STRATEGY_MIGRATION,
      inject: [DB_POOL, ConfigService, EDITOR_REPOS, AGENT_INFRA, PLATFORM_INFRA, { token: ConfigEventsPublisher, optional: true }],
      useFactory: (
        pool: Pool, cfg: ConfigService, repos: EditorRepos, infra: AgentInfra, platform: PlatformInfra, events?: ConfigEventsPublisher,
      ): StrategyMigrationInfra => {
        const svc = new StrategyMigrationService({
          pool, agents: infra.agents, network: new NetworkRepository(pool), card: (k) => repos.channels.get(k), inbox: infra.inbox,
          time: resourceTime(repos, infra.profiles), usable: (ref) => platform.health.usable(ref),
          sourceCatalog: (card) => seriesSourceCatalog(pool, card),
          attachSkill: (agentId, name) => infra.skills.attachShared(agentId, name),
          publishConfig: events ? () => events.publish('strategy') : undefined,
          editorEnabled: () => isEnabled(cfg),
          log: (m) => new Logger('StrategyMigration').warn(m),
        });
        registerMigrationActions(infra.actions, svc);
        return { svc, actions: infra.actions, pool, inbox: infra.inbox };
      },
    },
    {
      // Deterministic draft actions of the editor chat (spec 010): composer tools, REST buttons, scheduled path.
      provide: EDITOR_DRAFTS,
      inject: [DB_POOL, EDITOR_REPOS, EDITOR_PUBLISH, ChannelConfigService, TelegramNotifier, PostingThrottleService, SCHEDULE_INFRA],
      useFactory: (
        pool: Pool, repos: EditorRepos, ports: PublishPorts, channelConfig: ChannelConfigService,
        notifier: TelegramNotifier, throttle: PostingThrottleService, schedule: ScheduleService,
      ): DraftsService => {
        const logger = new Logger('EditorDrafts');
        return new DraftsService({
          pool, repo: repos.chat, channels: repos.channels, plans: repos.plans, ...ports,
          recordPublish: (k) => throttle.recordPublish(k),
          isPaused: (k) => channelConfig.isPublishPausedFor(k),
          notify: (t) => notifier.notifyAlert(t),
          reservedWarnings: (k, at) => schedule.reservedWarnings(k, at),
          log: (m) => logger.warn(m),
        });
      },
    },
    {
      // One registry for the runner, the chat and the ops surface (REST tools endpoint → MCP).
      provide: EDITOR_REGISTRY,
      inject: [DB_POOL, ConfigService, EDITOR_REPOS, EDITOR_SKILLS, EDITOR_PUBLISH, EDITOR_DRAFTS, TelegramNotifier, PostingThrottleService, AGENT_INFRA, PLATFORM_INFRA, SCHEDULE_INFRA, STRATEGY_MIGRATION, { token: LlmBudgetService, optional: true }],
      useFactory: (
        pool: Pool, cfg: ConfigService, repos: EditorRepos, skills: SkillLibrary, ports: PublishPorts, drafts: DraftsService,
        notifier: TelegramNotifier, throttle: PostingThrottleService, infra: AgentInfra, platform: PlatformInfra, schedule: ScheduleService,
        migration: StrategyMigrationInfra, caps?: LlmBudgetService,
      ): ToolRegistry => {
        const env = (k: string) => cfg.get<string>(k) ?? undefined;
        // Spec 025: executor dry-run for file_directive; directive_lock on the orchestrator's playbook writes.
        const directives = directiveExecution(pool, repos, infra, platform);
        const directiveLock = (orchId: string, body: Playbook) => directives.lockFor(orchId, body);
        return new ToolRegistry([
          ...buildReadTools({ pool, readonly: new ReadonlyQueryService(pool), skills }),
          ...buildDataTools({ pool, actions: infra.actions, env }),
          ...buildHighlightsTools({ pool }),
          ...buildComposeTools(),
          ...buildApiTools({ env }),
          ...buildRoleTools({
            pool, plans: repos.plans, memory: repos.memory, channels: repos.channels, ...ports,
            recordPublish: (k) => throttle.recordPublish(k),
            notifyPreview: env('EDITOR_SHADOW_PREVIEW') === 'false'
              ? undefined
              : (k, html) => notifier.notifyAlert(previewMessage(k, html)),
            schedule,
            // Spec 025 FR-014: directive experiment quotas in the plan check.
            experimentQuotas: experimentQuotasOf(pool),
            pollCaps: pollCapsOf(pool),
          }),
          ...buildComposerTools({ drafts, repo: repos.chat }),
          ...buildAgentSkillTools({ agents: infra.agents, skills: infra.skills, kpi: infra.kpi, inbox: infra.inbox }),
          ...buildBuilderTools({
            agents: infra.agents, catalog: infra.catalog, profiles: infra.profiles, creator: infra.creator, skills: infra.skills, actions: infra.actions,
          }),
          ...buildAgentChatTools({ pool, memory: repos.memory, skills: infra.skills, actions: infra.actions }),
          // Spec 023 FR-006: the owner steers the schedule from the chat (cards only).
          ...buildScheduleTools({ schedule, actions: infra.actions }),
          // Spec 023 FR-011: @ai0 previews a strategy migration and proposes its cards.
          ...buildMigrationTools({ svc: migration.svc, actions: infra.actions }),
          ...buildNetworkTools({
            repo: new NetworkRepository(pool), plans: repos.plans, memory: repos.memory, inbox: infra.inbox,
            sourceCatalog: (card) => seriesSourceCatalog(pool, card), schedule, directiveLock,
            experimentQuotas: experimentQuotasOf(pool),
            pollCaps: pollCapsOf(pool),
          }),
          // Spec 023 FR-003: the orchestrator's series tools (one submit path with submit_playbook).
          ...buildSeriesTools({ repo: new NetworkRepository(pool), inbox: infra.inbox, sourceCatalog: (card) => seriesSourceCatalog(pool, card), directiveLock }),
          ...buildDirectiveTools({
            repo: new DirectivesRepository(pool), agents: infra.agents, inbox: infra.inbox, memory: repos.memory, actions: infra.actions,
            digest: new KpiDigestService({ pool, catalog: infra.catalog, globalCapUsd: capDefaults(env).agentsDailyUsd, capUsd: agentsCapUsd(env, caps) }),
            channelKeyOf: (a) => infra.channelKeyOf(a),
            seriesLocked: async (orch, name) => isSeriesLocked((await new NetworkRepository(pool).activePlaybook(orch.id))?.body ?? null, name),
            exec: directives,
            // Spec 025 FR-006: the health contest check.
            scopeOf: directiveScope(pool), usable: (ref) => platform.health.usable(ref),
            // Spec 025 FR-015: report_directive_done checks the referenced row.
            taskRef: taskRefCheck(pool),
          }),
          // Spec 024 FR-010: @ai0 proposes a network mode change (Apply card).
          ...buildNetworkModeTool({
            agents: infra.agents, actions: infra.actions,
            groupOf: async (orch) => { const key = await infra.channelKeyOf(orch); return key ? new NetworkRepository(pool).groupOfChannel(key) : null; },
          }),
          // Spec 024 FR-013: agent-owned formatting per resource.
          ...buildFormatTools({ profiles: infra.profiles }),
          // Spec 024 FR-008: repurpose_post for the orchestrator, planner and executor; an Apply card for chat agents.
          ...buildRepurposeTools({
            service: new RepurposeService({ pool, plans: repos.plans }),
            networkFor: (orch, card) => networkContext({
              repo: new NetworkRepository(pool), usable: (ref) => platform.health.usable(ref), time: resourceTime(repos, infra.profiles),
              paused: (ref) => new ResourcePauseService({ pool }).isPaused(ref),
            }, orch, card),
            chatNetwork: chatNetwork(pool, repos, infra, (ref) => platform.health.usable(ref)),
            actions: infra.actions,
          }),
          ...buildPlatformTools({
            pool, publish: platform.publish, plans: repos.plans, schedule,
            notifyPreview: env('EDITOR_SHADOW_PREVIEW') === 'false' ? undefined : (ref, text) => notifier.notifyAlert(`👁 Shadow-превʼю ${ref}\n\n${text}`),
          }),
        ]);
      },
    },
    {
      provide: APPROVAL_INFRA,
      inject: [DB_POOL, EDITOR_REPOS, EDITOR_PUBLISH, AGENT_INFRA, PLATFORM_INFRA, PostingThrottleService, ConfigService, TelegramNotifier, ChannelConfigService],
      useFactory: (
        pool: Pool, repos: EditorRepos, ports: PublishPorts, infra: AgentInfra, platform: PlatformInfra, throttle: PostingThrottleService,
        cfg: ConfigService, notifier: TelegramNotifier, channelConfig: ChannelConfigService,
      ): ApprovalInfra => {
        const logger = new Logger('Approval');
        const repo = new ApprovalsRepository(pool);
        const ideas = new NetworkRepository(pool);
        const mode = async (card: EditorCard): Promise<ChannelMode> =>
          effectiveMode((await infra.runtime.forChannel(card.channelKey, 'executor')).orchestrator?.mode ?? null, card.mode);
        const publisher = new ApprovalPublisher({
          repo, plans: repos.plans, card: (k) => repos.channels.get(k), mode,
          telegram: { plans: repos.plans, ...ports, recordPublish: (k) => throttle.recordPublish(k) },
          platform: platform.publish,
          // Spec 022 reposts in approval mode: the approved forward goes out through the same Bot API call as live.
          forward: async (to, from, messageId) => (await botCall(channelConfig, to, 'forwardMessage', { from_chat_id: from, message_id: messageId })).message_id,
          notice: async (slot, title, body, alert) => {
            const orch = await infra.runtime.forChannel(slot.channelKey, 'executor').catch(() => null);
            await infra.inbox.post({ agentId: orch?.orchestrator?.id ?? null, kind: 'approval_dedup', severity: 'info', title, body, alert, refType: 'slot', refId: slot.id });
          },
          onSlotDone: async (slot) => { if (slot.ideaId) await ideas.settleIdea(slot.ideaId); },
          // Spec 025 FR-013: an approved post on a paused resource is skipped.
          paused: (ref) => new ResourcePauseService({ pool }).isPaused(ref),
          log: (m) => logger.warn(m),
        });
        // T4: one Telegram message per resource per batch through the owner's alert channel, deduped in approval_alerts.
        const alerts = new ApprovalAlerts({
          repo, card: (k) => repos.channels.get(k), notify: (t) => notifier.notifyAlert(t),
          dashboardUrl: cfg.get<string>('DASHBOARD_URL') ?? null, log: (m) => logger.warn(m),
        });
        const upkeep = new ApprovalUpkeep({ repo, publisher, alerts, card: (k) => repos.channels.get(k), mode, log: (m) => logger.log(m) });
        const stats = new ApprovalStatsRepository(pool);
        const ready = new ReadyForAutonomy({
          cards: () => repos.channels.listActive(), mode, stats,
          filedSince: async (key, since) => (await pool.query(
            `SELECT 1 FROM agent_inbox WHERE kind = 'ready_for_autonomy' AND ref_type = 'channel' AND ref_id = $1 AND created_at >= $2 LIMIT 1`,
            [key, since])).rows.length > 0,
          file: async (card, s) => {
            const orch = (await infra.runtime.forChannel(card.channelKey, 'executor')).orchestrator;
            const text = readyForAutonomyText(card, s);
            await infra.inbox.post({
              agentId: orch?.id ?? null, kind: 'ready_for_autonomy', severity: 'info', title: text.title, body: text.body,
              refType: 'channel', refId: card.channelKey,
            });
          },
          log: (m) => logger.warn(m),
        });
        return { repo, publisher, upkeep, mode, stats, ready };
      },
    },
    {
      provide: APPROVALS_SERVICE,
      inject: [EDITOR_REPOS, EDITOR_PUBLISH, APPROVAL_INFRA, PLATFORM_INFRA],
      useFactory: (repos: EditorRepos, ports: PublishPorts, approval: ApprovalInfra, platform: PlatformInfra) => new ApprovalsService({
        repo: approval.repo, card: (k) => repos.channels.get(k), media: ports.media, hostSlides: platform.publish.hostSlides,
        // Spec 031 FR-008: owner edits and reject reasons become owner preferences in the channel memory.
        remember: (key, pref) => repos.memory.add(key, pref.kind, pref.text, pref.evidence, 'owner'),
        log: (m) => new Logger('Approval').warn(m),
      }),
    },
    {
      // Spec 031 FR-010: the owner's approve ⇄ live switch (dialog numbers + the switch).
      provide: AUTONOMY_SERVICE,
      inject: [APPROVALS_SERVICE, APPROVAL_INFRA, AGENT_INFRA, EDITOR_OPS, EDITOR_REPOS],
      useFactory: (approvals: ApprovalsService, approval: ApprovalInfra, infra: AgentInfra, ops: EditorOpsService, repos: EditorRepos) => new AutonomyService({
        stats: approval.stats, card: (k) => repos.channels.get(k), mode: (c) => approval.mode(c),
        setMode: async (key, mode) => {
          // The card first (audited; leaving approval for shadow/off is not possible here), then its orchestrator.
          await ops.upsertChannel(key, { mode });
          const orch = await infra.agents.findTop('orchestrator', 'resource', resourceRef('telegram', key));
          if (orch && orch.mode !== mode) await infra.agents.update(orch.id, { mode, shadowUntil: null });
        },
        waiting: (key) => approval.repo.list({ status: ['awaiting_approval'], channel: key }),
        approve: (id) => approvals.approve(id),
      }),
    },
    {
      provide: EDITOR_LOOP,
      inject: [DB_POOL, ConfigService, TelegramNotifier, { token: PriceService, optional: true }, { token: LlmBudgetService, optional: true }],
      useFactory: (pool: Pool, cfg: ConfigService, notifier: TelegramNotifier, prices?: PriceService, caps?: LlmBudgetService): AgentLoop => {
        const logger = new Logger('Editor');
        const env = (k: string) => cfg.get<string>(k) ?? undefined;
        return new AgentLoop({
          llm: new OpenRouterClient({ apiKey: env('OPENROUTER_API_KEY'), baseUrl: env('OPENROUTER_BASE_URL'), prices }),
          recorder: new PgRunRecorder(pool, (m) => logger.warn(m)),
          budget: editorBudget(pool, env, (text) => notifier.notifyAlert(text), caps),
          enabled: () => isEnabled(cfg),
        });
      },
    },
    {
      provide: EDITOR_MANAGER,
      inject: [DB_POOL, ConfigService, EDITOR_LOOP, EDITOR_REGISTRY, AGENT_INFRA, EDITOR_REPOS, PLATFORM_INFRA, MODEL_DEFAULTS, { token: LlmBudgetService, optional: true }],
      useFactory: (
        pool: Pool, cfg: ConfigService, loop: AgentLoop, registry: ToolRegistry, infra: AgentInfra, repos: EditorRepos, platform: PlatformInfra,
        models: ModelDefaultsStore, caps?: LlmBudgetService,
      ): ManagerInfra => {
        const env = (k: string) => cfg.get<string>(k) ?? undefined;
        const repo = new DirectivesRepository(pool);
        const digest = new KpiDigestService({ pool, catalog: infra.catalog, globalCapUsd: capDefaults(env).agentsDailyUsd, capUsd: agentsCapUsd(env, caps) });
        const buildPort = new PlaybookBuildPort();
        const runner = new ManagerRunner({
          loop, registry, runtime: infra.runtime, agents: infra.agents, repo, digest, inbox: infra.inbox, env, defaultModel: () => models.get(),
          timeoutHours: envNum(env, 'DIRECTIVE_TIMEOUT_HOURS', 12),
          timeoutApplyKinds: (env('DIRECTIVE_TIMEOUT_APPLY_KINDS') ?? '').split(',').map((x) => x.trim()).filter(Boolean),
          exec: directiveExecution(pool, repos, infra, platform, buildPort),
          // Spec 025 FR-008: the contest timeout and the health guard on uphold.
          contestTimeoutHours: envNum(env, 'DIRECTIVE_CONTEST_TIMEOUT_HOURS', 24),
          usable: (ref) => platform.health.usable(ref),
        });
        return { repo, digest, runner, buildPort };
      },
    },
    {
      provide: PROMO_INFRA,
      inject: [DB_POOL, ConfigService, AGENT_INFRA, PLATFORM_INFRA, EDITOR_REPOS, EDITOR_MANAGER, ChannelConfigService],
      useFactory: (
        pool: Pool, cfg: ConfigService, infra: AgentInfra, platform: PlatformInfra, repos: EditorRepos, manager: ManagerInfra, channelConfig: ChannelConfigService,
      ): PromoInfra => {
        const env = (k: string) => cfg.get<string>(k) ?? undefined;
        // Never a public constant: without a configured secret, a per-process random salt (dedupe only within a run).
        const secret = env('PROMO_HASH_SALT') || env('TOKEN_ENCRYPTION_KEY');
        const salt = secret ? createHash('sha256').update(`ai0-promo:${secret}`).digest('hex') : randomBytes(32).toString('hex');
        if (!secret) new Logger('Promo').warn('PROMO_HASH_SALT / TOKEN_ENCRYPTION_KEY not set — join dedupe resets on restart');
        const links = new TrackedLinks({
          pool, salt, redirectBase: env('PUBLIC_BASE_URL') || env('DASHBOARD_URL') || null,
          createInvite: async (key, name) => (await botCall(channelConfig, key, 'createChatInviteLink', { name })).invite_link,
        });
        const network = new NetworkRepository(pool);
        const planner = new PromoPlanner({
          pool, plans: repos.plans, catalog: infra.catalog, profiles: infra.profiles, links, directives: manager.repo,
          card: (k) => repos.channels.get(k), usable: (ref) => platform.health.usable(ref),
          bestHours: async (orch, ref) => (await network.activePlaybook(orch.id))?.body.platforms.find((x) => x.resource_ref === ref)?.best_hours ?? [],
          paused: (ref) => new ResourcePauseService({ pool }).isPaused(ref),
        });
        return { links, planner };
      },
    },
    {
      provide: EDITOR_NETWORK,
      inject: [DB_POOL, ConfigService, EDITOR_LOOP, EDITOR_REPOS, EDITOR_REGISTRY, AGENT_INFRA, PLATFORM_INFRA, TelegramNotifier, EDITOR_MANAGER, PROMO_INFRA, SCHEDULE_INFRA, MODEL_DEFAULTS],
      useFactory: (
        pool: Pool, cfg: ConfigService, loop: AgentLoop, repos: EditorRepos, registry: ToolRegistry, infra: AgentInfra, platform: PlatformInfra,
        notifier: TelegramNotifier, manager: ManagerInfra, promo: PromoInfra, schedule: ScheduleService, models: ModelDefaultsStore,
      ): NetworkRunner => {
        const runner = new NetworkRunner({
          loop, registry, runtime: infra.runtime, memory: repos.memory, repo: new NetworkRepository(pool), plans: repos.plans, profiles: infra.profiles,
          usable: (ref) => platform.health.usable(ref), time: resourceTime(repos, infra.profiles),
          // Spec 025 FR-013: paused resources are out of every orchestrator / planner run.
          paused: (ref) => new ResourcePauseService({ pool }).isPaused(ref),
          directives: (orch) => manager.runner.deliver(orch),
          afterOrchestration: async (orch) => {
            await manager.runner.afterOrchestration(orch);
            // Accepted cross-promo / repost directives become reserved promo slots (spec 022).
            const key = telegramKeyOf(orch);
            if (!key) return;
            for (const dir of await manager.repo.list({ status: ['accepted'], toAgentId: orch.id })) {
              if (dir.kind !== 'cross_promo' && dir.kind !== 'repost') continue;
              const r = await promo.planner.schedule(dir, orch, key);
              if ('ok' in r) await manager.runner.recordBaseline((await manager.repo.get(dir.id))!, null);
            }
          },
          env: (k) => cfg.get<string>(k) ?? undefined,
          defaultModel: () => models.get(),
          notify: (t) => notifier.notifyAlert(t),
          // Spec 023 FR-008: source catalog in the orchestrator/planner prompts; low_runway after the daily run.
          catalogSummary: withSchedule(catalogSummaryOf(pool, (k) => cfg.get<string>(k) ?? undefined), schedule),
          runwayCheck: (orch, playbook) => checkLowRunway({ pool, inbox: infra.inbox }, orch, playbook),
          // Spec 025 FR-014: experiment quotas in the planner prompts.
          experimentQuotas: experimentQuotasOf(pool),
        });
        // Spec 025 FR-015: a strategy directive rebuilds the playbook through this runner (late-bound: the MANAGER exists first).
        manager.buildPort.bind(async (orchId, brief, directiveId) => {
          const orch = await infra.agents.get(orchId);
          const key = orch ? telegramKeyOf(orch) : null;
          const card = key ? await repos.channels.get(key) : null;
          if (!card) throw new Error('the orchestrator has no channel card');
          await runner.runPlaybookBuild(card, brief, { directiveId });
        });
        return runner;
      },
    },
    {
      provide: EDITOR_RUNNER,
      inject: [DB_POOL, ConfigService, EDITOR_REPOS, EDITOR_SKILLS, EDITOR_REGISTRY, TelegramNotifier, AGENT_INFRA, EDITOR_LOOP, EDITOR_NETWORK, SCHEDULE_INFRA, EDITOR_PUBLISH, MODEL_DEFAULTS],
      useFactory: (
        pool: Pool, cfg: ConfigService, repos: EditorRepos, skills: SkillLibrary, registry: ToolRegistry, notifier: TelegramNotifier,
        infra: AgentInfra, loop: AgentLoop, network: NetworkRunner, schedule: ScheduleService, ports: PublishPorts, models: ModelDefaultsStore,
      ): EditorRunnerService => {
        const logger = new Logger('Editor');
        const env = (k: string) => cfg.get<string>(k) ?? undefined;
        const notify = (text: string) => notifier.notifyAlert(text);
        const ideas = new NetworkRepository(pool);
        logger.log(`editor ${isEnabled(cfg) ? 'ENABLED' : 'disabled'}: ${registry.all().length} tools, ${skills.list().length} skills`);
        return new EditorRunnerService({
          loop, registry, skills, runtime: infra.runtime, plans: repos.plans, memory: repos.memory, env, notify, defaultModel: () => models.get(),
          network, platformContext: (slot, orchId) => network.platformContext(slot, orchId),
          catalogSummary: withSchedule(catalogSummaryOf(pool, env), schedule),
          seriesContext: (slot) => schedule.executorContext(slot),
          onSlotDone: async (slot) => { if (slot.ideaId) await ideas.settleIdea(slot.ideaId); },
          // Spec 024 FR-007: duplicate / adapt slots — the agent formats every target post itself.
          derived: derivedPorts(pool, ideas, infra, ports.holds ?? null),
          // Spec 034 FR-002: humour / slang / emoji of a slot's target resource (owner-only switches, off by default).
          // Spec 034 FR-005: plus the reader-question cap the platform lint enforces.
          voiceOf: async (ref) => {
            const f = await infra.profiles.formatOf(ref);
            const caps = await infra.profiles.capsOf(ref);
            return { humor: f.prefs.humor, slang: f.prefs.slang, emoji: f.prefs.emoji, readerQuestionsMax: caps.questionsPerDay };
          },
          // Spec 034 FR-010: a live slot's feeds are read by code first (fresh, unposted, not a repeat).
          live: {
            scan: async (slot, card) => slot.liveSpec
              ? scanLive({ pool }, { spec: slot.liveSpec, resourceRef: slot.resourceRef ?? `telegram:${slot.channelKey}`, card: card.sources, now: new Date(), excludeSlotId: slot.id })
              : null,
          },
        });
      },
    },
    {
      // Spec 025 FR-013: resource pauses (one service with the Inbox; the guards above build read-only ones).
      provide: RESOURCE_PAUSES,
      inject: [DB_POOL, AGENT_INFRA],
      useFactory: (pool: Pool, infra: AgentInfra) => new ResourcePausesApi(new ResourcePauseService({ pool, inbox: infra.inbox })),
    },
    {
      provide: EDITOR_SCHEDULER,
      inject: [DB_POOL, ConfigService, EDITOR_REPOS, EDITOR_RUNNER, EDITOR_PUBLISH, EDITOR_DRAFTS, TelegramNotifier, PostingThrottleService, EDITOR_NETWORK, EDITOR_MANAGER, AGENT_INFRA, ChannelConfigService, APPROVAL_INFRA, SCHEDULE_INFRA],
      useFactory: (
        pool: Pool, cfg: ConfigService, repos: EditorRepos, runner: EditorRunnerService, ports: PublishPorts, drafts: DraftsService,
        notifier: TelegramNotifier, throttle: PostingThrottleService, network: NetworkRunner, manager: ManagerInfra, infra: AgentInfra,
        channelConfig: ChannelConfigService, approval: ApprovalInfra, schedule: ScheduleService,
      ) => {
        const logger = new Logger('EditorScheduler');
        const notify = (t: string) => notifier.notifyAlert(t);
        const orders = new AdOrdersRepository(pool);
        // Spec 025 FR-013: pauses lift at their time; a held channel is not orchestrated or planned; paused slots are skipped.
        const pauses = new ResourcePauseService({ pool, inbox: infra.inbox });
        const held = channelHeldBy(new NetworkRepository(pool));
        const paused = (ref: string) => pauses.isPaused(ref);
        // Reserved slots publish deterministically, without the LLM: paid ads (spec 008) and scheduled chat posts (spec 010).
        // Spec 022 promos; in approval mode they wait for the owner (031 FR-009) and are written ahead in the approval lane.
        const promo = new PromoExecutor({
          plans: repos.plans, card: (k) => repos.channels.get(k), catalog: infra.catalog, profiles: infra.profiles,
          runExecutor: (slot, card, note) => runner.runExecutor(slot, card, note),
          forward: async (to, from, messageId) => (await botCall(channelConfig, to, 'forwardMessage', { from_chat_id: from, message_id: messageId })).message_id,
          mode: (card) => approval.mode(card),
          cards: () => repos.channels.listActive(),
          paused,
          log: (m) => logger.warn(m),
        });
        const reserved = new ReservedDispatcher({
          plans: repos.plans, orders,
          sponsored: new SponsoredPublisher({
            plans: repos.plans, channels: repos.channels, orders, publisher: ports.publisher,
            recordPublish: (k) => throttle.recordPublish(k),
            notify,
            log: (m) => logger.warn(m),
          }),
          manual: drafts,
          promo,
          paused,
          log: (m) => logger.warn(m),
        });
        // Spec 034 FR-011: news resources check their feeds on a cadence and add live slots for fresh items (no LLM).
        const newsWatch = new NewsWatchService({
          pool, profile: async (ref) => (await infra.profiles.get(ref))?.profile ?? null, log: (m) => logger.warn(m),
        });
        return new EditorScheduler({
          pool, channels: repos.channels, plans: repos.plans, runner, reserved,
          newsWatch: (card, now) => newsWatch.check(card, now),
          enabled: () => isEnabled(cfg),
          orchestrate: cfg.get<string>('EDITOR_ORCHESTRATION') === 'off' ? undefined : (card) => network.runOrchestrator(card),
          // Spec 024: the auto-duplicate gate is pinned at each anchor's plan-day boundary.
          pinGate: (card, now) => new NetworkRepository(pool).autoDuplicateActiveForChannel(card.channelKey, now),
          // Spec 023 FR-004: the owner's pins become fixed slots before the planner runs.
          pins: (card, now) => schedule.materialiseChannel(card, now),
          // The MANAGER at its times; an event run for orchestrators with fresh directives (spec 021).
          afterTick: async () => {
            // Spec 024 FR-007: held slides of sources whose derived slots are done (or waited 24 h).
            if (ports.holds) await ports.holds.sweep().catch((err) => logger.warn(`media holds sweep failed: ${err?.message ?? err}`));
            await manager.runner.tick();
            for (const orch of await manager.runner.orchestratorsToWake()) {
              const key = telegramKeyOf(orch);
              const card = key ? await repos.channels.get(key) : null;
              if (card && card.mode !== 'off' && !(await held(card, await pauses.pausedRefs(new Date())))) await network.runOrchestrator(card);
            }
          },
          // Spec 031: approval channels write ahead; approved posts, expiry and alerts run in their own lane.
          approval: {
            mode: (card) => approval.mode(card),
            tick: async (now) => {
              await approval.upkeep.tick(now);
              const n = await promo.writeAhead(now);
              if (n) logger.log(`approval: ${n} promo post(s) written ahead`);
            },
          },
          pauses: { liftDue: (now) => pauses.liftDue(now), pausedRefs: (now) => pauses.pausedRefs(now), held },
          notify,
          log: (m) => logger.warn(m),
        });
      },
    },
    {
      // Editor chat (spec 010): needs only an LLM key, independent of EDITOR_ENABLED.
      provide: EDITOR_CHAT,
      inject: [DB_POOL, ConfigService, EDITOR_REPOS, EDITOR_SKILLS, EDITOR_REGISTRY, EDITOR_DRAFTS, TelegramNotifier, AGENT_INFRA, EDITOR_MANAGER, MODEL_DEFAULTS, { token: PriceService, optional: true }, { token: LlmBudgetService, optional: true }],
      useFactory: (
        pool: Pool, cfg: ConfigService, repos: EditorRepos, skills: SkillLibrary, registry: ToolRegistry, drafts: DraftsService,
        notifier: TelegramNotifier, infra: AgentInfra, manager: ManagerInfra, models: ModelDefaultsStore, prices?: PriceService, caps?: LlmBudgetService,
      ): EditorChatService => {
        const logger = new Logger('EditorChat');
        const env = (k: string) => cfg.get<string>(k) ?? undefined;
        const enabled = () => !!env('OPENROUTER_API_KEY');
        const loop = new AgentLoop({
          llm: new OpenRouterClient({ apiKey: env('OPENROUTER_API_KEY'), baseUrl: env('OPENROUTER_BASE_URL'), prices }),
          recorder: new PgRunRecorder(pool, (m) => logger.warn(m)),
          budget: editorBudget(pool, env, (t) => notifier.notifyAlert(t), caps),
          enabled,
        });
        const agentsPort: AgentChatPort = {
          byHandle: (h) => infra.agents.getByHandle(h),
          get: (id) => infra.agents.get(id),
          forAgent: (a, role) => infra.runtime.forAgent(a, role),
          profileOf: async (a) => {
            const orch = a.parentId ? (await infra.agents.get(a.parentId)) ?? a : a;
            if (!orch.scopeId) return null;
            return (await infra.profiles.get(orch.scope === 'network' ? `network:${orch.scopeId}` : orch.scopeId))?.profile ?? null;
          },
          channelKeyOf: (a) => infra.channelKeyOf(a),
          agentsSummary: async () => (await infra.agents.list()).filter((a) => !a.parentId)
            .map((a) => `- @${a.handle} ${a.emoji ?? ''} ${a.name} · ${a.kind} · ${a.scopeId ?? a.scope} · ${a.mode}${a.status === 'paused' || a.pausedUntil ? ' · пауза' : ''}`).join('\n'),
          handles: async () => (await infra.agents.list()).filter((a) => !a.parentId).map((a) => a.handle),
          actionsForChat: (chatId) => infra.actionsRepo.listForChat(chatId),
          managerDigest: async () => manager.digest.render(await manager.digest.build()),
        };
        return new EditorChatService({
          repo: repos.chat, drafts, memory: repos.memory, loop, registry, skills, env, enabled, agents: agentsPort, defaultModel: () => models.get(),
        });
      },
    },
    {
      provide: EDITOR_OPS,
      inject: [ConfigService, EDITOR_REPOS, EDITOR_RUNNER, EDITOR_REGISTRY, EDITOR_SKILLS],
      useFactory: (cfg: ConfigService, repos: EditorRepos, runner: EditorRunnerService, registry: ToolRegistry, skills: SkillLibrary) => {
        const logger = new Logger('EditorOps');
        return new EditorOpsService({
          channels: repos.channels, plans: repos.plans, memory: repos.memory, runs: repos.runs,
          runner, registry, skills,
          enabled: () => isEnabled(cfg),
          log: (m) => logger.warn(m),
        });
      },
    },
    {
      provide: AGENTS_SERVICE,
      inject: [DB_POOL, AGENT_INFRA, EDITOR_REPOS, EDITOR_OPS, EDITOR_RUNNER, EDITOR_NETWORK, EDITOR_MANAGER, MODELS_SERVICE],
      useFactory: (
        pool: Pool, infra: AgentInfra, repos: EditorRepos, ops: EditorOpsService, runner: EditorRunnerService, network: NetworkRunner, manager: ManagerInfra,
        models: ModelsService,
      ) => {
        const logger = new Logger('Agents');
        const svc: AgentsService = new AgentsService({
          pool, agents: infra.agents, skills: infra.skills, inbox: infra.inbox, profiles: infra.profiles, actions: infra.actions,
          setChannelMode: (key, mode) => ops.upsertChannel(key, { mode }),
          memory: (key) => repos.memory.listActive(key, 100),
          sync: () => infra.registry.run(),
          // Spec 035: agent models are checked against the catalog and priced in llm_prices when new.
          models: { check: (m, cur) => models.checkAgentModel(m, cur), chosen: (m) => models.ensurePrice(m) },
          log: (m) => logger.warn(m),
          runNow: async (agent, orch) => {
            const key = telegramKeyOf(orch);
            if (agent.kind === 'orchestrator' || agent.kind === 'planner') {
              if (!key) return { started: false, what: 'no channel' };
              await ops.replan(key, { wait: false });
              return { started: true, what: 'planner' };
            }
            if (agent.kind === 'reviewer' && key) {
              const card = await repos.channels.get(key);
              if (!card) return { started: false, what: 'no card' };
              void runner.runReviewer(card).catch((err) => logger.warn(`reviewer run failed: ${err?.message ?? err}`));
              return { started: true, what: 'reviewer' };
            }
            return { started: false, what: `${agent.kind} runs on its own schedule` };
          },
        });
        registerAgentActions(infra, svc, ops);
        // A directive the owner approved in the chat with @manager (spec 021): filed as owner-approved, never shadow.
        infra.actions.register('file_directive', async (p) => {
          const input = FileDirectiveInput.parse(p);
          const r = await fileDirective({
            repo: manager.repo, agents: infra.agents, digest: manager.digest, inbox: infra.inbox, memory: repos.memory, actions: infra.actions,
            channelKeyOf: (a) => infra.channelKeyOf(a), exec: manager.runner.exec,
          }, input, { from: await manager.runner.manager(), runId: null, shadow: false, ownerApproved: true });
          if ('error' in r) throw new Error(`${r.error}: ${r.details ?? ''}`);
          return { id: r.directive.id, status: r.directive.status };
        });
        // Spec 024 FR-008: a repurpose the owner applied from the chat (decided_by owner, outside the agent's daily cap).
        infra.actions.register('repurpose', async (p) => {
          const { handle, ...rest } = p as Record<string, unknown>;
          const input = RepurposeInput.parse(rest);
          const agent = await svc.require(String(handle));
          const c = await chatNetwork(pool, repos, infra)(agent);
          if (!c) throw new Error('no_network: this channel is not part of a network');
          const r = await new RepurposeService({ pool, plans: repos.plans }).run(c.net, c.card, input, { decidedBy: 'owner' });
          if ('error' in r) throw new Error(`${r.error}: ${typeof r.details === 'string' ? r.details : JSON.stringify(r.details ?? '')}`);
          return r;
        });
        // Spec 032 FR-010: an agent's description fix for a dataset, applied by the owner (description-only, never a version bump).
        infra.actions.register('edit_data_schema', (p) => applyDataSchemaSuggestion(new DataStore(pool), p));
        svc.setBriefHook(async (agent, brief) => {
          const key = telegramKeyOf(agent);
          const card = key ? await repos.channels.get(key) : null;
          if (card) void network.runPlaybookBuild(card, brief).catch((err) => logger.warn(`playbook build failed: ${err?.message ?? err}`));
        });
        return svc;
      },
    },
    {
      provide: NETWORK_SERVICE,
      inject: [DB_POOL, AGENT_INFRA, EDITOR_REPOS, EDITOR_NETWORK, PLATFORM_INFRA, EDITOR_MANAGER],
      useFactory: (pool: Pool, infra: AgentInfra, repos: EditorRepos, network: NetworkRunner, platform: PlatformInfra, manager: ManagerInfra) => {
        const logger = new Logger('Network');
        const svc = new NetworkService({
          pool, agents: infra.agents, repo: new NetworkRepository(pool), inbox: infra.inbox,
          card: (k) => repos.channels.get(k), usable: (ref) => platform.health.usable(ref), time: resourceTime(repos, infra.profiles),
          rebuild: (card, brief) => network.runPlaybookBuild(card, brief),
          log: (m) => logger.warn(m),
          // Spec 024 FR-010: offers to convert legacy auto-duplicate networks.
          offers: new NetworkOffers({ pool, inbox: infra.inbox, log: (m) => logger.warn(m) }),
          // Spec 025 FR-015: the owner activating / rejecting a strategy directive's version settles the directive.
          onPlaybookDecided: (pb, approve) => manager.runner.exec.onPlaybookDecided(pb, approve),
        });
        // Spec 024 FR-010: a network mode change @ai0 proposed in the chat, applied by the owner.
        infra.actions.register('set_network_mode', async (p) => svc.setMode(String(p.handle), { mode: p.mode }));
        return svc;
      },
    },
    {
      provide: MANAGER_SERVICE,
      inject: [AGENT_INFRA, EDITOR_MANAGER],
      useFactory: (infra: AgentInfra, manager: ManagerInfra) => {
        const logger = new Logger('Manager');
        return new ManagerService({ repo: manager.repo, agents: infra.agents, digest: manager.digest, runner: manager.runner, log: (m) => logger.warn(m) });
      },
    },
    {
      provide: PROMO_SERVICE,
      inject: [DB_POOL, AGENT_INFRA, PROMO_INFRA],
      useFactory: (pool: Pool, infra: AgentInfra, promo: PromoInfra) =>
        new PromoService({ pool, agents: infra.agents, network: new NetworkRepository(pool), links: promo.links }),
    },
    EditorCron,
    AgentsUpkeep,
    StrategyMigrationUpkeep,
];

@Module({
  // AuthModule: EditorController is guarded by TrackingAuthGuard, which injects AuthService.
  imports:     [ChannelConfigModule, PublishersModule, AuthModule],
  controllers: [EditorController, EditorChatController, AgentsController, ModelsController, NetworkController, ManagerController, PromoController, PromoRedirectController, ApprovalsController, AutonomyController, ScheduleController, StrategyMigrationController, UpcomingSlotsController, ResourcePausesController],
  providers:   [...EDITOR_PROVIDERS, TrackingAuthGuard],
  exports:     [EDITOR_REPOS, EDITOR_RUNNER, AGENT_INFRA, PLATFORM_INFRA, EDITOR_MANAGER],
})
export class EditorModule {}
