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
import { buildComposeTools } from './tools/compose-tools';
import { buildRoleTools } from './tools/role-tools';
import { buildApiTools } from './tools/api-tools';
import { EditorChannelsRepository } from './repo/editor-channels.repository';
import { EditorPlansRepository } from './repo/editor-plans.repository';
import { EditorMemoryRepository } from './repo/editor-memory.repository';
import { TelegramEditorPublisher } from './publish/telegram-editor.publisher';
import { SponsoredPublisher } from './publish/sponsored.publisher';
import { EditorMediaPreparer } from './publish/prepare-media';
import { EditorCrossPoster } from './publish/editor-crosspost';
import { safeGetBytes } from './net/safe-http';
import { AdOrdersRepository } from '../payments/ad-orders.repository';
import { EditorRunnerService } from './roles/editor-runner.service';
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
import { telegramKeyOf } from './agents/agent.types';
import { TrackingAuthGuard } from '../tracking/api/tracking-auth.guard';

export const EDITOR_RUNNER    = 'EDITOR_RUNNER';
export const EDITOR_SCHEDULER = 'EDITOR_SCHEDULER';
export const EDITOR_REPOS     = 'EDITOR_REPOS';
export const EDITOR_SKILLS    = 'EDITOR_SKILLS';
export const EDITOR_REGISTRY  = 'EDITOR_REGISTRY';
/** Live publish ports shared by publish_post and the chat (Telegram sender, media stage, mirrors). */
export const EDITOR_PUBLISH   = 'EDITOR_PUBLISH';
/** Agent registry infrastructure (spec 017): repository, DB skills, owner inbox, scope KPI, run-time resolver. */
export const AGENT_INFRA      = 'AGENT_INFRA';

export interface AgentInfra {
  agents:   AgentsRepository;
  skills:   SkillStore;
  inbox:    OwnerInbox;
  kpi:      ScopeKpi;
  runtime:  AgentRuntime;
  registry: AgentRegistrySync;
}
export { EDITOR_OPS, EDITOR_CHAT, EDITOR_DRAFTS };

type PublishPorts = Pick<PublishSpecDeps, 'publisher' | 'media' | 'crosspost'>;

export interface EditorRepos {
  channels: EditorChannelsRepository;
  plans:    EditorPlansRepository;
  memory:   EditorMemoryRepository;
  runs:     EditorRunsRepository;
  chat:     EditorChatRepository;
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
  ) {}

  async onModuleInit(): Promise<void> {
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

/**
 * Editor agent (specs/003–006). Always imported; does nothing unless
 * EDITOR_ENABLED=true AND a channel's editorial card has mode shadow/live.
 */
export const EDITOR_PROVIDERS = [
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
      inject: [DB_POOL, ConfigService, EDITOR_REPOS, EDITOR_SKILLS, TelegramNotifier],
      useFactory: (pool: Pool, cfg: ConfigService, repos: EditorRepos, files: SkillLibrary, notifier: TelegramNotifier): AgentInfra => {
        const logger = new Logger('Agents');
        const agents = new AgentsRepository(pool);
        const skills = new SkillStore(pool);
        return {
          agents, skills,
          inbox: new OwnerInbox(pool, (t) => notifier.notifyAlert(t), cfg.get<string>('DASHBOARD_URL') ?? null),
          kpi: new TelegramScopeKpi(pool),
          runtime: new AgentRuntime({ agents, store: skills, fallback: files, log: (m) => logger.warn(m) }),
          registry: new AgentRegistrySync({ agents, channels: repos.channels, log: (m) => logger.log(m) }),
        };
      },
    },
    {
      provide: EDITOR_PUBLISH,
      inject: [
        ChannelConfigService, RecipeCarouselRendererService, SlideHostingService, TelegraphService, CrossPostService, GroupFanOutService,
      ],
      useFactory: (
        channelConfig: ChannelConfigService, renderer: RecipeCarouselRendererService, hosting: SlideHostingService,
        telegraph: TelegraphService, crossPost: CrossPostService, groupFanOut: GroupFanOutService,
      ): PublishPorts => ({
        publisher: new TelegramEditorPublisher({
          resolveChannel:     (k) => channelConfig.resolveChannel(k),
          isPublishPausedFor: (k) => channelConfig.isPublishPausedFor(k),
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
        }),
        // Live posts are mirrored like the legacy strategies' (spec 009 T003); card.crosspost=false opts out.
        crosspost: new EditorCrossPoster({
          crossPost, groupFanOut,
          postLink: (k, id) => tgPostLink(channelConfig.getChannelMeta(k)?.username ?? null, id),
        }),
      }),
    },
    {
      // Deterministic draft actions of the editor chat (spec 010): composer tools, REST buttons, scheduled path.
      provide: EDITOR_DRAFTS,
      inject: [DB_POOL, EDITOR_REPOS, EDITOR_PUBLISH, ChannelConfigService, TelegramNotifier, PostingThrottleService],
      useFactory: (
        pool: Pool, repos: EditorRepos, ports: PublishPorts, channelConfig: ChannelConfigService,
        notifier: TelegramNotifier, throttle: PostingThrottleService,
      ): DraftsService => {
        const logger = new Logger('EditorDrafts');
        return new DraftsService({
          pool, repo: repos.chat, channels: repos.channels, plans: repos.plans, ...ports,
          recordPublish: (k) => throttle.recordPublish(k),
          isPaused: (k) => channelConfig.isPublishPausedFor(k),
          notify: (t) => notifier.notifyAlert(t),
          log: (m) => logger.warn(m),
        });
      },
    },
    {
      // One registry for the runner, the chat and the ops surface (REST tools endpoint → MCP).
      provide: EDITOR_REGISTRY,
      inject: [DB_POOL, ConfigService, EDITOR_REPOS, EDITOR_SKILLS, EDITOR_PUBLISH, EDITOR_DRAFTS, TelegramNotifier, PostingThrottleService, AGENT_INFRA],
      useFactory: (
        pool: Pool, cfg: ConfigService, repos: EditorRepos, skills: SkillLibrary, ports: PublishPorts, drafts: DraftsService,
        notifier: TelegramNotifier, throttle: PostingThrottleService, infra: AgentInfra,
      ): ToolRegistry => {
        const env = (k: string) => cfg.get<string>(k) ?? undefined;
        return new ToolRegistry([
          ...buildReadTools({ pool, readonly: new ReadonlyQueryService(pool), skills }),
          ...buildComposeTools(),
          ...buildApiTools({ env }),
          ...buildRoleTools({
            pool, plans: repos.plans, memory: repos.memory, channels: repos.channels, ...ports,
            recordPublish: (k) => throttle.recordPublish(k),
            notifyPreview: env('EDITOR_SHADOW_PREVIEW') === 'false'
              ? undefined
              : (k, html) => notifier.notifyAlert(previewMessage(k, html)),
          }),
          ...buildComposerTools({ drafts, repo: repos.chat }),
          ...buildAgentSkillTools({ agents: infra.agents, skills: infra.skills, kpi: infra.kpi, inbox: infra.inbox }),
        ]);
      },
    },
    {
      provide: EDITOR_RUNNER,
      inject: [DB_POOL, ConfigService, EDITOR_REPOS, EDITOR_SKILLS, EDITOR_REGISTRY, TelegramNotifier, AGENT_INFRA],
      useFactory: (
        pool: Pool, cfg: ConfigService, repos: EditorRepos, skills: SkillLibrary, registry: ToolRegistry, notifier: TelegramNotifier,
        infra: AgentInfra,
      ): EditorRunnerService => {
        const logger = new Logger('Editor');
        const env = (k: string) => cfg.get<string>(k) ?? undefined;
        const notify = (text: string) => notifier.notifyAlert(text);
        const loop = new AgentLoop({
          llm: new OpenRouterClient({ apiKey: env('OPENROUTER_API_KEY'), baseUrl: env('OPENROUTER_BASE_URL') }),
          recorder: new PgRunRecorder(pool, (m) => logger.warn(m)),
          budget: new BudgetService(pool, {
            globalDailyUsd:  Number(env('EDITOR_DAILY_BUDGET_USD') ?? 3),
            channelDailyUsd: Number(env('EDITOR_CHANNEL_DAILY_BUDGET_USD') ?? 0.5),
          }, notify),
          enabled: () => isEnabled(cfg),
        });
        logger.log(`editor ${isEnabled(cfg) ? 'ENABLED' : 'disabled'}: ${registry.all().length} tools, ${skills.list().length} skills`);
        return new EditorRunnerService({ loop, registry, skills, runtime: infra.runtime, plans: repos.plans, memory: repos.memory, env, notify });
      },
    },
    {
      provide: EDITOR_SCHEDULER,
      inject: [DB_POOL, ConfigService, EDITOR_REPOS, EDITOR_RUNNER, EDITOR_PUBLISH, EDITOR_DRAFTS, TelegramNotifier, PostingThrottleService],
      useFactory: (
        pool: Pool, cfg: ConfigService, repos: EditorRepos, runner: EditorRunnerService, ports: PublishPorts, drafts: DraftsService,
        notifier: TelegramNotifier, throttle: PostingThrottleService,
      ) => {
        const logger = new Logger('EditorScheduler');
        const notify = (t: string) => notifier.notifyAlert(t);
        const orders = new AdOrdersRepository(pool);
        // Reserved slots publish deterministically, without the LLM: paid ads (spec 008) and scheduled chat posts (spec 010).
        const reserved = new ReservedDispatcher({
          plans: repos.plans, orders,
          sponsored: new SponsoredPublisher({
            plans: repos.plans, channels: repos.channels, orders, publisher: ports.publisher,
            recordPublish: (k) => throttle.recordPublish(k),
            notify,
            log: (m) => logger.warn(m),
          }),
          manual: drafts,
          log: (m) => logger.warn(m),
        });
        return new EditorScheduler({
          pool, channels: repos.channels, plans: repos.plans, runner, reserved,
          enabled: () => isEnabled(cfg),
          notify,
          log: (m) => logger.warn(m),
        });
      },
    },
    {
      // Editor chat (spec 010): needs only an LLM key, independent of EDITOR_ENABLED.
      provide: EDITOR_CHAT,
      inject: [DB_POOL, ConfigService, EDITOR_REPOS, EDITOR_SKILLS, EDITOR_REGISTRY, EDITOR_DRAFTS, TelegramNotifier],
      useFactory: (
        pool: Pool, cfg: ConfigService, repos: EditorRepos, skills: SkillLibrary, registry: ToolRegistry, drafts: DraftsService,
        notifier: TelegramNotifier,
      ): EditorChatService => {
        const logger = new Logger('EditorChat');
        const env = (k: string) => cfg.get<string>(k) ?? undefined;
        const enabled = () => !!env('OPENROUTER_API_KEY');
        const loop = new AgentLoop({
          llm: new OpenRouterClient({ apiKey: env('OPENROUTER_API_KEY'), baseUrl: env('OPENROUTER_BASE_URL') }),
          recorder: new PgRunRecorder(pool, (m) => logger.warn(m)),
          budget: new BudgetService(pool, {
            globalDailyUsd:  Number(env('EDITOR_DAILY_BUDGET_USD') ?? 3),
            channelDailyUsd: Number(env('EDITOR_CHANNEL_DAILY_BUDGET_USD') ?? 0.5),
          }, (t) => notifier.notifyAlert(t)),
          enabled,
        });
        return new EditorChatService({
          repo: repos.chat, drafts, memory: repos.memory, loop, registry, skills, env, enabled,
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
      inject: [DB_POOL, AGENT_INFRA, EDITOR_REPOS, EDITOR_OPS, EDITOR_RUNNER],
      useFactory: (pool: Pool, infra: AgentInfra, repos: EditorRepos, ops: EditorOpsService, runner: EditorRunnerService) => {
        const logger = new Logger('Agents');
        return new AgentsService({
          pool, agents: infra.agents, skills: infra.skills, inbox: infra.inbox,
          setChannelMode: (key, mode) => ops.upsertChannel(key, { mode }),
          memory: (key) => repos.memory.listActive(key, 100),
          sync: () => infra.registry.run(),
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
      },
    },
    EditorCron,
    AgentsUpkeep,
];

@Module({
  // AuthModule: EditorController is guarded by TrackingAuthGuard, which injects AuthService.
  imports:     [ChannelConfigModule, PublishersModule, AuthModule],
  controllers: [EditorController, EditorChatController, AgentsController],
  providers:   [...EDITOR_PROVIDERS, TrackingAuthGuard],
  exports:     [EDITOR_REPOS, EDITOR_RUNNER, AGENT_INFRA],
})
export class EditorModule {}
