import { Inject, Injectable, Logger, Module } from '@nestjs/common';
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
import { EditorOpsService } from './api/editor-ops.service';
import { EDITOR_OPS, EditorController } from './api/editor.controller';
import { AuthModule } from '../auth/auth.module';
import { TrackingAuthGuard } from '../tracking/api/tracking-auth.guard';

export const EDITOR_RUNNER    = 'EDITOR_RUNNER';
export const EDITOR_SCHEDULER = 'EDITOR_SCHEDULER';
export const EDITOR_REPOS     = 'EDITOR_REPOS';
export const EDITOR_SKILLS    = 'EDITOR_SKILLS';
export const EDITOR_REGISTRY  = 'EDITOR_REGISTRY';
export { EDITOR_OPS };

export interface EditorRepos {
  channels: EditorChannelsRepository;
  plans:    EditorPlansRepository;
  memory:   EditorMemoryRepository;
  runs:     EditorRunsRepository;
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
      }),
    },
    { provide: EDITOR_SKILLS, useFactory: () => new SkillLibrary() },
    {
      // One registry for the runner and the ops surface (REST tools endpoint → MCP).
      provide: EDITOR_REGISTRY,
      inject: [
        DB_POOL, ConfigService, EDITOR_REPOS, EDITOR_SKILLS, ChannelConfigService, TelegramNotifier, PostingThrottleService,
        RecipeCarouselRendererService, SlideHostingService, TelegraphService, CrossPostService, GroupFanOutService,
      ],
      useFactory: (
        pool: Pool, cfg: ConfigService, repos: EditorRepos, skills: SkillLibrary, channelConfig: ChannelConfigService,
        notifier: TelegramNotifier, throttle: PostingThrottleService,
        renderer: RecipeCarouselRendererService, hosting: SlideHostingService, telegraph: TelegraphService,
        crossPost: CrossPostService, groupFanOut: GroupFanOutService,
      ): ToolRegistry => {
        const env = (k: string) => cfg.get<string>(k) ?? undefined;
        const publisher = new TelegramEditorPublisher({
          resolveChannel:     (k) => channelConfig.resolveChannel(k),
          isPublishPausedFor: (k) => channelConfig.isPublishPausedFor(k),
        });
        // Carousel slides and longread pages are produced only by a live publish_post (spec 009 T002).
        const media = new EditorMediaPreparer({
          renderSlides: (slides) => renderer.renderSlides(slides),
          hosting,
          createPage:   (a) => telegraph.createPage(a),
          fetchImage:   async (url) => {
            const r = await safeGetBytes(url);
            return r.status < 400 ? r.body : null;
          },
        });
        // Live posts are mirrored like the legacy strategies' (spec 009 T003); card.crosspost=false opts out.
        const crosspost = new EditorCrossPoster({
          crossPost, groupFanOut,
          postLink: (k, id) => tgPostLink(channelConfig.getChannelMeta(k)?.username ?? null, id),
        });
        return new ToolRegistry([
          ...buildReadTools({ pool, readonly: new ReadonlyQueryService(pool), skills }),
          ...buildComposeTools(),
          ...buildApiTools({ env }),
          ...buildRoleTools({
            pool, plans: repos.plans, memory: repos.memory, channels: repos.channels, publisher,
            recordPublish: (k) => throttle.recordPublish(k),
            media,
            crosspost,
            notifyPreview: env('EDITOR_SHADOW_PREVIEW') === 'false'
              ? undefined
              : (k, html) => notifier.notifyAlert(previewMessage(k, html)),
          }),
        ]);
      },
    },
    {
      provide: EDITOR_RUNNER,
      inject: [DB_POOL, ConfigService, EDITOR_REPOS, EDITOR_SKILLS, EDITOR_REGISTRY, TelegramNotifier],
      useFactory: (
        pool: Pool, cfg: ConfigService, repos: EditorRepos, skills: SkillLibrary, registry: ToolRegistry, notifier: TelegramNotifier,
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
        return new EditorRunnerService({ loop, registry, skills, plans: repos.plans, memory: repos.memory, env, notify });
      },
    },
    {
      provide: EDITOR_SCHEDULER,
      inject: [DB_POOL, ConfigService, EDITOR_REPOS, EDITOR_RUNNER, TelegramNotifier, ChannelConfigService, PostingThrottleService],
      useFactory: (
        pool: Pool, cfg: ConfigService, repos: EditorRepos, runner: EditorRunnerService, notifier: TelegramNotifier,
        channelConfig: ChannelConfigService, throttle: PostingThrottleService,
      ) => {
        const logger = new Logger('EditorScheduler');
        const notify = (t: string) => notifier.notifyAlert(t);
        // Paid ads (spec 008): reserved slots publish deterministically, without the LLM.
        const reserved = new SponsoredPublisher({
          plans: repos.plans, channels: repos.channels, orders: new AdOrdersRepository(pool),
          publisher: new TelegramEditorPublisher({
            resolveChannel:     (k) => channelConfig.resolveChannel(k),
            isPublishPausedFor: (k) => channelConfig.isPublishPausedFor(k),
          }),
          recordPublish: (k) => throttle.recordPublish(k),
          notify,
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
    EditorCron,
];

@Module({
  // AuthModule: EditorController is guarded by TrackingAuthGuard, which injects AuthService.
  imports:     [ChannelConfigModule, PublishersModule, AuthModule],
  controllers: [EditorController],
  providers:   [...EDITOR_PROVIDERS, TrackingAuthGuard],
  exports:     [EDITOR_REPOS, EDITOR_RUNNER],
})
export class EditorModule {}
