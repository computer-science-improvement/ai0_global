import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Job } from 'bullmq';
import { TrackingQueueService } from '../tracking-queue.service';
import { TrackedChannelsRepository } from '../repositories/tracked-channels.repository';
import { TrackedPostsRepository } from '../repositories/tracked-posts.repository';
import { TrackedEdgesRepository } from '../repositories/tracked-edges.repository';
import { TrackingMtprotoClient } from '../mtproto/tracking-mtproto.client';
import { extractAdRefs } from '../processors/ad-ref-extractor';
import { TRACKING_QUEUES, PollPostsJob } from '../types';

@Injectable()
export class PollPostsWorker implements OnModuleInit {
  private readonly logger = new Logger(PollPostsWorker.name);

  constructor(
    private readonly queue:    TrackingQueueService,
    private readonly channels: TrackedChannelsRepository,
    private readonly posts:    TrackedPostsRepository,
    private readonly edges:    TrackedEdgesRepository,
    private readonly mtproto:  TrackingMtprotoClient,
  ) {}

  onModuleInit(): void {
    this.queue.registerWorker<PollPostsJob>(TRACKING_QUEUES.POLL_POSTS, (job) => this.handle(job), 5);
  }

  private async handle(job: Job<PollPostsJob>): Promise<void> {
    const channel = await this.channels.getById(job.data.channelId);
    if (!channel) return;
    if (channel.trackingStatus === 'not_subscribed') return; // session can't read it — poll-meta re-checks for recovery
    const target = channel.tgChatId ?? channel.username;
    if (!target) return;

    const sinceId = await this.posts.getMaxMessageId(channel.id);
    const msgs    = await this.mtproto.getHistory(target, sinceId, 50);
    if (msgs.length === 0) return;

    for (const m of msgs) {
      const adRefs = extractAdRefs({
        text:                m.text,
        entities:            m.entities,
        forwardFromUsername: m.forwardFromUsername,
      });
      await this.posts.upsert({
        channelId:      channel.id,
        tgMessageId:    m.id,
        text:           m.text,
        hasMedia:       m.hasMedia,
        mediaType:      m.mediaType,
        postedAt:       m.date,
        views:          m.views,
        forwards:       m.forwards,
        reactionsTotal: m.reactionsTotal,
        reactions:      m.reactions,
        commentsCount:  m.replies,
        adRefs:         adRefs.length ? adRefs : null,
      });

      for (const ref of adRefs) {
        if (ref.kind === 'tg_channel' || ref.kind === 'tg_user') {
          const existing = await this.channels.getByUsername(ref.username);
          await this.edges.upsertSeen({
            sourceChannelId: channel.id,
            targetUsername:  ref.username,
            targetKind:      ref.kind,
            targetChannelId: existing?.id ?? null,
            seenAt:          m.date,
          });
          if (!existing) {
            await this.queue.addResolveDiscovery({ username: ref.username, sourceChannelId: channel.id });
          }
        } else if (ref.kind === 'tg_invite') {
          // Private-channel invite link. The hash becomes the target_username
          // for the edge (uniqueness is the same as a regular @username); a
          // separate resolve-discovery job calls checkChatInvite() to create
          // the corresponding tracked_channels row keyed by 'invite:<hash>'.
          const inviteKey = `invite:${ref.hash}`;
          const existing  = await this.channels.getByChannelKey(inviteKey);
          await this.edges.upsertSeen({
            sourceChannelId: channel.id,
            targetUsername:  ref.hash,
            targetKind:      'tg_invite',
            targetChannelId: existing?.id ?? null,
            seenAt:          m.date,
          });
          if (!existing) {
            await this.queue.addResolveDiscovery({
              username:        ref.hash, // used by linkResolvedTarget
              sourceChannelId: channel.id,
              inviteHash:      ref.hash,
            });
          }
        } else if (ref.kind === 'instagram' || ref.kind === 'web') {
          await this.edges.upsertSeen({
            sourceChannelId: channel.id,
            targetUsername:  ref.kind === 'instagram' ? ref.username : ref.domain,
            targetKind:      ref.kind,
            targetChannelId: null,
            seenAt:          m.date,
          });
        }
      }
    }
    this.logger.debug(`poll-posts ${channel.username ?? channel.id}: ${msgs.length} new posts`);
  }
}
