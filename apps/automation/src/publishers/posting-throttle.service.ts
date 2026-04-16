import { Injectable, Logger } from '@nestjs/common';

const COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Global in-memory cooldown between publications.
 * Prevents two strategies from posting at the same time slot.
 */
@Injectable()
export class PostingThrottleService {
  private readonly logger = new Logger(PostingThrottleService.name);
  private lastPublishedAt: number | null = null;

  canPublish(): boolean {
    if (this.lastPublishedAt === null) return true;
    return Date.now() - this.lastPublishedAt >= COOLDOWN_MS;
  }

  recordPublish(): void {
    this.lastPublishedAt = Date.now();
  }

  remainingMs(): number {
    if (this.lastPublishedAt === null) return 0;
    return Math.max(0, COOLDOWN_MS - (Date.now() - this.lastPublishedAt));
  }

  logCooldown(strategyId: string): void {
    const remaining = Math.ceil(this.remainingMs() / 1000 / 60);
    this.logger.debug(`[${strategyId}] Skipped — cooldown active, ${remaining}min remaining`);
  }
}
