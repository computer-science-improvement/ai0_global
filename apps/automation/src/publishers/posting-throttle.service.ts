import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SettingsService } from '../settings/settings.service';

/**
 * Two-stage per-channel coordination:
 *
 *   1. **Lock** (in-flight set) — exclusive access while a strategy is
 *      mid-pipeline (fetching, generating with AI, publishing). Prevents
 *      the parallel-cron race where N strategies for the same channel
 *      all pass the cooldown check in the same tick, all spend ~10s
 *      generating, and all publish — producing duplicate posts.
 *
 *   2. **Cooldown** (timestamp of last successful publish) — ensures a
 *      minimum gap between actual publications regardless of how often
 *      strategies trigger. POSTING_COOLDOWN_MIN env var (default 20 min)
 *      controls the window.
 *
 * Critical invariant: a "skip" without a publish (e.g. semantic-dedup
 * returned DUPLICATE) MUST release the lock without bumping the cooldown
 * timestamp — otherwise channels get blocked for 20 min every time RSS
 * happens to return only duplicates.
 *
 * Usage:
 *   if (!throttle.tryLock(channelId)) return;  // someone else / cooldown active
 *   try {
 *     const published = await runStrategy(...);
 *     if (published) throttle.recordPublish(channelId);
 *     else            throttle.releaseLock(channelId);
 *   } catch (err) {
 *     throttle.releaseLock(channelId);
 *   }
 */
@Injectable()
export class PostingThrottleService {
  private readonly logger = new Logger(PostingThrottleService.name);
  private readonly locks  = new Set<string>();
  private readonly lastPublishedAt = new Map<string, number>();

  constructor(
    @Optional() private readonly settings?: SettingsService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  /** Cooldown window in ms, read live so dashboard edits to POSTING_COOLDOWN_MIN
   *  take effect on the next publish check (no restart). Falls back to env when
   *  the settings service isn't injected (e.g. unit tests). */
  private cooldownMs(): number {
    const minutes = this.settings
      ? this.settings.postingCooldownMin()
      : Math.max(1, parseInt(this.config?.get<string>('POSTING_COOLDOWN_MIN') ?? '20', 10));
    return minutes * 60_000;
  }

  /**
   * Combined check: is the channel both free of any in-flight strategy AND
   * past its post-publish cooldown? Used for diagnostic UI (admin bot,
   * preview).
   */
  canPublish(channelId: string): boolean {
    if (this.locks.has(channelId)) return false;
    const last = this.lastPublishedAt.get(channelId);
    if (last === undefined) return true;
    return Date.now() - last >= this.cooldownMs();
  }

  /**
   * Synchronously acquire the in-flight lock if no one else holds it AND
   * the cooldown window has passed. Returns true if the caller now owns
   * the slot — they MUST call recordPublish() or releaseLock() to free it.
   */
  tryLock(channelId: string): boolean {
    if (!this.canPublish(channelId)) return false;
    this.locks.add(channelId);
    return true;
  }

  /**
   * Successful publish: record the timestamp (resets cooldown) and free
   * the lock. Always call this from the publisher AFTER Telegram ACKs.
   */
  recordPublish(channelId: string): void {
    this.lastPublishedAt.set(channelId, Date.now());
    this.locks.delete(channelId);
  }

  /**
   * Strategy decided to skip (dedup, SKIP_POST signal, fetch returned
   * nothing, AI failed transiently). Free the lock so the next cron tick
   * can immediately re-evaluate. Does NOT touch the cooldown timestamp.
   */
  releaseLock(channelId: string): void {
    this.locks.delete(channelId);
  }

  remainingMs(channelId: string): number {
    const last = this.lastPublishedAt.get(channelId);
    if (last === undefined) return 0;
    return Math.max(0, this.cooldownMs() - (Date.now() - last));
  }

  logCooldown(strategyId: string, channelId: string): void {
    const remaining = Math.ceil(this.remainingMs(channelId) / 1000 / 60);
    const locked = this.locks.has(channelId);
    const reason = locked ? 'in-flight strategy' : `${remaining}min cooldown`;
    this.logger.debug(`[${strategyId}] Skipped — ${reason} on ${channelId}`);
  }
}
