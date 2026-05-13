import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Job } from 'bullmq';
import { TrackingQueueService } from '../tracking-queue.service';
import { TrackedChannelsRepository } from '../repositories/tracked-channels.repository';
import { TrackedEdgesRepository } from '../repositories/tracked-edges.repository';
import { TrackingMtprotoClient } from '../mtproto/tracking-mtproto.client';
import { TRACKING_QUEUES, ResolveDiscoveryJob } from '../types';

@Injectable()
export class ResolveDiscoveryWorker implements OnModuleInit {
  private readonly logger = new Logger(ResolveDiscoveryWorker.name);

  constructor(
    private readonly queue:    TrackingQueueService,
    private readonly channels: TrackedChannelsRepository,
    private readonly edges:    TrackedEdgesRepository,
    private readonly mtproto:  TrackingMtprotoClient,
  ) {}

  onModuleInit(): void {
    this.queue.registerWorker<ResolveDiscoveryJob>(
      TRACKING_QUEUES.RESOLVE_DISCOVERY,
      (job) => this.handle(job),
      1,
    );
  }

  private async handle(job: Job<ResolveDiscoveryJob>): Promise<void> {
    const { username } = job.data;
    const existing = await this.channels.getByUsername(username);
    if (existing) {
      await this.edges.linkResolvedTarget(username, existing.id);
      return;
    }
    const resolved = await this.mtproto.resolveUsername(username);
    if (!resolved) {
      this.logger.debug(`resolve-discovery: ${username} unresolved`);
      return;
    }
    const id = await this.channels.upsertByUsername({
      username: resolved.username,
      tgChatId: resolved.tgChatId || null,
      title:    resolved.title,
      isClosed: resolved.isClosed,
      pollTier: 'cold',
    });
    await this.edges.linkResolvedTarget(username, id);

    if (!resolved.isClosed) {
      await this.queue.addPollMeta({ channelId: id });
    }
    this.logger.debug(`resolve-discovery: ${username} → ${resolved.isClosed ? 'closed' : 'tracked'}`);
  }
}
