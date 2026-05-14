import { Injectable, Inject, Optional, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../../database/database.module';
import { TelegramNotifier } from '../../publishers/telegram-notifier.service';
import { PublicationsRepository } from '../../stats/publications.repository';

export interface LogSuccessMeta {
  title?:        string | null;
  strategyType?: string | null;
  tags?:         string[] | null;
}

@Injectable()
export class BotLoggerService {
  private readonly logger = new Logger(BotLoggerService.name);

  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Optional() private readonly notifier: TelegramNotifier,
    @Optional() private readonly publications: PublicationsRepository,
  ) {}

  /**
   * Returns true if this source URL was successfully published to ANY
   * channel. Mirrors DedupService's global-scope policy: a source posted
   * anywhere is treated as already published everywhere. The strategies
   * call this as a belt-and-suspenders check right before publish to
   * close the race window between filterUnposted and the actual send.
   *
   * channelId is kept in the signature for future per-channel logging
   * but is no longer part of the SQL filter.
   */
  async hasLog(sourceUrl: string, channelId: string): Promise<boolean> {
    void channelId; // intentionally unused — global dedup scope
    const { rows } = await this.pool.query(
      `SELECT 1 FROM bot_logs
       WHERE source_url = $1 AND type = 'success'
       LIMIT 1`,
      [sourceUrl],
    );
    return rows.length > 0;
  }

  async logSuccess(
    sourceUrl: string,
    channelId: string,
    messageId: string,
    meta: LogSuccessMeta = {},
  ): Promise<void> {
    await this.insert(sourceUrl, channelId, 'success', null);
    this.logger.log(`[${channelId}] published: ${sourceUrl}`);
    await this.notifier?.notifyPublished(channelId, messageId);
    await this.publications?.insert({
      channelId,
      messageId,
      sourceUrl,
      title:        meta.title ?? null,
      strategyType: meta.strategyType ?? null,
      tags:         meta.tags ?? null,
    });
  }

  async logError(sourceUrl: string, channelId: string, message: string): Promise<void> {
    await this.insert(sourceUrl, channelId, 'error', message);
    this.logger.warn(`[${channelId}] error for ${sourceUrl}: ${message}`);
    await this.notifier?.notifyFailed(channelId, message, sourceUrl);
  }

  private async insert(
    sourceUrl: string,
    channelId: string,
    type: 'success' | 'error',
    message: string | null,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO bot_logs (source_url, channel_id, type, message) VALUES ($1, $2, $3, $4)`,
      [sourceUrl, channelId, type, message],
    );
  }
}
