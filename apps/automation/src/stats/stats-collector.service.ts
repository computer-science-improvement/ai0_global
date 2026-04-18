import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService }     from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import { ChannelConfigService } from '../config/channel-config.service';
import { PublicationsRepository } from './publications.repository';
import { TelegramStatsClient }    from './telegram-stats.client';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Hourly job that:
 *  1. snapshots subscribers + metadata for every configured Telegram channel
 *  2. snapshots views/reactions/forwards for every published post younger
 *     than STATS_POST_AGE_DAYS (default 30).
 *
 * Uses gramjs via TelegramStatsClient. If the client is disabled (missing
 * creds), the cron no-ops so the rest of the app stays healthy.
 */
@Injectable()
export class StatsCollectorService {
  private readonly logger = new Logger(StatsCollectorService.name);
  private running = false;

  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly config:      ConfigService,
    private readonly channels:    ChannelConfigService,
    private readonly publications: PublicationsRepository,
    private readonly tg:          TelegramStatsClient,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async hourly(): Promise<void> {
    await this.runOnce();
  }

  /**
   * Public entry for manual POST /stats/refresh.
   * Returns a short summary string.
   */
  async runOnce(): Promise<{ channels: number; posts: number; skipped: boolean }> {
    if (!this.tg.isEnabled()) {
      this.logger.debug('Collector skipped: TelegramStatsClient disabled');
      return { channels: 0, posts: 0, skipped: true };
    }
    if (this.running) {
      this.logger.warn('Collector already running — skip');
      return { channels: 0, posts: 0, skipped: true };
    }
    this.running = true;
    const started = Date.now();
    let chCount = 0;
    let postCount = 0;

    try {
      // ── 1. Channel snapshots ────────────────────────────────────────────
      const channelIds = this.channels.listChannels();
      for (const channelId of channelIds) {
        const info = await this.tg.getChannelInfo(channelId);
        if (!info) continue;
        await this.pool.query(
          `INSERT INTO channel_stats_snapshots
             (channel_id, subscribers, title, description, online_count)
           VALUES ($1, $2, $3, $4, $5)`,
          [channelId, info.subscribers, info.title, info.description, info.onlineCount],
        );
        chCount++;
        await sleep(200);
      }

      // ── 2. Post snapshots ───────────────────────────────────────────────
      const ageDays = parseInt(
        this.config.get<string>('STATS_POST_AGE_DAYS') ?? '30',
        10,
      ) || 30;
      const posts = await this.publications.listRecent(null, ageDays);
      for (const post of posts) {
        const m = await this.tg.getPostMetrics(post.channelId, post.messageId);
        if (!m) continue;
        await this.pool.query(
          `INSERT INTO post_stats_snapshots
             (post_id, views, forwards, replies, reactions, reactions_total)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [post.id, m.views, m.forwards, m.replies, m.reactions, m.reactionsTotal],
        );
        postCount++;
        await sleep(200);
      }

      this.logger.log(
        `Collector: ${chCount} channel snapshots, ${postCount} post snapshots in ${Date.now() - started}ms`,
      );
      return { channels: chCount, posts: postCount, skipped: false };
    } catch (err: any) {
      this.logger.error(`Collector run failed: ${err.message}`);
      return { channels: chCount, posts: postCount, skipped: false };
    } finally {
      this.running = false;
    }
  }
}
