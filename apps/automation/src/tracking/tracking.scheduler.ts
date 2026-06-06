import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { TrackedChannelsRepository } from './repositories/tracked-channels.repository';
import { TrackedPostsRepository } from './repositories/tracked-posts.repository';
import { TrackingQueueService } from './tracking-queue.service';
import { SettingsService } from '../settings/settings.service';
import { classifyTier } from './processors/tier-classifier';
import { PollTier } from './types';

@Injectable()
export class TrackingScheduler {
  private readonly logger = new Logger(TrackingScheduler.name);
  private readonly batchSize: number;

  constructor(
    private readonly config:   ConfigService,
    private readonly channels: TrackedChannelsRepository,
    private readonly posts:    TrackedPostsRepository,
    private readonly queue:    TrackingQueueService,
    private readonly settings: SettingsService,
  ) {
    this.batchSize = parseInt(config.get<string>('TRACKING_BATCH_SIZE') ?? '50', 10);
  }

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'tracking.tier-hot' })
  async pollHot(): Promise<void> {
    if (!this.enabled()) return;
    await this.enqueueTier('hot', 5);
  }

  @Cron('*/30 * * * *', { name: 'tracking.tier-warm' })
  async pollWarm(): Promise<void> {
    if (!this.enabled()) return;
    await this.enqueueTier('warm', 30);
  }

  @Cron('0 */6 * * *', { name: 'tracking.tier-cold' })
  async pollCold(): Promise<void> {
    if (!this.enabled()) return;
    await this.enqueueTier('cold', 360);
  }

  /** Daily recompute of poll_tier based on last-7-day post count. */
  @Cron('30 3 * * *', { name: 'tracking.recompute-tiers' })
  async recomputeTiers(): Promise<void> {
    if (!this.enabled()) return;
    const all = await this.channels.list({ limit: 10_000, offset: 0 });
    for (const ch of all.items) {
      const postsLast7d = await this.posts.countLast7Days(ch.id);
      const daysSinceAdded = Math.floor((Date.now() - ch.addedAt.getTime()) / 86_400_000);
      const newTier = classifyTier({ postsLast7d, daysSinceAdded });
      if (newTier !== ch.pollTier && ch.username) {
        await this.channels.upsertByUsername({
          username: ch.username,
          pollTier: newTier,
        });
        this.logger.debug(`tier change: ${ch.username} ${ch.pollTier} → ${newTier}`);
      }
    }
  }

  private async enqueueTier(tier: PollTier, intervalMin: number): Promise<void> {
    const olderThan = new Date(Date.now() - intervalMin * 60_000);
    const due = await this.channels.listForPolling(tier, olderThan, this.batchSize);
    for (const ch of due) {
      await this.queue.addPollMeta({ channelId: ch.id });
      await this.queue.addPollPosts({ channelId: ch.id });
    }
    if (due.length) this.logger.debug(`tier ${tier}: enqueued ${due.length} channels`);
  }

  private enabled(): boolean {
    return this.settings.trackingEnabled();
  }
}
