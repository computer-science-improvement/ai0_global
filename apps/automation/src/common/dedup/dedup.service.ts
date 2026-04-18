import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../../database/database.module';
import { RawItem } from '../types';
import { StructuredLoggerService } from '../logging/structured-logger.service';

@Injectable()
export class DedupService {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly structured: StructuredLoggerService,
  ) {}

  /** Filter out items already posted to this channel */
  async filterUnposted(items: RawItem[], channelId: string): Promise<RawItem[]> {
    if (!items.length) return [];

    const urls = items.map((i) => i.source);
    const { rows } = await this.pool.query(
      `SELECT source_url FROM posted_news WHERE source_url = ANY($1) AND channel_id = $2`,
      [urls, channelId],
    );
    const posted = new Set(rows.map((r) => r.source_url));
    const unposted = items.filter((i) => !posted.has(i.source));
    this.structured.db({
      op: 'filterUnposted', table: 'posted_news', channelId,
      rowCount: unposted.length,
      detail: { input: items.length, alreadyPosted: posted.size, firstCandidate: unposted[0]?.source },
    });
    return unposted;
  }

  /** Mark an article as posted to a channel */
  async markPosted(sourceUrl: string, title: string | null, channelId: string, contentType?: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO posted_news (source_url, title, channel_id, content_type)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (source_url, channel_id) DO NOTHING`,
      [sourceUrl, title, channelId, contentType ?? null],
    );
    this.structured.db({
      op: 'markPosted', table: 'posted_news', channelId,
      detail: { sourceUrl, title, contentType },
    });
  }

  /** Get the content_type of the most recently posted item to a channel */
  async getLastPostedType(channelId: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      `SELECT content_type FROM posted_news
       WHERE channel_id = $1 AND content_type IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
      [channelId],
    );
    return rows[0]?.content_type ?? null;
  }
}
