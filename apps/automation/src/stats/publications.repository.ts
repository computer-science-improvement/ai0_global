import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';

export interface PublicationRecord {
  id:            number;
  channelId:     string;
  messageId:     number;
  sourceUrl:     string | null;
  title:         string | null;
  strategyType:  string | null;
  tags:          string[] | null;
  postedAt:      Date;
}

export interface InsertPublicationInput {
  channelId:    string;
  messageId:    string | number;
  sourceUrl?:   string | null;
  title?:       string | null;
  strategyType?: string | null;
  tags?:        string[] | null;
}

/**
 * Persists every successful publication so the stats-collector can later
 * query per-post metrics from Telegram. Writes are fire-and-forget from the
 * strategy's point of view — any error is logged and swallowed so a DB blip
 * never blocks publishing.
 */
@Injectable()
export class PublicationsRepository {
  private readonly logger = new Logger(PublicationsRepository.name);

  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async insert(input: InsertPublicationInput): Promise<void> {
    const messageIdInt = parseInt(String(input.messageId), 10);
    if (!input.channelId || !Number.isFinite(messageIdInt)) {
      this.logger.warn(
        `Skipping publication insert: invalid channelId/messageId (${input.channelId}/${input.messageId})`,
      );
      return;
    }

    try {
      await this.pool.query(
        `INSERT INTO published_posts
           (channel_id, message_id, source_url, title, strategy_type, tags)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (channel_id, message_id) DO NOTHING`,
        [
          input.channelId,
          messageIdInt,
          input.sourceUrl  ?? null,
          input.title      ?? null,
          input.strategyType ?? null,
          input.tags       ?? null,
        ],
      );
    } catch (err: any) {
      this.logger.warn(`Failed to persist published post: ${err.message}`);
    }
  }

  async listRecent(channelId: string | null, sinceDays: number): Promise<PublicationRecord[]> {
    const params: unknown[] = [sinceDays];
    let where = `posted_at >= now() - ($1 || ' days')::interval`;
    if (channelId) {
      params.push(channelId);
      where += ` AND channel_id = $${params.length}`;
    }
    const { rows } = await this.pool.query(
      `SELECT id, channel_id, message_id, source_url, title, strategy_type, tags, posted_at
       FROM published_posts
       WHERE ${where}
       ORDER BY posted_at DESC`,
      params,
    );
    return rows.map(this.mapRow);
  }

  async listRecentHours(channelId: string, hours: number): Promise<PublicationRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT id, channel_id, message_id, source_url, title, strategy_type, tags, posted_at
       FROM published_posts
       WHERE channel_id = $1
         AND posted_at >= now() - ($2 || ' hours')::interval
       ORDER BY posted_at DESC`,
      [channelId, hours],
    );
    return rows.map(this.mapRow);
  }

  async listByChannel(channelId: string, limit: number, offset: number): Promise<PublicationRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT id, channel_id, message_id, source_url, title, strategy_type, tags, posted_at
       FROM published_posts
       WHERE channel_id = $1
       ORDER BY posted_at DESC
       LIMIT $2 OFFSET $3`,
      [channelId, limit, offset],
    );
    return rows.map(this.mapRow);
  }

  async getById(id: number): Promise<PublicationRecord | null> {
    const { rows } = await this.pool.query(
      `SELECT id, channel_id, message_id, source_url, title, strategy_type, tags, posted_at
       FROM published_posts
       WHERE id = $1`,
      [id],
    );
    return rows[0] ? this.mapRow(rows[0]) : null;
  }

  private mapRow = (r: any): PublicationRecord => ({
    id:           Number(r.id),
    channelId:    r.channel_id,
    messageId:    Number(r.message_id),
    sourceUrl:    r.source_url,
    title:        r.title,
    strategyType: r.strategy_type,
    tags:         r.tags,
    postedAt:     r.posted_at,
  });
}
