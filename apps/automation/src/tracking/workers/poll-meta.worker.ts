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

    // Invite-link discovered channels — we don't have a chat id to
    // pass to getFullChannel, but checkChatInvite does the same job
    // without requiring membership. Re-poll refreshes title + subs.
    if (channel.channelKey?.startsWith('invite:')) {
      await this.refreshInvite(channel.id, channel.channelKey.slice('invite:'.length));
      return;
    }

    const target = channel.tgChatId ?? channel.username;
    if (!target) { this.logger.warn(`channel ${channel.id} has neither tgChatId nor username`); return; }

    const meta = await this.mtproto.getFullChannel(target);
    if (meta === 'not_subscribed') {
      await this.channels.setTrackingStatus(channel.id, 'not_subscribed');
      await this.channels.markPolled(channel.id, null, new Date()); // advance tier rotation
      this.logger.debug(`poll-meta: ${target} not subscribed — flagged`);
      return;
    }
    if (!meta) { this.logger.debug(`getFullChannel returned null for ${target}`); return; }

    // Update the existing channel row directly by id. The previous version
    // called upsertByUsername, which for private channels (meta.username =
    // null) bypassed the WHERE username IS NOT NULL partial unique index and
    // inserted a brand-new orphan row each poll cycle — title set,
    // channel_key null, is_mine false. patch() targets the row we already
    // loaded, no insert path possible.
    //
    // tg_chat_id intentionally NOT updated here. The id we stored
    // (-1003984251759 — Bot API format) and the id MTProto returns
    // (3984251759 — raw channel id) describe the same channel but in
    // different namespaces. Overwriting our Bot-API-format id with the
    // MTProto raw id would break publishing.
    await this.channels.patch(channel.id, {
      title: meta.title ?? null,
      about: meta.about ?? null,
    });
    await this.channels.markPolled(channel.id, meta.subsCount, new Date());
    await this.channels.setTrackingStatus(channel.id, 'ok');
    this.logger.debug(`poll-meta ok: ${target} subs=${meta.subsCount}`);
  }

  /**
   * Refresh an invite-link discovered channel. Calls checkChatInvite to
   * get fresh title + participants_count; if the session has joined since
   * the original peek, we'll also pick up the real chat id and start
   * polling posts on the next cycle.
   */
  private async refreshInvite(channelId: string, hash: string): Promise<void> {
    const info = await this.mtproto.checkInvite(hash);
    if (!info) {
      this.logger.debug(`poll-meta invite ${hash.slice(0, 8)}… unresolved`);
      // Still mark polled so the tier rotation moves on — otherwise this
      // channel hogs every batch with "never-polled-first" priority.
      await this.channels.markPolled(channelId, null, new Date());
      return;
    }
    await this.channels.upsertInviteChannel({
      hash,
      title:     info.title,
      subsCount: info.subsCount,
      tgChatId:  info.tgChatId,
    });
    await this.channels.markPolled(channelId, info.subsCount, new Date());
    await this.channels.setTrackingStatus(channelId, 'ok');
    this.logger.debug(
      `poll-meta invite ${hash.slice(0, 8)}… subs=${info.subsCount} ` +
      `${info.alreadyJoined ? '(joined)' : '(peeked)'}`,
    );
  }
}
