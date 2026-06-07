// apps/automation/src/config/config.module.ts
import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../database/database.module';
import { TrackingModule } from '../tracking/tracking.module';
import { ChannelConfigService } from './channel-config.service';
import { ConfigCacheService } from './config-cache.service';
import { ConfigEventsPublisher } from './config-events.publisher';
import { JsonImporterService } from './json-importer.service';
import { MyBotsRepository } from './my-bots.repository';
import { TrackedChannelsConfigRepository } from './tracked-channels.repository';
import { StrategyBindingsRepository } from './strategy-bindings.repository';
import { StrategyRunsRepository } from './strategy-runs.repository';
import { StrategyPreviewService } from './strategy-preview.service';
import { ForwardRoutesRepository } from './forward-routes.repository';
import { TelegramGetMeClient } from './telegram-getme.client';
import { TelegraphAccountsRepository } from './telegraph-accounts.repository';
import { TelegraphGetInfoClient } from './telegraph-getinfo.client';
import { MetaAccountsRepository } from './meta-accounts.repository';
import { MetaGraphClient } from './meta-graph.client';
import { MetaCrosspostTargetsRepository } from './meta-crosspost-targets.repository';
import { MyBotsController } from './api/my-bots.controller';
import { TelegraphAccountsController } from './api/telegraph-accounts.controller';
import { MetaAccountsController } from './api/meta-accounts.controller';
import { MetaCrosspostsController } from './api/meta-crossposts.controller';
import { StrategiesController } from './api/strategies.controller';
import { ForwardRoutesController } from './api/forward-routes.controller';
import { AuthModule } from '../auth/auth.module';

@Global()
@Module({
  imports: [NestConfigModule, DatabaseModule, TrackingModule, AuthModule],
  controllers: [MyBotsController, TelegraphAccountsController, MetaAccountsController, MetaCrosspostsController, StrategiesController, ForwardRoutesController],
  providers: [
    ChannelConfigService,
    ConfigCacheService,
    ConfigEventsPublisher,
    JsonImporterService,
    MyBotsRepository,
    TrackedChannelsConfigRepository,
    StrategyBindingsRepository,
    StrategyRunsRepository,
    StrategyPreviewService,
    ForwardRoutesRepository,
    TelegramGetMeClient,
    TelegraphAccountsRepository,
    TelegraphGetInfoClient,
    MetaAccountsRepository,
    MetaGraphClient,
    MetaCrosspostTargetsRepository,
  ],
  exports: [
    ChannelConfigService,
    ConfigCacheService,
    ConfigEventsPublisher,
    MyBotsRepository,
    TrackedChannelsConfigRepository,
    StrategyBindingsRepository,
    StrategyRunsRepository,
    ForwardRoutesRepository,
    TelegraphAccountsRepository,
    MetaCrosspostTargetsRepository,
  ],
})
export class ChannelConfigModule {}
