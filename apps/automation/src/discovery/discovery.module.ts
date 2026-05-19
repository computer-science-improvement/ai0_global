// apps/automation/src/discovery/discovery.module.ts
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { TrackingModule } from '../tracking/tracking.module';
import { TeleAdsClient } from './teleads/teleads.client';
import { TeleAdsIngestionWorker } from './teleads/teleads-ingestion.worker';
import { CandidateChannelsRepository } from './repositories/candidate-channels.repository';
import { ChannelThemesRepository } from './repositories/channel-themes.repository';
import { RecommendationsService } from './recommendations/recommendations.service';
import { DiscoveryController } from './api/discovery.controller';

@Module({
  imports: [DatabaseModule, TrackingModule],
  controllers: [DiscoveryController],
  providers: [
    TeleAdsClient,
    TeleAdsIngestionWorker,
    CandidateChannelsRepository,
    ChannelThemesRepository,
    RecommendationsService,
  ],
  exports: [
    CandidateChannelsRepository,
    ChannelThemesRepository,
  ],
})
export class DiscoveryModule {}
