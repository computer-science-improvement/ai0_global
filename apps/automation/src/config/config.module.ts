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
import { ForwardRoutesRepository } from './forward-routes.repository';
import { TelegramGetMeClient } from './telegram-getme.client';
import { MyBotsController } from './api/my-bots.controller';
import { AuthModule } from '../auth/auth.module';

@Global()
@Module({
  imports: [NestConfigModule, DatabaseModule, TrackingModule, AuthModule],
  controllers: [MyBotsController],
  providers: [
    ChannelConfigService,
    ConfigCacheService,
    ConfigEventsPublisher,
    JsonImporterService,
    MyBotsRepository,
    TrackedChannelsConfigRepository,
    StrategyBindingsRepository,
    ForwardRoutesRepository,
    TelegramGetMeClient,
  ],
  exports: [
    ChannelConfigService,
    ConfigCacheService,
    ConfigEventsPublisher,
    MyBotsRepository,
    TrackedChannelsConfigRepository,
    StrategyBindingsRepository,
    ForwardRoutesRepository,
  ],
})
export class ChannelConfigModule {}
