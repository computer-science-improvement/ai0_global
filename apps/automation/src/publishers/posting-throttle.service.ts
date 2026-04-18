import { Injectable, Logger } from '@nestjs/common';

const COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Per-channel in-memory cooldown between publications.
 * Each channel has its own independent 15-minute cooldown.
 */
@Injectable()
export class PostingThrottleService {
  private readonly logger = new Logger(PostingThrottleService.name);
  private readonly lastPublishedAt = new Map<string, number>();

  canPublish(channelId: string): boolean {
    const last = this.lastPublishedAt.get(channelId);
    if (last === undefined) return true;
    return Date.now() - last >= COOLDOWN_MS;
  }

  recordPublish(channelId: string): void {
    this.lastPublishedAt.set(channelId, Date.now());
  }

  remainingMs(channelId: string): number {
    const last = this.lastPublishedAt.get(channelId);
    if (last === undefined) return 0;
    return Math.max(0, COOLDOWN_MS - (Date.now() - last));
  }

  logCooldown(strategyId: string, channelId: string): void {
    const remaining = Math.ceil(this.remainingMs(channelId) / 1000 / 60);
    this.logger.debug(`[${strategyId}] Skipped — cooldown active for ${channelId}, ${remaining}min remaining`);
  }
}
