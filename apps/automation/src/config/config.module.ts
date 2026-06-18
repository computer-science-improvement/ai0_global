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
import { MtprotoSessionsRepository } from './mtproto-sessions.repository';
import { MtprotoVerifyClient } from './mtproto-verify.client';
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
import { TikTokAccountsRepository } from './tiktok-accounts.repository';
import { TikTokTokenService } from './tiktok-token.service';
import { MyBotsController } from './api/my-bots.controller';
import { MtprotoSessionsController } from './api/mtproto-sessions.controller';
import { TelegraphAccountsController } from './api/telegraph-accounts.controller';
import { MetaAccountsController } from './api/meta-accounts.controller';
import { MetaCrosspostsController } from './api/meta-crossposts.controller';
import { TikTokOAuthService } from './tiktok-oauth.service';
import { TikTokAccountsController } from './api/tiktok-accounts.controller';
import { TikTokOAuthController } from './api/tiktok-oauth.controller';
import { LandingResourcesService } from './landing-resources.service';
import { LandingController } from './api/landing.controller';
import { LandingAdminController } from './api/landing-admin.controller';
import { StrategiesController } from './api/strategies.controller';
import { ForwardRoutesController } from './api/forward-routes.controller';
import { AuthModule } from '../auth/auth.module';
import { ContentRunwayModule } from '../common/content-runway/content-runway.module';

@Global()
@Module({
  imports: [NestConfigModule, DatabaseModule, TrackingModule, AuthModule, ContentRunwayModule],
  controllers: [MyBotsController, MtprotoSessionsController, TelegraphAccountsController, MetaAccountsController, MetaCrosspostsController, StrategiesController, ForwardRoutesController, TikTokAccountsController, TikTokOAuthController, LandingController, LandingAdminController],
  providers: [
    ChannelConfigService,
    ConfigCacheService,
    ConfigEventsPublisher,
    JsonImporterService,
    MyBotsRepository,
    MtprotoSessionsRepository,
    MtprotoVerifyClient,
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
    TikTokAccountsRepository,
    TikTokTokenService,
    TikTokOAuthService,
    LandingResourcesService,
  ],
  exports: [
    ChannelConfigService,
    ConfigCacheService,
    ConfigEventsPublisher,
    MyBotsRepository,
    MtprotoSessionsRepository,
    TrackedChannelsConfigRepository,
    StrategyBindingsRepository,
    StrategyRunsRepository,
    ForwardRoutesRepository,
    TelegraphAccountsRepository,
    MetaAccountsRepository,
    MetaGraphClient,
    MetaCrosspostTargetsRepository,
    TikTokAccountsRepository,
    TikTokTokenService,
  ],
})
export class ChannelConfigModule {}
