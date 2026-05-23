import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { RedisProvider, REDIS_CLIENT } from './redis.provider';
import { TrackingQueueService } from './tracking-queue.service';
import { TrackingMtprotoClient } from './mtproto/tracking-mtproto.client';
import { TrackedChannelsRepository } from './repositories/tracked-channels.repository';
import { TrackedPostsRepository } from './repositories/tracked-posts.repository';
import { TrackedEdgesRepository } from './repositories/tracked-edges.repository';
import { TrackedRoiCacheRepository } from './repositories/tracked-roi-cache.repository';
import { PollMetaWorker } from './workers/poll-meta.worker';
import { PollPostsWorker } from './workers/poll-posts.worker';
import { RefreshMetricsWorker } from './workers/refresh-metrics.worker';
import { ResolveDiscoveryWorker } from './workers/resolve-discovery.worker';
import { TrackingScheduler } from './tracking.scheduler';
import { TrackingService } from './api/tracking.service';
import { TrackingController } from './api/tracking.controller';
import { TrackingAuthGuard } from './api/tracking-auth.guard';
import { RoiAnalyzerService } from './processors/roi-analyzer.service';

@Module({
  imports: [ConfigModule, AuthModule],
  controllers: [TrackingController],
  providers: [
    RedisProvider,
    TrackingQueueService,
    TrackingMtprotoClient,
    TrackedChannelsRepository,
    TrackedPostsRepository,
    TrackedEdgesRepository,
    TrackedRoiCacheRepository,
    PollMetaWorker,
    PollPostsWorker,
    RefreshMetricsWorker,
    ResolveDiscoveryWorker,
    TrackingScheduler,
    TrackingService,
    TrackingAuthGuard,
    RoiAnalyzerService,
  ],
  exports: [REDIS_CLIENT],
})
export class TrackingModule {}
