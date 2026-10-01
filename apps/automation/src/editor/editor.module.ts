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
import { EditorChannelsRepository } from './repo/editor-channels.repository';
import { EditorPlansRepository } from './repo/editor-plans.repository';
import { EditorMemoryRepository } from './repo/editor-memory.repository';
import { TelegramEditorPublisher } from './publish/telegram-editor.publisher';
import { EditorRunnerService } from './roles/editor-runner.service';
import { EditorScheduler } from './editor.scheduler';
import { htmlToPlain } from './post/inline-markup';

export const EDITOR_RUNNER    = 'EDITOR_RUNNER';
export const EDITOR_SCHEDULER = 'EDITOR_SCHEDULER';
export const EDITOR_REPOS     = 'EDITOR_REPOS';

export interface EditorRepos {
  channels: EditorChannelsRepository;
  plans:    EditorPlansRepository;
  memory:   EditorMemoryRepository;
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
 * Editor agent (specs/003–005). Always imported; does nothing unless
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
      }),
    },
    {
      provide: EDITOR_RUNNER,
      inject: [DB_POOL, ConfigService, EDITOR_REPOS, ChannelConfigService, TelegramNotifier, PostingThrottleService],
      useFactory: (
        pool: Pool, cfg: ConfigService, repos: EditorRepos, channelConfig: ChannelConfigService,
        notifier: TelegramNotifier, throttle: PostingThrottleService,
      ): EditorRunnerService => {
        const logger = new Logger('Editor');
        const env = (k: string) => cfg.get<string>(k) ?? undefined;
        const notify = (text: string) => notifier.notifyAlert(text);
        const skills = new SkillLibrary();
        const publisher = new TelegramEditorPublisher({
          resolveChannel:     (k) => channelConfig.resolveChannel(k),
          isPublishPausedFor: (k) => channelConfig.isPublishPausedFor(k),
        });
        const registry = new ToolRegistry([
          ...buildReadTools({ pool, readonly: new ReadonlyQueryService(pool), skills }),
          ...buildComposeTools(),
          ...buildRoleTools({
            pool, plans: repos.plans, memory: repos.memory, channels: repos.channels, publisher,
            recordPublish: (k) => throttle.recordPublish(k),
            notifyPreview: env('EDITOR_SHADOW_PREVIEW') === 'false'
              ? undefined
              : (k, html) => notifier.notifyAlert(previewMessage(k, html)),
          }),
        ]);
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
      inject: [DB_POOL, ConfigService, EDITOR_REPOS, EDITOR_RUNNER, TelegramNotifier],
      useFactory: (pool: Pool, cfg: ConfigService, repos: EditorRepos, runner: EditorRunnerService, notifier: TelegramNotifier) => {
        const logger = new Logger('EditorScheduler');
        return new EditorScheduler({
          pool, channels: repos.channels, plans: repos.plans, runner,
          enabled: () => isEnabled(cfg),
          notify: (t) => notifier.notifyAlert(t),
          log: (m) => logger.warn(m),
        });
      },
    },
    EditorCron,
];

@Module({
  imports:   [ChannelConfigModule, PublishersModule],
  providers: EDITOR_PROVIDERS,
  exports:   [EDITOR_REPOS, EDITOR_RUNNER],
})
export class EditorModule {}
