import { Inject, Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import type { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import { resourceStyleOf } from './post/style/style-store';
import { proposeStyle } from './post/style/style-proposal';
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
import { AnthropicClient, RoutingLlmClient } from './llm/anthropic.client';
import { WorkspaceModelStore, WorkspaceStore, anthropicApiKey } from './llm/workspace';
import { AgentLoop } from './harness/agent-loop';
import { ToolRegistry } from './harness/tool-registry';
import { PgRunRecorder } from './harness/run-recorder';
import { BudgetService, DEFAULT_RUN_HEADROOM_USD, DEFAULT_WRITER_RESERVE_PCT } from './harness/budget.service';
import { DEFAULT_REJECT_STREAK, SilentDaysWatch } from './silent/silent-days';
import { DEFAULT_SERIES_SKIP_STREAK, SeriesBreaker } from './series-pause/series-breaker';
import { SeriesPausesRepository } from './series-pause/series-pauses.repository';
import { PlannerPauseView } from './series-pause/planner-view';
import { EVERGREEN_KPI_SAMPLE_FILTER, EvergreenStep, evergreenPerDay } from './silent/evergreen';
import { ReadonlyQueryService } from './db/readonly-query.service';
import { SkillLibrary } from './skills/skill-library';
import { buildReadTools } from './tools/read-tools';
import { scanLive } from './live/feed-items';
import { NewsWatchService } from './live/news-watch';
import { buildComposeTools } from './tools/compose-tools';
import { PgHostFailures } from './net/host-failures';
import { buildSourceTools, applySourceChangeAction } from './sources/source-tools';
import { candidateDeps, sourceChangeHandled, sourceHealthOf } from './sources/source-wiring';
import { NETWORK_HEALTH, NetworkHealthController } from './health/network-health.controller';
import { ARTIFACTS_SERVICE, ArtifactsController } from './artifacts/artifacts.controller';
import { ArtifactsService } from './artifacts/artifacts.service';
import { ArtifactVersionsRepository } from './artifacts/artifact-versions.repository';
import { buildArtifactTools, applyUpdateArtifact, UPDATE_ARTIFACT_KIND } from './artifacts/artifact-tools';
import { memoryAdapter, playbookAdapter, profileAdapter, rulesAdapter, setupAdapter, skillAdapter, steeringAdapter } from './artifacts/artifact-adapters';
import { NetworkHealthService } from './health/network-health.service';
import { budgetSnapshot } from '../spend/spend.service';
import { SpendRepository } from '../spend/spend.repository';
import { sourcesToReplaceBlock } from './sources/source-health.service';
import { SOURCE_CHANGE_KIND } from './sources/source-change';
import { buildRoleTools, STORY_KPI_SAMPLE_FILTER } from './tools/role-tools';
import { StoryRegistry } from './story/story.repository';
import { StoryContextService } from './story/story-service';
import { EventRecapWatch } from './story/event-watch';
import { buildStoryTools, storyRepostLimits } from './story/story-tools';
import { StoryBackfill } from './story/story-backfill';
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
import { buildSlotPreflight } from './preflight/preflight-wiring';
import { EditorScheduler } from './editor.scheduler';
import { htmlToPlain } from './post/inline-markup';
import { EditorRunsRepository } from './repo/editor-runs.repository';
import { EditorChatRepository } from './repo/editor-chat.repository';
import { ReservedDispatcher } from './publish/reserved-dispatcher';
import { SponsorFulfilment } from '../payments/sponsor-fulfilment';
import { SponsorOrdersRepository } from '../payments/sponsor-orders.repository';
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
import { LoadoutRepository } from './loadout/loadout.repository';
import { LoadoutService } from './loadout/loadout.service';
import { LoadoutUsage } from './loadout/loadout-usage';
import { LoadoutCreation, resourcePlatforms } from './loadout/loadout-creation';
import { LoadoutAdminService, rulesTarget } from './loadout/loadout.admin.service';
import { LoadoutController, LOADOUT_SERVICE } from './loadout/loadout.controller';
import { rulesSummary } from './loadout/loadout-rules';
import { LoadoutScan, postWeeklyLoadoutNote } from './loadout/loadout-notes';

/** Spec 054 FR-005: the loadout suggestions of every agent (digest block, weekly owner note). */
export const LOADOUT_SCAN = 'LOADOUT_SCAN';
import type { ToolRegistry as LoadoutRegistry } from './harness/tool-registry';
import { SkillVersionEvaluator } from './agents/skill-version-evaluator';
import { buildAgentSkillTools } from './agents/agent-skill-tools';
import { probeSettings, SkillProbe } from './agents/skill-probe';
import { LlmPairwiseJudge } from './agents/skill-probe-judge';
import { pickProbeSlots } from './agents/skill-probe-samples';
import { AgentsService } from './agents/agents.service';
import { AGENTS_SERVICE, AgentsController } from './agents/agents.controller';
import { telegramKeyOf, parseResourceRef, resourceRef, isPaused as isAgentPaused } from './agents/agent.types';
import type { Agent } from './agents/agent.types';
import { renderFormatPrefs, ResourceProfilesRepository } from './agents/resource-profile';
import { ResourceCatalog, makeTelegramAccessCheck } from './agents/resource-catalog';
import { KeepPendingError, PendingActionsRepository, PendingActionsService } from './agents/pending-actions';
import { AgentCreator } from './agents/agent-creator';
import { ConfigConflictsService } from './rules/config-conflicts.service';
import { buildBuilderTools, FIX_CONFIG_CONFLICTS_KIND } from './agents/builder-tools';
import { buildContentExamplesTool, CONTENT_EXAMPLES_KIND, examplesFromChoice, type ContentExamplesPayload } from './agents/content-examples';
import { applyOwnerRule, buildAgentChatTools, OWNER_RULE_KIND } from './agents/agent-chat-tools';
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
import { statsSummaryOf } from './network/network-stats';
import { MAX_LADDER_EXTRA_STEPS } from './silent/fallback-ladder';
import { isSeriesLocked, seriesSourceCatalog } from './network/series-edit';
import { NetworkService } from './network/network.service';
import { NetworkOffers } from './network/network-offers';
import { buildNetworkModeTool } from './network/network-mode-tool';
import { NETWORK_SERVICE, NetworkController } from './network/network.controller';
import { TrackingMtprotoClient } from '../tracking/mtproto/tracking-mtproto.client';
import { TrackingService } from '../tracking/api/tracking.service';
import { TrackedChannelsRepository } from '../tracking/repositories/tracked-channels.repository';
import { resolveModel } from './llm/model-registry';
import { agentModelIn, readModelContext } from './llm/workspace';
import { storedFormat } from './agents/resource-profile';
import { boundDatasets, ChannelSetupRepository } from './setup/setup.repository';
import { ChannelSetupService } from './setup/setup.service';
import { CHANNEL_SETUP_SERVICE, ChannelSetupController } from './setup/setup.controller';
import { SetupExpiry, setupTtlDays } from './setup/setup-expiry';
import type { ApplyWriters, ChannelState } from './setup/setup-apply';
import { LAUNCH_SERVICE, LaunchController } from './launch/launch.controller';
import { MAP_ACTIONS, MAP_SERVICE, MapController } from './map/map.controller';
import { MapActions } from './map/map.actions';
import { MapService } from './map/map.service';
import { launchSource } from './launch/launch-cards';
import { graduationLineUk, graduationSettings } from './launch/launch-graduation';
import { launchQueries } from './launch/launch-queries';
import { launchJson, LaunchService } from './launch/launch.service';
import { LaunchRepository } from './launch/launch.repository';
import { makeLaunchBotCheck } from './launch/launch-bot';
import { launchAdapter, launchTitle } from './launch/launch-artifact';
import { buildLaunchChannelTool } from './launch/launch-tool';
import { buildAuditorTools } from './sysadmin/auditor-tools';
import { AuditorRunner } from './sysadmin/auditor-runner';
import { AuditQueries } from './sysadmin/audit-queries';
import { AuditRepository } from './sysadmin/audit-report';
import { AuditService } from './sysadmin/audit.service';
import { AUDIT_SERVICE, AuditController } from './sysadmin/audit.controller';
import { AuditTick } from './sysadmin/audit-schedule';
import { auditAdapter, auditTitle } from './sysadmin/audit-artifact';
import { playbookPort, retireMemoryPort } from './sysadmin/audit-ports';
import { collectPosts, trackedChannel } from './setup/setup-posts';
import { VOICE_SKILL_NAME } from './setup/setup-analysis';
import { refName, SteeringRepository } from './steering/steering.repository';
import type { SlashDeps } from './chat/slash-commands';
import { alignAgent } from './chat/align';
import { SteeringService } from './steering/steering.service';
import { STEERING_SERVICE, SteeringController } from './steering/steering.controller';
import { telegramReader } from './steering/steering-source';
import { OwnerBotService } from './owner-bot/owner-bot.service';
import { OWNER_BOT, OwnerBotWorker, type OwnerBotInfra } from './owner-bot/owner-bot.worker';
import { OwnerReports } from './owner-bot/owner-reports';
import { OwnerBotController } from './owner-bot/owner-bot.controller';
import { OwnerCardsRepository } from './owner-bot/owner-cards.repository';
import { cardSources } from './owner-bot/card-sources';
import { telegramBotApi } from './owner-bot/bot-api';
import { SETUP_SECTIONS } from './setup/setup-analysis';
import { buildSteerChannelTool } from './steering/steering-tool';
import { ownerRulesOf } from './rules/owner-rules-prompt';
import { lintOwnerRule } from './agents/rule-lint';
import { renderPlaybook } from './network/playbook';
import { renderProfile } from './agents/resource-profile';
import { buildAnalyzeHistoryTool } from './setup/setup-tool';
import { DirectivesRepository } from './manager/directives.repository';
import { KpiDigestService } from './manager/kpi-digest.service';
import { SqlQuality } from './manager/quality-digest';
import { recentAuditPosts } from './post/variety/recent-posts';
import { commitmentsText, ManagerRunner } from './manager/manager-runner';
import { buildDirectiveTools, fileDirective, FileDirectiveInput } from './manager/directive-tools';
import { ManagerService } from './manager/manager.service';
import { MANAGER_SERVICE, ManagerController } from './manager/manager.controller';
import type { Playbook } from './network/playbook';
import {
  DirectiveExecution, executionContextOf, experimentExecutor, formatMixExecutor, formatShiftExecutor, frequencyExecutor, pauseResourceExecutor, pauseSeriesExecutor,
  adviceVerifier, PlaybookBuildPort, promoVerifier, SqlExperimentQuotas, SqlPlanObserver, strategyExecutor, taskRefCheck, voiceFixExecutor,
} from './manager/executors';
import { channelHeldBy, ResourcePauseService } from './pauses/resource-pauses';
import { RESOURCE_PAUSES, ResourcePausesApi, ResourcePausesController } from './pauses/resource-pauses.controller';
import { TrackedLinks } from './promo/tracked-links';
import { PromoPlanner, relevance } from './promo/promo-planner';
import { PromoExecutor } from './promo/promo-executor';
import { PromoService } from './promo/promo.service';
import { isPairBlocked } from './promo/promo-links';
import { PROMO_SERVICE, PromoController, PromoRedirectController } from './promo/promo.controller';
import { onChatMember } from '../publishers/chat-member-bus';
import { createHash, randomBytes } from 'crypto';
import { TrackingAuthGuard } from '../tracking/api/tracking-auth.guard';
import { PriceService } from '../common/ai/usage/price.service';
import { LlmPricesRepository } from '../common/ai/usage/llm-prices.repository';
import { CriticService } from './critic/critic.service';
import { libraryTextOf } from './critic/critic-source';
import { anthropicCatalog, ModelCatalog } from './models/model-catalog';
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
import { buildScheduleTools, registerScheduleActions, registerSlotRunActions } from './schedule/schedule-tools';
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
import { POST_AUDIT, PostAuditApi, PostAuditController } from './audit/post-audit.controller';
import { editorCardAudit, PostAuditService } from './audit/post-audit.service';
import { approvalFindingsHook } from './audit/approval-findings';
import { attachProfileTone } from './skills/profile-tone';

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
/** Spec 034 FR-004: the owner's critic model (app_settings `ai.critic_model`) and the pre-publish critic. */
export const CRITIC_MODEL     = 'CRITIC_MODEL';
/** Spec 059: tries a skill self-edit on recent posts before it goes live. */
export const SKILL_PROBE      = 'SKILL_PROBE';
/** Spec 038: the active model workspace (WorkspaceStore). */
export const MODEL_WORKSPACE  = 'MODEL_WORKSPACE';
export const EDITOR_CRITIC    = 'EDITOR_CRITIC';

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
  /** Spec 054: the agent's own tool set (agent_tools), resolved once per run. */
  loadout:  LoadoutService;
  loadoutRepo:  LoadoutRepository;
  loadoutUsage: LoadoutUsage;
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
/** Spec 040 FR-011: rules-vs-config over the editor repositories. */
function configConflictsOf(pool: Pool, repos: Pick<EditorRepos, 'memory' | 'channels'>, infra: Pick<AgentInfra, 'profiles' | 'skills' | 'agents'>): ConfigConflictsService {
  return new ConfigConflictsService({
    memory: repos.memory, network: new NetworkRepository(pool), channels: repos.channels, profiles: infra.profiles,
    ruleLint: (text, orch) => ownerRuleLint(infra, text, orch),
  });
}

/** Spec 047 FR-004: an owner rule against the agent's skills and the network's agents. */
/** Spec 048: the artifact registry, for the chat tools built before it (the registry → agents → runner cycle). */
const ARTIFACTS: { svc?: ArtifactsService } = {};
/** Spec 052: the launch service, bound late (the tool registry and the artifacts come before it). */
const LAUNCH: { svc?: LaunchService } = {};
/** Spec 054: the tool registry for the loadout of a new agent, bound late (the registry is built after the agent infrastructure). */
const LOADOUT_REGISTRY: { reg?: Pick<LoadoutRegistry, 'all'> } = {};
/** Spec 055: the audit service, bound late (the chat's /audit command is built before it). */
const AUDIT: { svc?: AuditService } = {};

async function ownerRuleLint(infra: Pick<AgentInfra, 'skills' | 'agents'>, text: string, orch: Agent) {
  return lintOwnerRule(text, {
    skillExists: async (name) => !!((await infra.skills.findForAgent(orch.id, name)) ?? (await infra.skills.findShared(name))),
    handles: (await infra.agents.list()).map((x) => x.handle),
  });
}

/** Every top-level orchestrator's conflicts, for the manager digest. */
function networkConflicts(infra: Pick<AgentInfra, 'agents'>, svc: ConfigConflictsService) {
  return async () => {
    const out: Array<{ agent: string; ref: string; code: string; detail: string }> = [];
    for (const a of await infra.agents.list()) {
      if (a.kind !== 'orchestrator' || a.parentId) continue;
      for (const c of await svc.forAgent(a).catch(() => [])) out.push({ agent: a.handle, ref: c.ref, code: c.code, detail: c.detail });
    }
    return out;
  };
}

/** Every top orchestrator whose profile names a tone family gets that tone skill, unless the owner set it already. */
async function attachProfileTones(infra: Pick<AgentInfra, 'agents' | 'profiles' | 'skills'>): Promise<string[]> {
  const out: string[] = [];
  for (const a of await infra.agents.list()) {
    if (a.parentId || a.kind !== 'orchestrator' || !a.scopeId) continue;
    const ref = a.scope === 'network' ? `network:${a.scopeId}` : a.scopeId;
    const profile = (await infra.profiles.get(ref).catch(() => null))?.profile ?? null;
    const name = await attachProfileTone({ skills: infra.skills }, a, profile);
    if (name) out.push(`@${a.handle} ${name}`);
  }
  return out;
}

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
 * Spec 025 FR-009: the directive executors (frequency, format_shift, pause_series, pause_resource; T5: experiment, strategy;
 * spec 034 T4: voice_fix, format_mix) and
 * the promo verifiers, with their runner. `buildPort` is bound only for the MANAGER's instance (it applies).
 */
function directiveExecution(pool: Pool, repos: EditorRepos, infra: AgentInfra, platform: PlatformInfra, buildPort = new PlaybookBuildPort()): DirectiveExecution {
  const logger = new Logger('DirectiveExecution');
  const network = new NetworkRepository(pool);
  const deps = { network, channels: repos.channels, observer: new SqlPlanObserver(pool) };
  const quotas = new SqlExperimentQuotas(pool);
  const pauses = new ResourcePauseService({ pool, inbox: infra.inbox });
  // Spec 034 FR-006: the content-quality executors (voice_fix, format_mix) and their evidence / caps readers.
  const quality = new SqlQuality(pool);
  const qdeps = { ...deps, profiles: infra.profiles, quality };
  return new DirectiveExecution({
    repo: new DirectivesRepository(pool), inbox: infra.inbox, agents: infra.agents,
    context: executionContextOf({
      repo: network, channels: repos.channels, usable: (ref) => platform.health.usable(ref), time: resourceTime(repos, infra.profiles), pauses,
      evidence: (refs, since) => quality.evidencePosts(refs, since), audience: (refs) => quality.audience(refs),
    }),
    executors: [
      frequencyExecutor(deps), formatShiftExecutor(deps), pauseSeriesExecutor(deps), pauseResourceExecutor({ pauses }),
      experimentExecutor({ quotas }), strategyExecutor({ network, builder: buildPort }),
      voiceFixExecutor(qdeps), formatMixExecutor(qdeps),
    ],
    verifiers: [promoVerifier(pool, 'cross_promo'), promoVerifier(pool, 'repost'), adviceVerifier(pool)],
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
  return new BudgetService(pool, {
    globalDailyUsd: d.agentsDailyUsd, channelDailyUsd: d.resourceDailyUsd,
    // Spec 046 FR-005: the share of the agents' cap the manager / orchestrators / reviewers leave to the writer and critic.
    writerReservePct: envNum(env, 'EDITOR_WRITER_RESERVE_PCT', DEFAULT_WRITER_RESERVE_PCT),
  }, alert, caps);
}

/** The agents' cap (`editor.*` row of llm_budgets) for the KPI digest; the env default without the ledger module. */
/**
 * The loop of an owner-started analysis (spec 042 setup, spec 045 steering): like a chat turn, it runs whenever a model
 * key is configured, not only with EDITOR_ENABLED.
 */
function ownerStartedLoop(
  pool: Pool, env: (k: string) => string | undefined, notifier: TelegramNotifier, logger: Logger, prices?: PriceService, caps?: LlmBudgetService,
): AgentLoop {
  return new AgentLoop({
    llm: new RoutingLlmClient({
      openrouter: new OpenRouterClient({ apiKey: env('OPENROUTER_API_KEY'), baseUrl: env('OPENROUTER_BASE_URL'), prices }),
      anthropic:  new AnthropicClient({ apiKey: anthropicApiKey(env), baseUrl: env('ANTHROPIC_BASE_URL'), prices, toolsCacheTtl: env('EDITOR_ANTHROPIC_TOOLS_CACHE_TTL') === '1h' ? '1h' : null }),
    }),
    recorder: new PgRunRecorder(pool, (m) => logger.warn(m)),
    budget: editorBudget(pool, env, (t) => notifier.notifyAlert(t), caps),
    enabled: () => !!env('OPENROUTER_API_KEY') || !!anthropicApiKey(env),
  });
}

/** The onboarder's model for a channel: its agent's and the workspace's choices. */
function onboarderModel(env: (k: string) => string | undefined, models: WorkspaceModelStore) {
  return async (agent: Agent | null, card: EditorCard | null) => {
    const mctx = await readModelContext({ workspace: () => models.workspace(), defaultModel: (ws) => models.get(ws) });
    return resolveModel('onboarder', env, card?.models ?? null, {
      agentModel: agent ? agentModelIn(agent, mctx.workspace) : null, defaultModel: mctx.defaultModel,
      reasoningEffort: agent?.reasoningEffort ?? null, workspace: mctx.workspace,
    });
  };
}

/** Spec 042: a channel's card, agent, profile, locks, active playbook, voice skill and bound datasets now (also 052). */
function channelStateOf(pool: Pool, repos: EditorRepos, infra: AgentInfra): (key: string) => Promise<ChannelState> {
  const network = new NetworkRepository(pool);
  return async (key) => {
    const ref = `telegram:${key}`;
    const [card, agent, stored] = await Promise.all([repos.channels.get(key), infra.agents.findTop('orchestrator', 'resource', ref), infra.profiles.get(ref)]);
    const raw = stored ? (await pool.query(`SELECT profile FROM resource_profiles WHERE resource_ref = $1`, [ref])).rows[0]?.profile : null;
    const playbook = agent ? (await network.activePlaybook(agent.id))?.body ?? null : null;
    const voice = agent ? (await infra.skills.findForAgent(agent.id, VOICE_SKILL_NAME))?.body ?? null : null;
    const datasets = await boundDatasets(pool, ref, playbook);
    return { card, agent, profile: stored?.profile ?? null, locks: storedFormat(raw).locks, playbook, voice, datasets };
  };
}

/** Spec 042 FR-006: the writers a setup (and, spec 052, a launch Start) applies through, as the owner. */
function setupWriters(
  repos: EditorRepos, infra: AgentInfra, ops: EditorOpsService, agentsSvc: AgentsService, networkSvc: NetworkService, reason: string,
): ApplyWriters {
  const orchOf = (key: string) => infra.agents.findTop('orchestrator', 'resource', `telegram:${key}`);
  return {
    upsertCard: (key, patch) => ops.upsertChannel(key, patch),
    getCard: (key) => repos.channels.get(key),
    ensureAgent: async (key) => {
      await infra.registry.run();
      const a = await orchOf(key);
      if (!a) throw new Error(`agent_not_created: no orchestrator for ${key}`);
      return a;
    },
    setProfile: (ref, profile) => agentsSvc.setProfile(ref, profile, 'owner'),
    patchFormat: (ref, patch) => infra.profiles.patchFormat(ref, patch, { by: 'owner', reason }),
    onBrief: (agent, brief) => agentsSvc.onBrief(agent, brief),
    putPlaybook: (handle, body, rationale) => networkSvc.putPlaybook(handle, { body, rationale }),
    putVoiceSkill: async (handle, skill) => {
      await agentsSvc.putSkill(handle, VOICE_SKILL_NAME, { description: skill.description, body: skill.body, applies_to: ['executor', 'checker'] });
      await agentsSvc.patchSkill(handle, VOICE_SKILL_NAME, { enabled: true });
    },
  };
}

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

/** Spec 042 FR-007: the channel setup queue (the proposals table) — a tick a minute and one at boot. */
@Injectable()
export class ChannelSetupWorker implements OnModuleInit {
  private readonly logger = new Logger('ChannelSetup');

  constructor(@Inject(CHANNEL_SETUP_SERVICE) private readonly setup: ChannelSetupService) {}

  onModuleInit(): void {
    void this.tick();
  }

  @Cron('* * * * *', { name: 'channel-setup-tick' })
  async tick(): Promise<void> {
    try { await this.setup.tick(); } catch (err: any) { this.logger.warn(`channel setup tick failed: ${err?.message ?? err}`); }
  }
}

/** Spec 045: the steering queue (steering_sets) — a tick a minute and one at boot. */
@Injectable()
export class SteeringWorker implements OnModuleInit {
  private readonly logger = new Logger('Steering');

  constructor(@Inject(STEERING_SERVICE) private readonly steering: SteeringService) {}

  onModuleInit(): void {
    void this.tick();
  }

  @Cron('* * * * *', { name: 'steering-tick' })
  async tick(): Promise<void> {
    try { await this.steering.tick(); } catch (err: any) { this.logger.warn(`steering tick failed: ${err?.message ?? err}`); }
  }
}

/** Spec 052: channel launches — a tick a minute (preparation, then the checklist, graduation and promos) and one at boot. */
@Injectable()
export class LaunchWorker implements OnModuleInit {
  private readonly logger = new Logger('Launch');

  constructor(@Inject(LAUNCH_SERVICE) private readonly launches: LaunchService) {}

  onModuleInit(): void {
    void this.tick();
  }

  @Cron('* * * * *', { name: 'launch-tick' })
  async tick(): Promise<void> {
    try { await this.launches.tick(); } catch (err: any) { this.logger.warn(`launch tick failed: ${err?.message ?? err}`); }
  }
}

/** Spec 059: probes the skill edits that wait as `probing`, a few at a time (the day's cap is in the probe), at :50 every hour. */
@Injectable()
export class SkillProbeWorker {
  private readonly logger = new Logger('SkillProbe');

  constructor(@Inject(SKILL_PROBE) private readonly probe: SkillProbe) {}

  @Cron('50 * * * *', { name: 'agents-skill-probe' })
  async tick(): Promise<void> {
    try {
      const r = await this.probe.run();
      if (r.adopted || r.rejected || r.inconclusive || r.unprobed) {
        this.logger.log(`skill probes: adopted ${r.adopted}, rejected ${r.rejected}, inconclusive ${r.inconclusive}, unprobed ${r.unprobed}, deferred ${r.deferred}`);
      }
    } catch (err: any) {
      this.logger.warn(`skill probe failed: ${err?.message ?? err}`);
    }
  }
}

/** Spec 055: the weekly audit of the sysadmin — a tick a minute; the ISO-week claim makes a restart or a second instance harmless. */
@Injectable()
export class AuditWorker {
  private readonly logger = new Logger('Audit');
  private readonly job: AuditTick;

  constructor(
    @Inject(AUDIT_SERVICE) svc: AuditService,
    @Inject(AGENT_INFRA) infra: AgentInfra,
    config: ConfigService,
  ) {
    this.job = new AuditTick({ svc, inbox: infra.inbox, env: (k) => config.get<string>(k) ?? undefined, log: (m) => this.logger.warn(m) });
  }

  @Cron('* * * * *', { name: 'audit-tick' })
  async tick(): Promise<void> {
    try { await this.job.tick(); } catch (err: any) { this.logger.warn(`audit tick failed: ${err?.message ?? err}`); }
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
    @Inject(LOADOUT_SCAN) private readonly loadoutScan: LoadoutScan,
  ) {}

  /** Spec 054 FR-005: once a week (Monday), the owner's inbox hears about agents whose tool set could change. */
  @Cron('30 9 * * 1', { name: 'loadout-suggestions' })
  async loadoutSuggestions(): Promise<void> {
    try {
      if (await postWeeklyLoadoutNote({ scan: this.loadoutScan, inbox: this.infra.inbox })) this.logger.log('loadout suggestions: weekly note posted');
    } catch (err: any) {
      this.logger.warn(`loadout suggestions failed: ${err?.message ?? err}`);
    }
  }

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
      // Spec 040 FR-012: profiles written before the tone attach (or by the builder) get their tone skill too.
      const tones = await attachProfileTones(this.infra);
      if (tones.length) this.logger.log(`tone skills attached from profiles: ${tones.join(', ')}`);
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
  // Spec 040 FR-013: the chat's slot_regenerate / replan_today cards run the editor ops.
  registerSlotRunActions(a, ops);
  a.register('create_agent', async (p) => {
    const r = await infra.creator.create(p);
    if ('error' in r) throw new Error(`${r.error}${r.details ? `: ${typeof r.details === 'string' ? r.details : JSON.stringify(r.details)}` : ''}`);
    return { handle: r.agent.handle, id: r.agent.id, cardCreated: r.cardCreated, briefWritten: r.briefWritten, buildStarted: r.buildStarted };
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
  // Spec 049 FR-004: a source change the channel agent proposed (the card as it is now, validated by the editor ops).
  a.register(SOURCE_CHANGE_KIND, (p) => applySourceChangeAction(p, {
    channels: { get: async (k) => (await ops.getChannel(k)) as EditorCard | null },
    upsert: (k, patch) => ops.upsertChannel(k, patch),
  }));
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
      // Spec 038: OpenRouter (default) or Anthropic directly; each workspace keeps its own default / critic / agent models.
      provide: MODEL_WORKSPACE,
      inject: [DB_POOL],
      useFactory: (pool: Pool) => {
        const logger = new Logger('Models');
        return new WorkspaceStore(pool, { onError: (m) => logger.warn(m) });
      },
    },
    {
      provide: MODEL_DEFAULTS,
      inject: [DB_POOL, MODEL_WORKSPACE],
      useFactory: (pool: Pool, workspace: WorkspaceStore) => {
        const logger = new Logger('Models');
        return new WorkspaceModelStore(pool, 'default', { onError: (m) => logger.warn(m) }, workspace);
      },
    },
    {
      provide: CRITIC_MODEL,
      inject: [DB_POOL, MODEL_WORKSPACE],
      useFactory: (pool: Pool, workspace: WorkspaceStore) => {
        const logger = new Logger('Models');
        return new WorkspaceModelStore(pool, 'critic', { onError: (m) => logger.warn(m) }, workspace);
      },
    },
    {
      // Spec 034 FR-004: the pre-publish critic (role `checker`, ledger feature `editor.checker`). EDITOR_CRITIC=off disables it.
      provide: EDITOR_CRITIC,
      inject: [ConfigService, EDITOR_LOOP, MODEL_DEFAULTS, CRITIC_MODEL],
      useFactory: (cfg: ConfigService, loop: AgentLoop, models: WorkspaceModelStore, critic: WorkspaceModelStore): CriticService | null => {
        if ((cfg.get<string>('EDITOR_CRITIC') ?? '').trim().toLowerCase() === 'off') {
          new Logger('Editor').warn('EDITOR_CRITIC=off: posts are published without the pre-publish critic');
          return null;
        }
        return new CriticService({ loop, env: (k) => cfg.get<string>(k) ?? undefined, defaultModel: (ws) => models.get(ws), workspace: () => models.workspace(), criticModel: (ws) => critic.get(ws) });
      },
    },
    {
      // Spec 035: the Models page (catalog from OpenRouter's public list, cached 24 h; offline fallback from llm_prices).
      provide: MODELS_SERVICE,
      inject: [DB_POOL, ConfigService, AGENT_INFRA, MODEL_DEFAULTS, CRITIC_MODEL, MODEL_WORKSPACE, { token: PriceService, optional: true }],
      useFactory: (pool: Pool, cfg: ConfigService, infra: AgentInfra, defaults: WorkspaceModelStore, critic: WorkspaceModelStore, workspace: WorkspaceStore, prices?: PriceService) => {
        const logger = new Logger('Models');
        const env = (k: string) => cfg.get<string>(k) ?? undefined;
        const catalog = new ModelCatalog({
          fetch: (url, init) => fetch(url, init),
          fallback: async () => fallbackCatalog(await new LlmPricesRepository(pool).list()),
          log: (m) => logger.warn(m),
        });
        // Spec 038: the Anthropic catalog — the live /v1/models list with the server's key (read at boot, never returned), else the price list.
        const anthropic = anthropicCatalog({ apiKey: anthropicApiKey(env), fetch: (url, init) => fetch(url, init), baseUrl: env('ANTHROPIC_BASE_URL'), log: (m) => logger.warn(m) });
        return new ModelsService({
          pool, agents: infra.agents, catalog, anthropicCatalog: anthropic, defaults, critic, workspace, anthropicKey: () => !!anthropicApiKey(env),
          prices, env, log: (m) => logger.log(m),
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
        const loadoutRepo = new LoadoutRepository(pool);
        const loadoutUsage = new LoadoutUsage(pool);
        const groups = new NetworkRepository(pool);
        // Spec 054 FR-003: a new agent starts with its role's core tools, what its resource needs and what its peers use.
        const loadoutCreation = new LoadoutCreation({
          repo: loadoutRepo, usage: loadoutUsage, registry: () => LOADOUT_REGISTRY.reg ?? null, log: (m) => logger.log(m),
          platforms: resourcePlatforms(async (key) => {
            const g = await groups.groupOfChannel(key);
            return g ? (await groups.groupResources(g.id)).map((r) => r.platform) : [];
          }),
        });
        const registry = new AgentRegistrySync({ agents, channels: repos.channels, log: (m) => logger.log(m), loadout: loadoutCreation });
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
          creator: new AgentCreator({ agents, registry, catalog, profiles, channels: repos.channels, loadout: loadoutCreation }),
          loadout: new LoadoutService({ repo: loadoutRepo, log: (m) => logger.warn(m) }),
          loadoutRepo, loadoutUsage,
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
          pauses: new PlannerPauseView(new SeriesPausesRepository(pool)),   // spec 060: paused series + last skip reasons for the planners
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
          // Spec 036: open digest sponsors of the retired digest bindings are reported to the owner.
          sponsors: new SponsorFulfilment({
            orders: new SponsorOrdersRepository(pool), card: (k) => repos.channels.get(k), reserve: (i) => repos.plans.reserveSlot(i),
            inbox: infra.inbox, log: (m) => new Logger('StrategyMigration').warn(m),
          }),
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
      inject: [DB_POOL, EDITOR_REPOS, EDITOR_PUBLISH, ChannelConfigService, TelegramNotifier, PostingThrottleService, SCHEDULE_INFRA, EDITOR_CRITIC],
      useFactory: (
        pool: Pool, repos: EditorRepos, ports: PublishPorts, channelConfig: ChannelConfigService,
        notifier: TelegramNotifier, throttle: PostingThrottleService, schedule: ScheduleService, critic: CriticService | null,
      ): DraftsService => {
        const logger = new Logger('EditorDrafts');
        return new DraftsService({
          pool, repo: repos.chat, channels: repos.channels, plans: repos.plans, ...ports,
          recordPublish: (k) => throttle.recordPublish(k),
          isPaused: (k) => channelConfig.isPublishPausedFor(k),
          notify: (t) => notifier.notifyAlert(t),
          reservedWarnings: (k, at) => schedule.reservedWarnings(k, at),
          ...(critic ? { critic } : {}),
          log: (m) => logger.warn(m),
        });
      },
    },
    {
      // One registry for the runner, the chat and the ops surface (REST tools endpoint → MCP).
      provide: EDITOR_REGISTRY,
      inject: [DB_POOL, ConfigService, EDITOR_REPOS, EDITOR_SKILLS, EDITOR_PUBLISH, EDITOR_DRAFTS, TelegramNotifier, PostingThrottleService, AGENT_INFRA, PLATFORM_INFRA, SCHEDULE_INFRA, STRATEGY_MIGRATION, ChannelConfigService, STEERING_SERVICE, { token: LlmBudgetService, optional: true }],
      useFactory: (
        pool: Pool, cfg: ConfigService, repos: EditorRepos, skills: SkillLibrary, ports: PublishPorts, drafts: DraftsService,
        notifier: TelegramNotifier, throttle: PostingThrottleService, infra: AgentInfra, platform: PlatformInfra, schedule: ScheduleService,
        migration: StrategyMigrationInfra, channelConfig: ChannelConfigService, steering: SteeringService, caps?: LlmBudgetService,
      ): ToolRegistry => {
        const env = (k: string) => cfg.get<string>(k) ?? undefined;
        // Spec 037 T2: the story registry (publish guard, prompts, fetch_feed, story reposts).
        const stories = new StoryRegistry(pool);
        // Spec 025: executor dry-run for file_directive; directive_lock on the orchestrator's playbook writes.
        const directives = directiveExecution(pool, repos, infra, platform);
        const directiveLock = (orchId: string, body: Playbook) => directives.lockFor(orchId, body);
        // Spec 040 FR-006: hosts that refused or failed a fetch are not asked again for 24 h.
        const hosts = new PgHostFailures(pool);
        return new ToolRegistry([
          ...buildReadTools({ pool, readonly: new ReadonlyQueryService(pool), skills, stories: new StoryContextService(stories), hosts }),
          ...buildDataTools({ pool, actions: infra.actions, env }),
          ...buildHighlightsTools({ pool }),
          ...buildComposeTools({ hosts, drafts }),
          ...buildApiTools({ env }),
          // Spec 049 FR-003 / FR-004: the card's source health and owner cards for a source change.
          ...buildSourceTools({
            health: sourceHealthOf(pool, repos.channels), channels: repos.channels, actions: infra.actions,
            candidate: candidateDeps(pool, env, hosts), handled: sourceChangeHandled(pool),
          }),
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
            stories, kpiSampleFilter: `${STORY_KPI_SAMPLE_FILTER} AND ${EVERGREEN_KPI_SAMPLE_FILTER}`,
          }),
          ...buildStoryTools({
            pool, plans: repos.plans, stories, limits: storyRepostLimits(env),
            forward: async (to, from, messageId) => (await botCall(channelConfig, to, 'forwardMessage', { from_chat_id: from, message_id: messageId })).message_id,
          }),
          ...buildComposerTools({ drafts, repo: repos.chat }),
          // Spec 059: an edit of a live skill is probed on recent posts before it is adopted (SKILL_PROBE_PER_DAY = 0: at once).
          ...buildAgentSkillTools({
            agents: infra.agents, skills: infra.skills, kpi: infra.kpi, inbox: infra.inbox,
            probe: { enabled: () => probeSettings(env).perDay > 0 && probeSettings(env).budgetUsd > 0, samples: () => probeSettings(env).samples },
          }),
          ...buildBuilderTools({
            agents: infra.agents, catalog: infra.catalog, profiles: infra.profiles, creator: infra.creator, skills: infra.skills, actions: infra.actions,
            conflicts: configConflictsOf(pool, repos, infra),
          }),
          // Spec 042 FR-007: @ai0 queues a channel's setup from its history (the owner reviews the proposal as an artifact, spec 048).
          buildAnalyzeHistoryTool({ pool, repo: new ChannelSetupRepository(pool) }),
          // Spec 045 FR-009: @ai0 queues a steering analysis (the owner activates the rules as an artifact, spec 048).
          buildSteerChannelTool({ steering }),
          // Spec 052 FR-001: @ai0 launches a new channel (the owner starts it from the launch artifact).
          buildLaunchChannelTool({ launches: { createLaunch: (b, by) => (LAUNCH.svc ? LAUNCH.svc.createLaunch(b, by) : Promise.resolve({ ok: false, error: 'invalid_body', details: 'launches are not ready yet' } as const)) } }),
          // Spec 055 FR-002: the sysadmin's audit pass (submit_audit, inspect_channel_memory / _card).
          ...buildAuditorTools({ memory: repos.memory, card: (k) => repos.channels.get(k) }),
          // Spec 048 FR-002: read and change the artifacts that shape an agent (live ones through an Apply / Discard card).
          ...buildArtifactTools({ artifacts: () => ARTIFACTS.svc, actions: infra.actions }),
          // Spec 034 FR-008: example posts and warnings in the agent-creation chat (a content_examples card).
          buildContentExamplesTool({
            agents: infra.agents, actions: infra.actions,
            cardOf: async (ref) => { const id = parseResourceRef(ref)?.id; return id ? repos.channels.get(id) : null; },
          }),
          ...buildAgentChatTools({
            pool, memory: repos.memory, skills: infra.skills, actions: infra.actions, conflicts: configConflictsOf(pool, repos, infra),
            handles: async () => (await infra.agents.list()).map((a) => a.handle),
          }),
          // Spec 023 FR-006: the owner steers the schedule from the chat (cards only).
          ...buildScheduleTools({ schedule, actions: infra.actions }),
          // Spec 023 FR-011: @ai0 previews a strategy migration and proposes its cards.
          ...buildMigrationTools({ svc: migration.svc, actions: infra.actions }),
          ...buildNetworkTools({
            repo: new NetworkRepository(pool), plans: repos.plans, memory: repos.memory, inbox: infra.inbox,
            sourceCatalog: (card) => seriesSourceCatalog(pool, card), schedule, directiveLock,
            experimentQuotas: experimentQuotasOf(pool),
            pollCaps: pollCapsOf(pool), agents: new AgentsRepository(pool),
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
            // Spec 058: a pair the owner broke on the map is not proposed again.
            pairBlocked: (a, b) => isPairBlocked(pool, a, b),
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
          // Spec 037 T2: an approved follow-up replies to its original; a forward is recorded as a repost.
          replyTarget: (slot) => new StoryRegistry(pool).replyTargetOf(slot.id),
          onForwarded: async (slot, fromKey, fromMessageId, messageId) => { await new StoryRegistry(pool).recordForward({ channelKey: slot.channelKey, slotId: slot.id, fromKey, fromMessageId, messageId }); },
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
      inject: [EDITOR_REPOS, EDITOR_PUBLISH, APPROVAL_INFRA, PLATFORM_INFRA, DB_POOL],
      useFactory: (repos: EditorRepos, ports: PublishPorts, approval: ApprovalInfra, platform: PlatformInfra, pool: Pool) => new ApprovalsService({
        repo: approval.repo, card: (k) => repos.channels.get(k), media: ports.media, hostSlides: platform.publish.hostSlides,
        styleOf: async (ref) => (await resourceStyleOf(pool, ref)).effective,
        // Spec 037 FR-014: every integrity finding of a waiting post, with the rule explanation, on the card.
        findings: approvalFindingsHook({ pool, cardOf: editorCardAudit((k) => repos.channels.get(k)) }),
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
          llm: new RoutingLlmClient({
            openrouter: new OpenRouterClient({ apiKey: env('OPENROUTER_API_KEY'), baseUrl: env('OPENROUTER_BASE_URL'), prices }),
            anthropic:  new AnthropicClient({ apiKey: anthropicApiKey(env), baseUrl: env('ANTHROPIC_BASE_URL'), prices, toolsCacheTtl: env('EDITOR_ANTHROPIC_TOOLS_CACHE_TTL') === '1h' ? '1h' : null }),
          }),
          recorder: new PgRunRecorder(pool, (m) => logger.warn(m)),
          budget: editorBudget(pool, env, (text) => notifier.notifyAlert(text), caps),
          enabled: () => isEnabled(cfg),
        });
      },
    },
    {
      provide: EDITOR_MANAGER,
      inject: [DB_POOL, ConfigService, EDITOR_LOOP, EDITOR_REGISTRY, AGENT_INFRA, EDITOR_REPOS, PLATFORM_INFRA, MODEL_DEFAULTS, { token: LlmBudgetService, optional: true }, LOADOUT_SCAN],
      useFactory: (
        pool: Pool, cfg: ConfigService, loop: AgentLoop, registry: ToolRegistry, infra: AgentInfra, repos: EditorRepos, platform: PlatformInfra,
        models: WorkspaceModelStore, caps: LlmBudgetService | undefined, loadoutScan: LoadoutScan,
      ): ManagerInfra => {
        const env = (k: string) => cfg.get<string>(k) ?? undefined;
        const repo = new DirectivesRepository(pool);
        const digest = new KpiDigestService({
          pool, catalog: infra.catalog, globalCapUsd: capDefaults(env).agentsDailyUsd, capUsd: agentsCapUsd(env, caps),
          conflicts: networkConflicts(infra, configConflictsOf(pool, repos, infra)),
          loadout: () => loadoutScan.digestLines(),
        });
        const buildPort = new PlaybookBuildPort();
        const runner = new ManagerRunner({
          loop, registry, runtime: infra.runtime, loadout: infra.loadout, agents: infra.agents, repo, digest, inbox: infra.inbox, env, defaultModel: (ws) => models.get(ws), workspace: () => models.workspace(),
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
        notifier: TelegramNotifier, manager: ManagerInfra, promo: PromoInfra, schedule: ScheduleService, models: WorkspaceModelStore,
      ): NetworkRunner => {
        const runner = new NetworkRunner({
          loop, registry, runtime: infra.runtime, loadout: infra.loadout, memory: repos.memory, repo: new NetworkRepository(pool), plans: repos.plans, profiles: infra.profiles,
          usable: (ref) => platform.health.usable(ref), time: resourceTime(repos, infra.profiles),
          steering: (ref) => new SteeringRepository(pool).promptRules(ref),
          commitments: (orchId) => manager.runner.commitments(orchId),
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
          defaultModel: (ws) => models.get(ws), workspace: () => models.workspace(),
          notify: (t) => notifier.notifyAlert(t),
          // Spec 023 FR-008: source catalog in the orchestrator/planner prompts; low_runway after the daily run.
          catalogSummary: withSchedule(catalogSummaryOf(pool, (k) => cfg.get<string>(k) ?? undefined), schedule),
          runwayCheck: (orch, playbook) => checkLowRunway({ pool, inbox: infra.inbox }, orch, playbook),
          // Spec 025 FR-014: experiment quotas in the planner prompts.
          experimentQuotas: experimentQuotasOf(pool),
          // Spec 037 T2: the active stories in the planner prompt.
          stories: new StoryContextService(new StoryRegistry(pool)),
          // Spec 053 FR-005: the last 7 days in the orchestrator prompt.
          statsSummary: (refs) => statsSummaryOf(pool, refs),
          // Spec 049 FR-004: failing sources (asked about at most weekly) in the daily run; SOURCE_PROPOSALS=off turns it off.
          sourcesToReplace: cfg.get<string>('SOURCE_PROPOSALS') === 'off'
            ? undefined
            : async (card, orchId) => sourcesToReplaceBlock(await sourceHealthOf(pool, repos.channels, infra.inbox).toReplaceToday(card, orchId)),
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
      inject: [DB_POOL, ConfigService, EDITOR_REPOS, EDITOR_SKILLS, EDITOR_REGISTRY, TelegramNotifier, AGENT_INFRA, EDITOR_LOOP, EDITOR_NETWORK, SCHEDULE_INFRA, EDITOR_PUBLISH, MODEL_DEFAULTS, EDITOR_CRITIC, { token: LlmBudgetService, optional: true }],
      useFactory: (
        pool: Pool, cfg: ConfigService, repos: EditorRepos, skills: SkillLibrary, registry: ToolRegistry, notifier: TelegramNotifier,
        infra: AgentInfra, loop: AgentLoop, network: NetworkRunner, schedule: ScheduleService, ports: PublishPorts, models: WorkspaceModelStore,
        critic: CriticService | null, caps?: LlmBudgetService,
      ): EditorRunnerService => {
        const logger = new Logger('Editor');
        const env = (k: string) => cfg.get<string>(k) ?? undefined;
        const notify = (text: string) => notifier.notifyAlert(text);
        const ideas = new NetworkRepository(pool);
        logger.log(`editor ${isEnabled(cfg) ? 'ENABLED' : 'disabled'}: ${registry.all().length} tools, ${skills.list().length} skills`);
        return new EditorRunnerService({
          loop, registry, skills, runtime: infra.runtime, loadout: infra.loadout, plans: repos.plans, memory: repos.memory, env, notify, defaultModel: (ws) => models.get(ws), workspace: () => models.workspace(),
          // Spec 045 FR-005: the channel's active steering rules (lowest priority) for the writer, planner and critic.
          steering: (ref) => new SteeringRepository(pool).promptRules(ref),
          // Spec 046 FR-003: what the orchestrator accepted from the manager reaches the single-channel planner too.
          commitments: async (orchId) => commitmentsText(await new DirectivesRepository(pool).inForce(orchId)),
          network, platformContext: (slot, orchId) => network.platformContext(slot, orchId),
          catalogSummary: withSchedule(catalogSummaryOf(pool, env), schedule),
          seriesContext: (slot) => schedule.executorContext(slot),
          onSlotDone: async (slot) => { if (slot.ideaId) await ideas.settleIdea(slot.ideaId); },
          deadSource: async (slot, url, reason) => (slot.ideaId ? ideas.rejectSoleSourceIdeas(slot.ideaId, url, reason) : 0),
          // Spec 061 FR-001: ledger / freshness / host block / format checks (and one idea swap) before the writer is paid.
          preflight: buildSlotPreflight({ pool, env, ideas, plans: repos.plans, log: (m) => logger.warn(m) }),
          // Spec 024 FR-007: duplicate / adapt slots — the agent formats every target post itself.
          derived: derivedPorts(pool, ideas, infra, ports.holds ?? null),
          // Spec 034 FR-002: humour / slang / emoji of a slot's target resource (owner-only switches, off by default).
          // Spec 034 FR-005: plus the reader-question cap the platform lint enforces.
          voiceOf: async (ref) => {
            const f = await infra.profiles.formatOf(ref);
            const caps = await infra.profiles.capsOf(ref);
            // Spec 037 FR-008: plus the resource style sheet (writer / critic prompts, platform lint address + glossary).
            const style = (await resourceStyleOf(pool, ref)).effective;
            return { humor: f.prefs.humor, slang: f.prefs.slang, emoji: f.prefs.emoji, readerQuestionsMax: caps.questionsPerDay, style };
          },
          // Spec 034 FR-010: a live slot's feeds are read by code first (fresh, unposted, not a repeat).
          live: {
            scan: async (slot, card) => slot.liveSpec
              ? scanLive({ pool }, { spec: slot.liveSpec, resourceRef: slot.resourceRef ?? `telegram:${slot.channelKey}`, card: card.sources, now: new Date(), excludeSlotId: slot.id })
              : null,
          },
          // Spec 034 FR-004: the pre-publish critic of every executor run (live, shadow, approval write-ahead).
          ...(critic ? { critic: { service: critic, inbox: (i) => infra.inbox.post(i), libraryText: libraryTextOf(pool) } } : {}),
          // Spec 037 FR-010: the fallback ladder of a failed post stops at the daily caps (the same gate as every LLM call).
          budget: (() => {
            const gate = editorBudget(pool, env, notify, caps);
            // Spec 046 FR-005: a step starts only when a whole executor + critic run fits under the caps.
            const headroomUsd = envNum(env, 'EDITOR_RUN_HEADROOM_USD', DEFAULT_RUN_HEADROOM_USD);
            return async (card, agent) => {
              // Spec 053 FR-007: the caps of the provider the run will use (a provider cap on anthropic counted, too).
              const provider = await Promise.resolve(models.workspace()).catch(() => 'openrouter' as const);
              const v = await gate.check(card.channelKey, card.dailyBudgetUsd, agent, provider, { headroomUsd });
              return v.ok ? { ok: true as const } : { ok: false as const, reason: `${v.scope} cap: $${v.spentUsd.toFixed(3)} / $${v.limitUsd}` };
            };
          })(),
          // Spec 053 FR-007: one extra step by default (EDITOR_LADDER_EXTRA_STEPS=3 restores the full ladder with the evergreen step).
          ladder: { enabled: env('EDITOR_FALLBACK_LADDER') !== 'off', maxExtraSteps: Math.max(0, Math.min(3, envNum(env, 'EDITOR_LADDER_EXTRA_STEPS', MAX_LADDER_EXTRA_STEPS))) },
          // Spec 037 FR-009: the writer's «Уже було» block reads the channel's last 20 written posts.
          recentPosts: (card, slot) => recentAuditPosts(pool, { channelKey: card.channelKey, timezone: card.timezone, excludeSlotId: slot.id, card }),
          // Spec 037 T2: the active stories in the planner and writer prompts.
          stories: new StoryContextService(new StoryRegistry(pool)),
          // Spec 037 T10: the evergreen step of the ladder (≤ EDITOR_EVERGREEN_PER_DAY per channel per day, default 1; 0 = off).
          fallbackEvergreen: (() => {
            const step = new EvergreenStep({ pool, plans: repos.plans, perDay: evergreenPerDay(env), inbox: infra.inbox, log: (m) => logger.warn(m) });
            return (req) => step.run(req);
          })(),
        });
      },
    },
    {
      // Spec 037 FR-014: the post audit (Network health notes) and the on-demand run.
      provide: POST_AUDIT,
      inject: [DB_POOL, EDITOR_REPOS],
      useFactory: (pool: Pool, repos: EditorRepos) => new PostAuditApi(new PostAuditService({
        pool, cardOf: editorCardAudit((k) => repos.channels.get(k)), log: (m) => new Logger('PostAudit').warn(m),
      })),
    },
    {
      // Spec 025 FR-013: resource pauses (one service with the Inbox; the guards above build read-only ones).
      provide: RESOURCE_PAUSES,
      inject: [DB_POOL, AGENT_INFRA],
      useFactory: (pool: Pool, infra: AgentInfra) => new ResourcePausesApi(new ResourcePauseService({ pool, inbox: infra.inbox })),
    },
    {
      provide: EDITOR_SCHEDULER,
      inject: [DB_POOL, ConfigService, EDITOR_REPOS, EDITOR_RUNNER, EDITOR_PUBLISH, EDITOR_DRAFTS, TelegramNotifier, PostingThrottleService, EDITOR_NETWORK, EDITOR_MANAGER, AGENT_INFRA, ChannelConfigService, APPROVAL_INFRA, SCHEDULE_INFRA, PLATFORM_INFRA],
      useFactory: (
        pool: Pool, cfg: ConfigService, repos: EditorRepos, runner: EditorRunnerService, ports: PublishPorts, drafts: DraftsService,
        notifier: TelegramNotifier, throttle: PostingThrottleService, network: NetworkRunner, manager: ManagerInfra, infra: AgentInfra,
        channelConfig: ChannelConfigService, approval: ApprovalInfra, schedule: ScheduleService, platform: PlatformInfra,
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
          // Spec 037 T2: every native forward is a published_posts row marked repost (counted apart, out of the KPI samples).
          onForwarded: async (slot, fromKey, fromMessageId, messageId) => { await new StoryRegistry(pool).recordForward({ channelKey: slot.channelKey, slotId: slot.id, fromKey, fromMessageId, messageId }); },
          log: (m) => logger.warn(m),
        });
        // Spec 036: paid digest sponsors on channels where no digest strategy runs go out as reserved sponsored posts.
        const sponsors = new SponsorFulfilment({
          orders: new SponsorOrdersRepository(pool), card: (k) => repos.channels.get(k), reserve: (i) => repos.plans.reserveSlot(i),
          inbox: infra.inbox, log: (m) => logger.warn(m),
        });
        const dispatcher = new ReservedDispatcher({
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
        const reserved = {
          publishDue: async (now: Date) => {
            try {
              const r = await sponsors.reserveDue(now);
              if (r.placed || r.flagged) logger.log(`digest sponsors: ${r.placed} placed, ${r.flagged} flagged`);
            } catch (err: any) {
              logger.warn(`digest sponsor fulfilment failed: ${err?.message ?? err}`);
            }
            return dispatcher.publishDue(now);
          },
        };
        // Spec 034 FR-011: news resources check their feeds on a cadence and add live slots for fresh items (no LLM).
        const newsWatch = new NewsWatchService({
          pool, profile: async (ref) => (await infra.profiles.get(ref))?.profile ?? null, log: (m) => logger.warn(m),
        });
        // Spec 037 FR-010: silent-day notes (dark_day, series_missed, critic_reject_streak), once per resource per day.
        const silent = new SilentDaysWatch({
          pool, inbox: infra.inbox, log: (m) => logger.warn(m),
          streakN: Math.max(1, Math.round(envNum((k) => cfg.get<string>(k) ?? undefined, 'EDITOR_CRITIC_REJECT_STREAK', DEFAULT_REJECT_STREAK))),
        });
        // Spec 060 FR-001: the dead-series breaker (SERIES_SKIP_STREAK, 0 = off; read at each check) — code only.
        const seriesPausesRepo = new SeriesPausesRepository(pool);
        const breaker = new SeriesBreaker({
          repo: seriesPausesRepo, inbox: infra.inbox, log: (m) => logger.warn(m),
          threshold: () => Math.max(0, Math.round(envNum((k) => cfg.get<string>(k) ?? undefined, 'SERIES_SKIP_STREAK', DEFAULT_SERIES_SKIP_STREAK))),
        });
        // Spec 037 FR-014: the daily post audit (and at once after a rule change), code only.
        const audit = new PostAuditService({ pool, cardOf: editorCardAudit((k) => repos.channels.get(k)), log: (m) => logger.warn(m) });
        // Spec 037 FR-003 (T3): an announced event with no post within 24 h after it — one Inbox note per event.
        const eventRecaps = new EventRecapWatch({ pool, inbox: infra.inbox, log: (m) => logger.warn(m) });
        return new EditorScheduler({
          pool, channels: repos.channels, plans: repos.plans, runner, reserved,
          // Spec 049 FR-002: a slot on a resource that cannot publish (broken connection) is skipped with the reason.
          unavailable: (ref) => platform.health.blocked(ref),
          postAudit: (now) => audit.tick(now),
          newsWatch: (card, now) => newsWatch.check(card, now),
          silentDays: (cards, now, paused) => silent.check(cards, now, paused),
          seriesPauses: { check: (now) => breaker.check(now), plainPaused: () => seriesPausesRepo.plainPausedChannels() },
          eventRecaps: (now) => eventRecaps.check(now),
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
              if (card && card.mode !== 'off' && !(await held(card, await pauses.pausedRefs(new Date())))) await network.runOrchestrator(card, { wake: true });
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
      inject: [
        DB_POOL, ConfigService, EDITOR_REPOS, EDITOR_SKILLS, EDITOR_REGISTRY, EDITOR_DRAFTS, TelegramNotifier, AGENT_INFRA, EDITOR_MANAGER, MODEL_DEFAULTS,
        CHANNEL_SETUP_SERVICE, STEERING_SERVICE, ARTIFACTS_SERVICE, { token: PriceService, optional: true }, { token: LlmBudgetService, optional: true },
      ],
      useFactory: (
        pool: Pool, cfg: ConfigService, repos: EditorRepos, skills: SkillLibrary, registry: ToolRegistry, drafts: DraftsService,
        notifier: TelegramNotifier, infra: AgentInfra, manager: ManagerInfra, models: WorkspaceModelStore,
        setup: ChannelSetupService, steering: SteeringService, artifacts: ArtifactsService, prices?: PriceService, caps?: LlmBudgetService,
      ): EditorChatService => {
        const logger = new Logger('EditorChat');
        const env = (k: string) => cfg.get<string>(k) ?? undefined;
        const enabled = () => !!env('OPENROUTER_API_KEY');
        const loop = new AgentLoop({
          llm: new RoutingLlmClient({
            openrouter: new OpenRouterClient({ apiKey: env('OPENROUTER_API_KEY'), baseUrl: env('OPENROUTER_BASE_URL'), prices }),
            anthropic:  new AnthropicClient({ apiKey: anthropicApiKey(env), baseUrl: env('ANTHROPIC_BASE_URL'), prices, toolsCacheTtl: env('EDITOR_ANTHROPIC_TOOLS_CACHE_TTL') === '1h' ? '1h' : null }),
          }),
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
        // Spec 048 FR-003: slash commands start the same work as the setup and steering pages, as the owner.
        const slash: SlashDeps = {
          setup: async (key) => {
            const r = await setup.analyze({ channelKeys: [key] }, 'owner');
            const p = r.queued[0];
            return p ? { ok: true, chip: { type: 'setup', id: p.id, title: `Setup from history · ${key}`, status: p.status } } : { ok: false, error: r.refused[0]?.error ?? 'not_queued' };
          },
          steer: async (key, reference) => {
            const r = await steering.createSet({ target: key, source: reference }, 'owner');
            if (!r.ok) return { ok: false, error: r.error, details: typeof r.details === 'string' ? r.details : undefined };
            return { ok: true, chip: { type: 'steering', id: r.set.id, title: `Steering from ${r.set.sourceTitle ?? refName(r.set.sourceRef)}`, status: r.set.status } };
          },
          launch: async (q) => {
            if (!LAUNCH.svc) return { ok: false, error: 'not_ready', details: 'launches are not ready yet — try again in a minute' };
            const r = await LAUNCH.svc.createLaunch(q, 'owner');
            const chipOf = (l: { id: string; channelKey: string; status: string }) => ({ type: 'launch' as const, id: l.id, title: launchTitle(l), status: l.status });
            if (!r.ok) return { ok: false, error: r.error, details: r.details, ...(r.launch ? { chip: chipOf(r.launch) } : {}) };
            return { ok: true, chip: chipOf(r.launch) };
          },
          // Spec 055 FR-003: /audit starts an audit in the background; the chip is the running report.
          audit: async () => {
            if (!AUDIT.svc) return { ok: false, error: 'not_ready', details: 'the audit is not ready yet — try again in a minute' };
            const r = await AUDIT.svc.runInBackground('owner');
            const chipOf = (x: { id: string; week: string; trigger: 'schedule' | 'owner'; status: string }) => ({ type: 'audit' as const, id: x.id, title: auditTitle(x), status: x.status });
            if (r.ok) return { ok: true, chip: chipOf(r.report) };
            const running = r.error === 'already_running' ? await AUDIT.svc.running() : null;
            return { ok: false, error: r.error, details: r.error === 'already_running' ? 'an audit is already running' : r.error === 'week_taken' ? 'this week\'s audit already ran' : r.details, ...(running ? { chip: chipOf(running) } : {}) };
          },
          // Spec 062 FR-008: /align is the fix_config_conflicts card without a model turn.
          align: (target, chatId) => alignAgent({
            agents: infra.agents, channelKeyOf: (a) => infra.channelKeyOf(a), conflicts: configConflictsOf(pool, repos, infra), actions: infra.actions,
          }, target, chatId),
          list: async (q) => (await artifacts.list({ ...q, limit: 50 })).rows,
        };
        return new EditorChatService({
          repo: repos.chat, drafts, memory: repos.memory, loop, registry, loadout: infra.loadout, skills, env, enabled, agents: agentsPort, defaultModel: (ws) => models.get(ws), workspace: () => models.workspace(),
          slash,
          artifactChip: async (type, id) => {
            const a = await artifacts.find(type, id);
            return a ? { type, id, title: a.row.title, status: a.row.status } : null;
          },
        });
      },
    },
    {
      provide: EDITOR_OPS,
      inject: [ConfigService, EDITOR_REPOS, EDITOR_RUNNER, EDITOR_REGISTRY, EDITOR_SKILLS, DB_POOL],
      useFactory: (cfg: ConfigService, repos: EditorRepos, runner: EditorRunnerService, registry: ToolRegistry, skills: SkillLibrary, pool: Pool) => {
        const logger = new Logger('EditorOps');
        return new EditorOpsService({
          channels: repos.channels, plans: repos.plans, memory: repos.memory, runs: repos.runs,
          runner, registry, skills,
          enabled: () => isEnabled(cfg),
          log: (m) => logger.warn(m),
          styleProposal: (ref) => proposeStyle(pool, ref),
        });
      },
    },
    {
      // Spec 054: the owner surface of an agent's loadout; it also hands the tool registry to the creation of new agents.
      provide: LOADOUT_SERVICE,
      inject: [DB_POOL, EDITOR_REGISTRY, AGENT_INFRA],
      useFactory: (pool: Pool, registry: ToolRegistry, infra: AgentInfra): LoadoutAdminService => {
        LOADOUT_REGISTRY.reg = registry;
        return new LoadoutAdminService({
          agents: infra.agents, repo: infra.loadoutRepo, usage: infra.loadoutUsage, registry, skills: infra.skills,
          rules: async (agent, orch) => rulesSummary(pool, rulesTarget(orch, await infra.channelKeyOf(agent))),
        });
      },
    },
    {
      provide: LOADOUT_SCAN,
      inject: [LOADOUT_SERVICE, AGENT_INFRA],
      useFactory: (admin: LoadoutAdminService, infra: AgentInfra): LoadoutScan => new LoadoutScan({ agents: infra.agents, admin }),
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
          channelMode: async (key) => (await repos.channels.get(key))?.mode ?? null,
          memory: (key) => repos.memory.listActive(key, 100),
          conflicts: (orch) => configConflictsOf(pool, repos, infra).forAgent(orch),
          resolver: (orch) => configConflictsOf(pool, repos, infra).resolverFor(orch),
          ruleLint: (text, orch) => ownerRuleLint(infra, text, orch),
          sourceHealth: (key) => sourceHealthOf(pool, repos.channels).forChannel(key),
          sync: () => infra.registry.run(),
          // Spec 035: agent models are checked against the catalog and priced in llm_prices when new.
          models: { check: (m, cur) => models.checkAgentModel(m, cur), chosen: (m) => models.ensurePrice(m), workspace: () => models.active() },
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
        // Spec 034 FR-008: the owner's verdicts and edits of @ai0's example posts → the playbook's examples.
        infra.actions.register(CONTENT_EXAMPLES_KIND, async (p, _action, input) => {
          const payload = p as unknown as ContentExamplesPayload;
          const agent = await infra.agents.getByHandle(String(payload.handle));
          if (!agent) throw new KeepPendingError('agent_not_created', `@${payload.handle} does not exist yet — apply the "Create agent" card first, then these examples.`);
          const orch = agent.parentId ? (await infra.agents.get(agent.parentId)) ?? agent : agent;
          const examples = examplesFromChoice(payload, input);
          const r = await new NetworkRepository(pool).setExamples(orch.id, examples, 'Example posts and warnings approved in the chat with @ai0');
          return { ...r, saved: examples.length, handle: orch.handle };
        });
        // Spec 040 FR-011: the owner aligned a playbook and profiles with their rules (recomputed at Apply).
        infra.actions.register(FIX_CONFIG_CONFLICTS_KIND, async (p, _a, input) => {
          const orch = await infra.agents.getByHandle(String((p as Record<string, unknown>).handle ?? ''));
          if (!orch) throw new Error('unknown_agent: the agent no longer exists');
          // Spec 047 FR-005: the items the owner unticked stay out (input.skip); old 040 cards apply everything.
          const skip = Array.isArray((input as { skip?: unknown } | null)?.skip) ? ((input as { skip: unknown[] }).skip).map(String) : [];
          return configConflictsOf(pool, repos, infra).resolve(orch, skip);
        });
        // Spec 040 FR-010: an owner rule the owner confirmed with a card (its words did not match the chat closely enough).
        infra.actions.register(OWNER_RULE_KIND, (p) => applyOwnerRule(repos.memory, p as Record<string, unknown>));
        // Spec 048 FR-002: an agent's change to a live artifact, applied by the owner.
        infra.actions.register(UPDATE_ARTIFACT_KIND, (p) => applyUpdateArtifact(ARTIFACTS.svc, p as Record<string, unknown>));
        // A directive the owner approved in the chat with @manager (spec 021): filed as owner-approved, never shadow.
        infra.actions.register('file_directive', async (p) => {
          const input = FileDirectiveInput.parse(p);
          const r = await fileDirective({
            repo: manager.repo, agents: infra.agents, digest: manager.digest, inbox: infra.inbox, memory: repos.memory, actions: infra.actions,
            channelKeyOf: (a) => infra.channelKeyOf(a), exec: manager.runner.exec,
          }, input, { from: await manager.runner.manager(), runId: null, shadow: false, ownerApproved: true });
          if ('error' in r) throw new Error(`${r.error}: ${r.details ?? ''}`);
          if ('already_satisfied' in r) return { already_satisfied: true, details: r.details };
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
        // Spec 034 FR-009: create_agent with a brief starts the first playbook build (the creator is built before this service).
        infra.creator.setOnBrief((agent, brief) => svc.onBrief(agent, brief));
        return svc;
      },
    },
    {
      // Spec 048 FR-001: one registry over the artifacts that shape an agent (each type keeps its own table).
      provide: ARTIFACTS_SERVICE,
      inject: [DB_POOL, AGENT_INFRA, EDITOR_REPOS, AGENTS_SERVICE, NETWORK_SERVICE, STEERING_SERVICE],
      useFactory: (pool: Pool, infra: AgentInfra, repos: EditorRepos, agentsSvc: AgentsService, network: NetworkService, steering: SteeringService) => {
        const versions = new ArtifactVersionsRepository(pool);
        const networkRepo = new NetworkRepository(pool);
        const svc = new ArtifactsService({
          pool,
          adapters: [
            setupAdapter({ setup: new ChannelSetupRepository(pool), versions }),
            steeringAdapter({ repo: new SteeringRepository(pool), editRules: (id, body) => steering.editRules(id, body), versions }),
            rulesAdapter({
              pool, memory: repos.memory, versions,
              lint: async (text, key) => {
                const orch = await infra.agents.findTop('orchestrator', 'resource', `telegram:${key}`).catch(() => null);
                return orch ? ownerRuleLint(infra, text, orch) : lintOwnerRule(text);
              },
            }),
            memoryAdapter({ pool, memory: repos.memory }),
            skillAdapter({ pool, skills: infra.skills }),
            playbookAdapter({ pool, history: (agentId) => networkRepo.playbookHistory(agentId), put: (handle, body) => network.putPlaybook(handle, body) }),
            profileAdapter({ pool, raw: (ref) => infra.profiles.rawProfile(ref), put: (handle, _ref, body) => agentsSvc.putProfile(handle, body) }, 'profile'),
            profileAdapter({ pool, raw: (ref) => infra.profiles.rawProfile(ref), put: (handle, ref, body) => agentsSvc.putFormatting(handle, ref, body) }, 'formatting'),
            // Spec 052 FR-005: launches (their panel body is the live view with the checklist).
            launchAdapter({
              list: (f) => new LaunchRepository(pool).list(f), get: (id) => new LaunchRepository(pool).get(id),
              view: (l) => (LAUNCH.svc ? LAUNCH.svc.view(l) : Promise.resolve(launchJson(l))),
            }),
            // Spec 055 FR-003: the sysadmin's audit reports.
            auditAdapter({ list: (n) => new AuditRepository(pool).list(n), get: (id) => new AuditRepository(pool).get(id) }),
          ],
        });
        ARTIFACTS.svc = svc;
        return svc;
      },
    },
    {
      // Spec 055: the sysadmin's audit (checks in code, one model pass, a stored report, closed-list fixes).
      provide: AUDIT_SERVICE,
      inject: [
        DB_POOL, ConfigService, EDITOR_REGISTRY, AGENT_INFRA, EDITOR_REPOS, PLATFORM_INFRA, MODEL_DEFAULTS, AGENTS_SERVICE, TelegramNotifier,
        { token: PriceService, optional: true }, { token: LlmBudgetService, optional: true },
      ],
      useFactory: (
        pool: Pool, cfg: ConfigService, registry: ToolRegistry, infra: AgentInfra, repos: EditorRepos, platform: PlatformInfra,
        models: WorkspaceModelStore, agentsSvc: AgentsService, notifier: TelegramNotifier, prices?: PriceService, caps?: LlmBudgetService,
      ): AuditService => {
        const logger = new Logger('Audit');
        const env = (k: string) => cfg.get<string>(k) ?? undefined;
        // Like a chat turn: the audit publishes nothing, so it needs a model key, not EDITOR_ENABLED.
        const loop = ownerStartedLoop(pool, env, notifier, logger, prices, caps);
        const conflicts = configConflictsOf(pool, repos, infra);
        const networkRepo = new NetworkRepository(pool);
        const queries = new AuditQueries({
          pool, agents: infra.agents, skills: infra.skills, tools: () => new Set(registry.all().map((t) => t.name)),
          ruleLint: (text, orch) => (orch ? ownerRuleLint(infra, text, orch) : Promise.resolve(lintOwnerRule(text))),
          conflicts: (orch) => conflicts.forAgent(orch),
          playbook: playbookPort({
            repo: networkRepo, card: (k) => repos.channels.get(k), catalog: (card) => seriesSourceCatalog(pool, card),
            net: (orch, card) => networkContext({ repo: networkRepo, usable: (ref) => platform.health.usable(ref), time: resourceTime(repos, infra.profiles) }, orch, card),
          }),
        });
        const runner = new AuditorRunner({
          loop, registry, runtime: infra.runtime, agents: infra.agents, load: () => queries.load(), env,
          defaultModel: (ws) => models.get(ws), workspace: () => models.workspace(),
        });
        const svc = new AuditService({
          repo: new AuditRepository(pool), pass: () => runner.run(), log: (m) => logger.warn(m),
          fixes: {
            agentByHandle: (h) => infra.agents.getByHandle(h),
            patchSkill: (handle, name, patch) => agentsSvc.patchSkill(handle, name, patch),
            retireMemory: retireMemoryPort(repos.memory),
            applyConflicts: (orch) => conflicts.apply(orch),
          },
        });
        AUDIT.svc = svc;
        return svc;
      },
    },
    {
      // Spec 052: channel launch (brief + references → plan → checklist → Start into approval → graduation).
      provide: LAUNCH_SERVICE,
      inject: [
        DB_POOL, ConfigService, AGENT_INFRA, EDITOR_REPOS, EDITOR_OPS, STEERING_SERVICE, MODEL_DEFAULTS, TelegramNotifier, ChannelConfigService,
        AGENTS_SERVICE, NETWORK_SERVICE, EDITOR_RUNNER, AUTONOMY_SERVICE, APPROVAL_INFRA, PLATFORM_INFRA, EDITOR_MANAGER, PROMO_INFRA,
        { token: PriceService, optional: true }, { token: LlmBudgetService, optional: true },
        { token: TrackingService, optional: true }, { token: TrackedChannelsRepository, optional: true },
      ],
      useFactory: (
        pool: Pool, cfg: ConfigService, infra: AgentInfra, repos: EditorRepos, ops: EditorOpsService, steering: SteeringService,
        models: WorkspaceModelStore, notifier: TelegramNotifier, channelConfig: ChannelConfigService,
        agentsSvc: AgentsService, networkSvc: NetworkService, runner: EditorRunnerService,
        autonomy: AutonomyService, approval: ApprovalInfra, platform: PlatformInfra, manager: ManagerInfra, promoInfra: PromoInfra,
        prices?: PriceService, caps?: LlmBudgetService, tracking?: TrackingService, trackedRepo?: TrackedChannelsRepository,
      ): LaunchService => {
        const logger = new Logger('Launch');
        const env = (k: string) => cfg.get<string>(k) ?? undefined;
        const steeringRepo = new SteeringRepository(pool);
        const orchOf = (key: string) => infra.agents.findTop('orchestrator', 'resource', `telegram:${key}`);
        const q = launchQueries(pool);
        const svc = new LaunchService({
          repo: new LaunchRepository(pool),
          card: (key) => repos.channels.get(key),
          prepareChannel: async (key, title) => {
            if (!(await repos.channels.get(key))) await ops.upsertChannel(key, { mode: 'off', ...(title ? { title } : {}) });
            await infra.registry.run();
            const a = await orchOf(key);
            if (!a) throw new Error(`agent_not_created: no orchestrator for ${key}`);
            return a;
          },
          botCheck: makeLaunchBotCheck((key) => channelConfig.resolveChannelOrDefault(key)),
          steering: {
            createSet: (body, by) => steering.createSet(body, by),
            set: (id) => steeringRepo.get(id),
            discard: (id) => steering.discard(id),
            activate: (id) => steering.activate(id),
          },
          network: async (key) => (await q.ownChannels(key, 30)).map((c) => ({ key: c.key, title: c.title, topic: c.topic })),
          state: channelStateOf(pool, repos, infra),
          loop: ownerStartedLoop(pool, env, notifier, logger, prices, caps),
          model: onboarderModel(env, models),
          // T2: the checklist facts and Start.
          tracked: async (key) => {
            const t = await trackedChannel(pool, key);
            return t ? { isMine: t.isMine, subs: t.subsCount } : null;
          },
          trackOwn: async (key, title) => {
            const t = await trackedChannel(pool, key);
            if (t) { if (!t.isMine && trackedRepo) await trackedRepo.patch(t.id, { isMine: true }); return; }
            if (!tracking) throw new Error('tracking is not available');
            await tracking.createFullChannel({ kind: 'public', username: key.replace(/^@/, ''), isMine: true, ...(title ? { title } : {}) });
          },
          published: (key, since) => q.published(key, since),
          platforms: async (key) => {
            const all = await infra.catalog.list();
            const me = all.find((r) => r.ref === `telegram:${key}`);
            const others = me?.groupId ? all.filter((r) => r.groupId === me.groupId && r.platform !== 'telegram') : [];
            if (!others.length) return [];
            const { rows } = await pool.query(`SELECT resource_ref, resource_health->>'state' AS state FROM resource_profiles WHERE resource_ref = ANY($1::text[])`, [others.map((r) => r.ref)]);
            const st = new Map(rows.map((r: any) => [r.resource_ref, r.state ?? null]));
            return others.map((r) => ({ ref: r.ref, platform: r.platform, title: r.title, state: (st.get(r.ref) as string | null) ?? null }));
          },
          writers: setupWriters(repos, infra, ops, agentsSvc, networkSvc, 'Channel launch (spec 052)'),
          ideas: {
            count: async (originRef) => Number((await pool.query(`SELECT count(*)::int AS n FROM content_ideas WHERE origin = 'owner' AND origin_ref = $1`, [originRef])).rows[0]?.n ?? 0),
            add: (i) => new NetworkRepository(pool).addIdea({ ...i, sources: [], origin: 'owner', status: 'accepted' }),
          },
          setMode: async (key, mode) => {
            await ops.upsertChannel(key, { mode });
            const orch = await orchOf(key);
            if (orch && orch.mode !== mode) await infra.agents.update(orch.id, { mode, shadowUntil: null });
          },
          planAhead: async (key) => {
            const card = await repos.channels.get(key);
            if (!card) return;
            await runner.runPlanner(card);
          },
          // T4: growth — network cross-promo first (FR-004).
          promo: {
            candidates: async (key) => {
              const targetRef = `telegram:${key}`;
              const rows = await q.ownChannels(key);
              const target = (await infra.profiles.get(targetRef))?.profile ?? null;
              const pauses = new ResourcePauseService({ pool });
              const now = new Date();
              return Promise.all(rows.map(async (r) => {
                const ref = `telegram:${r.key}`;
                const [orch, card, usable, paused, prof] = await Promise.all([
                  orchOf(r.key).catch(() => null), repos.channels.get(r.key), platform.health.usable(ref).catch(() => true),
                  pauses.isPaused(ref).catch(() => false), infra.profiles.get(ref).catch(() => null),
                ]);
                const rel = relevance(prof?.profile ?? null, target);
                return {
                  key: r.key, title: r.title, subs: r.subs, agentId: orch?.id ?? null,
                  mode: card ? await approval.mode(card) : 'off', paused: paused || (!!orch && isAgentPaused(orch, now)), usable,
                  relevance: rel.score, note: rel.note,
                };
              }));
            },
            file: async (src, l) => {
              const orch = src.agentId ? await infra.agents.get(src.agentId) : null;
              if (!orch) return { directiveId: null, slotId: null, at: null, error: 'no_agent: no orchestrator runs the source' };
              const sourceRef = `telegram:${src.key}`;
              const filed = await manager.repo.insert({
                fromAgentId: null, toAgentId: orch.id, kind: 'cross_promo', structural: false,
                body: `Promote the new channel ${l.channelKey} in ${src.key} (channel launch)`,
                params: { source_ref: sourceRef, target_ref: l.targetRef, window_days: 7, launch_id: l.id },
                rationale: `The owner launched ${l.channelKey}; growth starts inside the network (spec 052).`,
                evidence: { launch_id: l.id, relevance: src.relevance }, expected: null, reviewAt: null, status: 'awaiting_owner', shadow: false,
              });
              // Owner-approved and accepted at once: the owner started the launch (spec 052 FR-004).
              const dir = await manager.repo.update(filed.id, { status: 'accepted', ownerDecision: 'approved' }, ['awaiting_owner']);
              if (!dir) return { directiveId: filed.id, slotId: null, at: null, error: 'directive_changed: the directive was decided meanwhile' };
              const r = await promoInfra.planner.schedule(dir, orch, src.key);
              if (!('ok' in r)) return { directiveId: dir.id, slotId: null, at: null, error: `${r.error}: ${r.details}` };
              await manager.runner.recordBaseline((await manager.repo.get(dir.id))!, null).catch(() => undefined);
              return { directiveId: dir.id, slotId: r.slotId, at: r.at, error: null };
            },
            joins: (targetRef, since) => q.joins(targetRef, since),
          },
          // T3: graduation from approval (FR-003).
          graduation: {
            settings: () => graduationSettings((k) => process.env[k] ?? cfg.get<string>(k) ?? undefined),
            facts: async (key, since) => {
              const [decisions, critic, usable] = await Promise.all([
                q.decisions(key, since), q.critic(key, since), platform.health.usable(`telegram:${key}`).catch(() => true),
              ]);
              return { decisions, critic, usable };
            },
            mode: async (key) => {
              const card = await repos.channels.get(key);
              return card ? approval.mode(card) : 'off';
            },
            goLive: (key) => autonomy.switchMode({ channel: key, mode: 'live', approve_waiting: true }),
            note: async (l, stats) => {
              const orch = await orchOf(l.channelKey).catch(() => null);
              await infra.inbox.post({
                agentId: orch?.id ?? null, kind: 'launch_graduated', severity: 'action', refType: 'launch', refId: l.id,
                title: `${l.channelKey} went live`,
                body: `The launch criteria were met (${stats.criteria.map((c) => c.label).join('; ')}); posts now go out without approval. Switch back to approval on the agent page.`,
                alert: { title: `🚀 ${l.channelKey} перейшов у Live`, body: `${graduationLineUk(stats)}. Пости тепер виходять без схвалення; повернути режим схвалення можна на сторінці агента.` },
              });
            },
          },
          log: (m) => logger.warn(m),
        });
        LAUNCH.svc = svc;
        return svc;
      },
    },
    {
      // Spec 049 FR-005: connections, sources, budget headroom and stuck work in one view.
      provide: NETWORK_HEALTH,
      inject: [DB_POOL, AGENT_INFRA, EDITOR_REPOS],
      useFactory: (pool: Pool, infra: AgentInfra, repos: EditorRepos) => new NetworkHealthService({
        pool, channels: repos.channels, catalog: infra.catalog,
        sources: (card) => sourceHealthOf(pool, repos.channels).forCard(card),
        budgets: () => budgetSnapshot(new SpendRepository(pool)),
      }),
    },
    {
      // Spec 056 FR-001: the network map snapshot (5 s cache; stuck work from the network health view).
      provide: MAP_SERVICE,
      inject: [DB_POOL, AGENT_INFRA, NETWORK_HEALTH],
      useFactory: (pool: Pool, infra: AgentInfra, health: NetworkHealthService) => new MapService({
        pool, agents: infra.agents, catalog: infra.catalog, budgets: () => budgetSnapshot(new SpendRepository(pool)),
        pausedRefs: () => new ResourcePauseService({ pool }).pausedRefs(), health: () => health.health(),
        log: (m) => new Logger('Map').warn(m),
      }),
    },
    {
      // Spec 056 follow-up: a resource's network and blocked promo pairs, changed from the map.
      provide: MAP_ACTIONS,
      inject: [DB_POOL, AGENT_INFRA, MAP_SERVICE],
      useFactory: (pool: Pool, infra: AgentInfra, map: MapService) => new MapActions({ pool, catalog: infra.catalog, invalidate: () => map.invalidate() }),
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
    {
      // Spec 042: channel setup from history (posts → metrics → one onboarder run → a proposal applied by section).
      provide: CHANNEL_SETUP_SERVICE,
      inject: [
        DB_POOL, ConfigService, AGENT_INFRA, EDITOR_REPOS, EDITOR_OPS, AGENTS_SERVICE, NETWORK_SERVICE, MODEL_DEFAULTS, TelegramNotifier,
        { token: TrackingMtprotoClient, optional: true }, { token: PriceService, optional: true }, { token: LlmBudgetService, optional: true },
      ],
      useFactory: (
        pool: Pool, cfg: ConfigService, infra: AgentInfra, repos: EditorRepos, ops: EditorOpsService, agentsSvc: AgentsService,
        networkSvc: NetworkService, models: WorkspaceModelStore, notifier: TelegramNotifier, mtproto?: TrackingMtprotoClient,
        prices?: PriceService, caps?: LlmBudgetService,
      ): ChannelSetupService => {
        const logger = new Logger('ChannelSetup');
        const env = (k: string) => cfg.get<string>(k) ?? undefined;
        const loop = ownerStartedLoop(pool, env, notifier, logger, prices, caps);
        const setupRepo = new ChannelSetupRepository(pool);
        return new ChannelSetupService({
          pool, repo: setupRepo, loop,
          // Spec 057: forgotten proposals expire after SETUP_PROPOSAL_TTL_DAYS (a live setting).
          expiry: new SetupExpiry({ repo: setupRepo, inbox: infra.inbox, ttlDays: () => setupTtlDays(env('SETUP_PROPOSAL_TTL_DAYS')), log: (m) => logger.warn(m) }),
          collect: (key) => collectPosts({ pool, readHistory: mtproto ? (target, limit) => mtproto.readHistory(target, 0, limit) : undefined }, key),
          model: onboarderModel(env, models),
          state: channelStateOf(pool, repos, infra),
          writers: setupWriters(repos, infra, ops, agentsSvc, networkSvc, 'Setup from the channel history'),
          log: (m) => logger.warn(m),
        });
      },
    },
    {
      // Spec 045: steering (a reference's last posts → one onboarder run → rules the owner activates for a channel).
      provide: STEERING_SERVICE,
      inject: [
        DB_POOL, ConfigService, AGENT_INFRA, EDITOR_REPOS, MODEL_DEFAULTS, TelegramNotifier,
        { token: TrackingMtprotoClient, optional: true }, { token: PriceService, optional: true }, { token: LlmBudgetService, optional: true },
      ],
      useFactory: (
        pool: Pool, cfg: ConfigService, infra: AgentInfra, repos: EditorRepos, models: WorkspaceModelStore, notifier: TelegramNotifier,
        mtproto?: TrackingMtprotoClient, prices?: PriceService, caps?: LlmBudgetService,
      ): SteeringService => {
        const logger = new Logger('Steering');
        const env = (k: string) => cfg.get<string>(k) ?? undefined;
        const network = new NetworkRepository(pool);
        return new SteeringService({
          repo: new SteeringRepository(pool),
          readers: {
            telegram: telegramReader({
              readHistory: mtproto ? (target, limit) => mtproto.readHistory(target, 0, limit) : undefined,
              fullChannel: mtproto ? async (target) => {
                const f = await mtproto.getFullChannel(target);
                return f && f !== 'not_subscribed' ? { title: f.title ?? null, about: f.about ?? null, subsCount: f.subsCount ?? null } : f;
              } : undefined,
            }),
          },
          // Spec 052 FR-001: a channel with an open launch counts as ours (the bot-admin check proves it before Start).
          isOwn: async (key) => !!(await trackedChannel(pool, key))?.isMine || !!(await new LaunchRepository(pool).openFor(key)),
          target: async (ref) => {
            const key = ref.replace(/^telegram:/, '');
            const [card, agent, stored, format, memory] = await Promise.all([
              repos.channels.get(key), infra.agents.findTop('orchestrator', 'resource', ref), infra.profiles.get(ref),
              infra.profiles.formatOf(ref), repos.memory.listActive(key, 60).catch(() => []),
            ]);
            const pb = agent ? (await network.activePlaybook(agent.id))?.body ?? null : null;
            // The target's part of the playbook: its section and series, the shared pillars and rules.
            const mine = pb ? { ...pb, platforms: pb.platforms.filter((x) => x.resource_ref === ref), series: pb.series.filter((x) => x.resource_ref === ref), examples: [] } : null;
            return {
              card, agent,
              target: {
                ref, title: card?.title ?? null, brief: card?.brief?.trim() || null,
                profile: stored?.profile ? renderProfile(stored.profile, { ref }) : null,
                ownerRules: ownerRulesOf(memory),
                playbook: mine && (mine.platforms.length || mine.series.length || mine.rules.length || mine.pillars.length) ? renderPlaybook(mine) : null,
                formatPrefs: renderFormatPrefs(format.prefs, format.locks), locks: format.locks,
              },
            };
          },
          loop: ownerStartedLoop(pool, env, notifier, logger, prices, caps),
          model: onboarderModel(env, models),
          log: (m) => logger.warn(m),
        });
      },
    },
    {
      // Spec 012 part A: the owner bot (cards with buttons for what waits, delivered on the admin bot's chat).
      provide: OWNER_BOT,
      inject: [
        DB_POOL, ConfigService, APPROVALS_SERVICE, MANAGER_SERVICE, AGENT_INFRA, STEERING_SERVICE, CHANNEL_SETUP_SERVICE, NETWORK_SERVICE, NETWORK_HEALTH,
        LAUNCH_SERVICE,
      ],
      useFactory: (
        pool: Pool, cfg: ConfigService, approvals: ApprovalsService, manager: ManagerService, infra: AgentInfra, steering: SteeringService,
        setup: ChannelSetupService, network: NetworkService, health: NetworkHealthService, launches: LaunchService,
      ): OwnerBotInfra => {
        const logger = new Logger('OwnerBot');
        const token = cfg.get<string>('TELEGRAM_BOT_TOKEN');
        // Live settings: the settings overlay keeps process.env current (spec 039).
        const env = (k: string) => process.env[k] ?? cfg.get<string>(k) ?? undefined;
        const repo = new OwnerCardsRepository(pool);
        let bot: OwnerBotService | null = null;
        const reports = new OwnerReports({
          pool, repo, env, budgets: () => budgetSnapshot(new SpendRepository(pool)), health: () => health.health(),
          waiting: async () => (bot ? bot.waitingCounts() : []),
        });
        bot = new OwnerBotService({
          pool, repo, env, api: token ? telegramBotApi(token) : null,
          sources: [
            ...cardSources({
              pool, approvals, directives: manager, actions: infra.actions, steering, setup, playbooks: network,
              inbox: { markRead: (ids) => infra.inbox.markRead(ids) }, setupSections: SETUP_SECTIONS,
            }),
            // Spec 052 FR-002: a launch plan waiting for Start, a Start waiting for the bot.
            launchSource({ pool, launches }),
          ],
          status: () => reports.statusLines(),
          reports: { today: () => reports.daily(), week: () => reports.weekly() },
          log: (m) => logger.warn(m),
        });
        return { bot, reports };
      },
    },
    {
      // Spec 059: a skill self-edit is tried on the agent's latest posts (old text vs new, dry runs, a pairwise judge on the
      // critic's model) before it goes live. Anything that cannot run adopts as before.
      provide: SKILL_PROBE,
      inject: [DB_POOL, ConfigService, AGENT_INFRA, EDITOR_REPOS, EDITOR_RUNNER, EDITOR_LOOP, MODEL_DEFAULTS, CRITIC_MODEL],
      useFactory: (
        pool: Pool, cfg: ConfigService, infra: AgentInfra, repos: EditorRepos, runner: EditorRunnerService, loop: AgentLoop,
        models: WorkspaceModelStore, critic: WorkspaceModelStore,
      ): SkillProbe => {
        const logger = new Logger('SkillProbe');
        const env = (k: string) => cfg.get<string>(k) ?? undefined;
        const judge = new LlmPairwiseJudge({
          loop, env, defaultModel: (ws) => models.get(ws), workspace: () => models.workspace(), criticModel: (ws) => critic.get(ws),
        });
        return new SkillProbe({
          skills: infra.skills, agents: infra.agents, inbox: infra.inbox,
          settings: () => probeSettings(env),
          pick: (agent, skill, limit) => pickProbeSlots(pool, agent, skill, limit),
          run: async (slotId, o) => {
            const slot = await repos.plans.getSlot(slotId);
            if (!slot) throw new Error('slot_not_found');
            const card = await repos.channels.get(slot.channelKey);
            if (!card) throw new Error('channel_not_found');
            return runner.runPreview(slot, card, { probe: true, skillOverride: o.override ?? undefined, maxCostUsd: o.maxCostUsd });
          },
          judge,
          judgeContext: async (slotId) => {
            const slot = await repos.plans.getSlot(slotId);
            if (!slot) return null;
            const [card, stored, memory] = await Promise.all([
              repos.channels.get(slot.channelKey),
              slot.resourceRef ? infra.profiles.get(slot.resourceRef).catch(() => null) : Promise.resolve(null),
              repos.memory.listActive(slot.channelKey, 60).catch(() => []),
            ]);
            const rules = ownerRulesOf(memory).map((r) => `- ${r.text.trim()}`);
            return [
              card?.brief ? `Бриф: ${card.brief}` : '',
              stored?.profile ? renderProfile(stored.profile, { ref: slot.resourceRef ?? undefined }) : '',
              rules.length ? `Правила власника:\n${rules.join('\n')}` : '',
            ].filter(Boolean).join('\n\n') || null;
          },
          remember: async (agent, text, evidence) => {
            const key = telegramKeyOf(agent.parentId ? (await infra.agents.get(agent.parentId)) ?? agent : agent);
            if (key) await repos.memory.add(key, 'avoid', text, evidence, 'reviewer');
          },
          log: (m) => logger.warn(m),
        });
      },
    },
    SkillProbeWorker,
    OwnerBotWorker,
    ChannelSetupWorker,
    SteeringWorker,
    LaunchWorker,
    AuditWorker,
    EditorCron,
    AgentsUpkeep,
    StoryBackfill,
    StrategyMigrationUpkeep,
];

@Module({
  // AuthModule: EditorController is guarded by TrackingAuthGuard, which injects AuthService.
  imports:     [ChannelConfigModule, PublishersModule, AuthModule],
  controllers: [EditorController, EditorChatController, AgentsController, LoadoutController, ModelsController, NetworkController, ManagerController, PromoController, PromoRedirectController, ApprovalsController, AutonomyController, ScheduleController, StrategyMigrationController, UpcomingSlotsController, ResourcePausesController, PostAuditController, ChannelSetupController, SteeringController, NetworkHealthController, ArtifactsController, OwnerBotController, LaunchController, MapController, AuditController],
  providers:   [...EDITOR_PROVIDERS, TrackingAuthGuard],
  exports:     [EDITOR_REPOS, EDITOR_RUNNER, AGENT_INFRA, PLATFORM_INFRA, EDITOR_MANAGER],
})
export class EditorModule {}
