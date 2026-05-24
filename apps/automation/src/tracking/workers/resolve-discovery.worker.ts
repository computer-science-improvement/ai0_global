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
    // Branch on which discovery flavor was queued. Public @username path
    // and t.me/+invite-hash path share the same queue but resolve through
    // different MTProto calls.
    if (job.data.inviteHash) {
      await this.handleInvite(job.data.inviteHash);
      return;
    }
    await this.handleUsername(job.data.username);
  }

  // ── @username path ──────────────────────────────────────────────────

  private async handleUsername(username: string): Promise<void> {
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

  // ── t.me/+invite-hash path ──────────────────────────────────────────

  /**
   * Resolve a private channel via its invite hash WITHOUT joining. Calls
   * checkChatInvite which returns title + photo + participants_count for
   * non-joined channels, or the full Chat object if the session is
   * already a member. Either way we get enough to create a node in the
   * graph; the hash is stored as channel_key='invite:<hash>' so future
   * mentions of the same link dedupe onto the same row.
   */
  private async handleInvite(hash: string): Promise<void> {
    const inviteKey = `invite:${hash}`;
    const existing  = await this.channels.getByChannelKey(inviteKey);
    if (existing) {
      // Edge already linked at upsertSeen time; refresh metadata anyway.
      const info = await this.mtproto.checkInvite(hash);
      if (info) {
        await this.channels.upsertInviteChannel({
          hash,
          title:     info.title,
          subsCount: info.subsCount,
          tgChatId:  info.tgChatId,
        });
      }
      return;
    }
    const info = await this.mtproto.checkInvite(hash);
    if (!info) {
      this.logger.debug(`resolve-discovery: invite ${hash.slice(0, 8)}… unresolved`);
      return;
    }
    const id = await this.channels.upsertInviteChannel({
      hash,
      title:     info.title,
      subsCount: info.subsCount,
      tgChatId:  info.tgChatId,
    });
    // tracked_ad_edges stored target_username = hash (poll-posts side),
    // so linkResolvedTarget by hash backfills target_channel_id.
    await this.edges.linkResolvedTarget(hash, id);

    this.logger.debug(
      `resolve-discovery: invite ${hash.slice(0, 8)}… → ` +
      `"${info.title ?? '(no title)'}" subs=${info.subsCount} ` +
      `${info.alreadyJoined ? 'joined' : 'peeked'}`,
    );
  }
}
