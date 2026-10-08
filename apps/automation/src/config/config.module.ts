// apps/automation/src/config/config.module.ts
import { Global, Logger, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule, ConfigService } from '@nestjs/config';
import { DB_POOL, DatabaseModule } from '../database/database.module';
import type { Pool } from 'pg';
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
import { MetaAccountGroupsRepository } from './meta-account-groups.repository';
import { MetaAccountGroupsController } from './api/meta-account-groups.controller';
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
import {
  LANDING_CONFIG, LANDING_CTA, LANDING_GATE, LANDING_LEADS, LANDING_NETWORKS, LANDING_PULSE, LandingController,
} from './api/landing.controller';
import { LandingCtaService } from './landing-cta.service';
import { LandingClientGate, resolveLandingSalt } from './landing-client-key';
import { LandingLeadsService } from './landing-leads.service';
import { OwnerInbox } from '../editor/agents/owner-inbox';
import { TelegramNotifier } from '../publishers/telegram-notifier.service';
import { LandingConfigService } from './landing-config.service';
import { LandingPulseService } from './landing-pulse.service';
import { LandingNetworksService } from './landing-networks.service';
import { YoutubeLandingRepository } from './youtube-landing.repository';
import { ResourceCatalog } from '../editor/agents/resource-catalog';
import { LandingAdminController } from './api/landing-admin.controller';
import { StrategiesController } from './api/strategies.controller';
import { ForwardRoutesController } from './api/forward-routes.controller';
import { AuthModule } from '../auth/auth.module';
import { ContentRunwayModule } from '../common/content-runway/content-runway.module';

@Global()
@Module({
  imports: [NestConfigModule, DatabaseModule, TrackingModule, AuthModule, ContentRunwayModule],
  controllers: [MyBotsController, MtprotoSessionsController, TelegraphAccountsController, MetaAccountsController, MetaAccountGroupsController, MetaCrosspostsController, StrategiesController, ForwardRoutesController, TikTokAccountsController, TikTokOAuthController, LandingController, LandingAdminController],
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
    MetaAccountGroupsRepository,
    MetaGraphClient,
    MetaCrosspostTargetsRepository,
    TikTokAccountsRepository,
    TikTokTokenService,
    TikTokOAuthService,
    YoutubeLandingRepository,
    LandingResourcesService,
    // Spec 026: the public page settings (app_settings landing.*) and the live autonomy proof.
    { provide: LANDING_CONFIG, inject: [DB_POOL], useFactory: (pool: Pool) => new LandingConfigService(pool) },
    {
      provide: LANDING_PULSE, inject: [DB_POOL],
      useFactory: (pool: Pool) => {
        const logger = new Logger('LandingPulse');
        return new LandingPulseService(pool, { log: (m) => logger.warn(m) });
      },
    },
    {
      // FR-006: the showcase grouped by network. The catalog needs only the pool here
      // (no live Telegram access check: the landing never calls a platform API).
      provide: LANDING_NETWORKS, inject: [DB_POOL, LandingResourcesService, LANDING_CONFIG],
      useFactory: (pool: Pool, resources: LandingResourcesService, config: LandingConfigService) =>
        new LandingNetworksService({ pool, resources, catalog: new ResourceCatalog({ pool }), adDm: () => config.adDm() }),
    },
    // FR-009: anonymous CTA click counters + the owner's CTA stats.
    { provide: LANDING_CTA, inject: [DB_POOL], useFactory: (pool: Pool) => new LandingCtaService(pool) },
    {
      // FR-009/FR-011: the salted client hash and the per-client limits of the public writes (no IP is stored).
      provide: LANDING_GATE, inject: [ConfigService],
      useFactory: (cfg: ConfigService) => {
        const { salt, persistent } = resolveLandingSalt((k) => cfg.get<string>(k) ?? undefined);
        if (!persistent) new Logger('LandingGate').warn('PROMO_HASH_SALT / TOKEN_ENCRYPTION_KEY not set — lead dedup resets on restart');
        return new LandingClientGate(salt);
      },
    },
    {
      // FR-011: lead intake. A new lead posts one OwnerInbox item (no name/contact in it) and an
      // admin-bot alert to the owner. TelegramNotifier is optional: without it the item is still stored.
      provide: LANDING_LEADS,
      inject: [DB_POOL, ConfigService, LANDING_GATE, LANDING_CONFIG, { token: TelegramNotifier, optional: true }],
      useFactory: (pool: Pool, cfg: ConfigService, gate: LandingClientGate, config: LandingConfigService, notifier?: TelegramNotifier) => {
        const logger = new Logger('LandingLeads');
        const inbox = new OwnerInbox(pool, notifier ? (t) => notifier.notifyAlert(t) : async () => {}, cfg.get<string>('DASHBOARD_URL') ?? null);
        return new LandingLeadsService({ pool, gate, config, inbox, log: (m) => logger.warn(m) });
      },
    },
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
    MetaAccountGroupsRepository,
    MetaGraphClient,
    MetaCrosspostTargetsRepository,
    TikTokAccountsRepository,
    TikTokTokenService,
    LANDING_CONFIG,
  ],
})
export class ChannelConfigModule {}
