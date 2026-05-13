import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RedisProvider } from './redis.provider';
import { TrackingQueueService } from './tracking-queue.service';
import { TrackingMtprotoClient } from './mtproto/tracking-mtproto.client';
import { TrackedChannelsRepository } from './repositories/tracked-channels.repository';
import { TrackedPostsRepository } from './repositories/tracked-posts.repository';
import { TrackedEdgesRepository } from './repositories/tracked-edges.repository';
import { PollMetaWorker } from './workers/poll-meta.worker';
import { PollPostsWorker } from './workers/poll-posts.worker';
import { RefreshMetricsWorker } from './workers/refresh-metrics.worker';
import { ResolveDiscoveryWorker } from './workers/resolve-discovery.worker';
import { TrackingScheduler } from './tracking.scheduler';
import { TrackingService } from './api/tracking.service';
import { TrackingController } from './api/tracking.controller';
import { TrackingAuthGuard } from './api/tracking-auth.guard';

@Module({
  imports: [ConfigModule],
  controllers: [TrackingController],
  providers: [
    RedisProvider,
    TrackingQueueService,
    TrackingMtprotoClient,
    TrackedChannelsRepository,
    TrackedPostsRepository,
    TrackedEdgesRepository,
    PollMetaWorker,
    PollPostsWorker,
    RefreshMetricsWorker,
    ResolveDiscoveryWorker,
    TrackingScheduler,
    TrackingService,
    TrackingAuthGuard,
  ],
})
export class TrackingModule {}
