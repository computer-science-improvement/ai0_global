import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Job } from 'bullmq';
import { TrackingQueueService } from '../tracking-queue.service';
import { TrackedChannelsRepository } from '../repositories/tracked-channels.repository';
import { TrackingMtprotoClient } from '../mtproto/tracking-mtproto.client';
import { TRACKING_QUEUES, PollMetaJob } from '../types';

@Injectable()
export class PollMetaWorker implements OnModuleInit {
  private readonly logger = new Logger(PollMetaWorker.name);

  constructor(
    private readonly queue:    TrackingQueueService,
    private readonly channels: TrackedChannelsRepository,
    private readonly mtproto:  TrackingMtprotoClient,
  ) {}

  onModuleInit(): void {
    this.queue.registerWorker<PollMetaJob>(
      TRACKING_QUEUES.POLL_META,
      (job) => this.handle(job),
      3,
    );
  }

  private async handle(job: Job<PollMetaJob>): Promise<void> {
    const channel = await this.channels.getById(job.data.channelId);
    if (!channel) { this.logger.debug(`channel ${job.data.channelId} disappeared`); return; }

    const target = channel.tgChatId ?? channel.username;
    if (!target) { this.logger.warn(`channel ${channel.id} has neither tgChatId nor username`); return; }

    const meta = await this.mtproto.getFullChannel(target);
    if (!meta) { this.logger.debug(`getFullChannel returned null for ${target}`); return; }

    await this.channels.upsertByUsername({
      username:  meta.username ?? channel.username ?? undefined as any,
      tgChatId:  meta.tgChatId,
      title:     meta.title,
      about:     meta.about,
      subsCount: meta.subsCount,
    });
    await this.channels.markPolled(channel.id, meta.subsCount, new Date());
    this.logger.debug(`poll-meta ok: ${target} subs=${meta.subsCount}`);
  }
}
