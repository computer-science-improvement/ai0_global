import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.tokens';
import type { ComposedPost, ScheduledPost } from './scheduled-posts.types';

function toEntity(r: any): ScheduledPost {
  return {
    id: r.id, channelId: r.channel_id, sender: r.sender, botId: r.bot_id,
    text: r.text, mediaType: r.media_type, mediaUrl: r.media_url,
    mediaPlacement: r.media_placement, buttons: r.buttons ?? [],
    scheduledAt: r.scheduled_at.toISOString(),
    status: r.status, messageId: r.message_id != null ? Number(r.message_id) : null,
    error: r.error, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
  };
}

@Injectable()
export class ScheduledPostsRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async create(p: ComposedPost): Promise<ScheduledPost> {
    const { rows } = await this.pool.query(
      `INSERT INTO scheduled_publications
         (channel_id, sender, bot_id, text, media_type, media_url, media_placement, buttons, scheduled_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING *`,
      [p.channelId, p.sender, p.botId, p.text, p.mediaType, p.mediaUrl,
       p.mediaPlacement, JSON.stringify(p.buttons), p.scheduledAt],
    );
    return toEntity(rows[0]);
  }

  async list(status?: string): Promise<ScheduledPost[]> {
    const { rows } = status
      ? await this.pool.query('SELECT * FROM scheduled_publications WHERE status=$1 ORDER BY scheduled_at DESC', [status])
      : await this.pool.query('SELECT * FROM scheduled_publications ORDER BY scheduled_at DESC');
    return rows.map(toEntity);
  }

  async getById(id: string): Promise<ScheduledPost | null> {
    const { rows } = await this.pool.query('SELECT * FROM scheduled_publications WHERE id=$1', [id]);
    return rows[0] ? toEntity(rows[0]) : null;
  }

  async update(id: string, p: ComposedPost): Promise<ScheduledPost | null> {
    const { rows } = await this.pool.query(
      `UPDATE scheduled_publications SET
         channel_id=$2, sender=$3, bot_id=$4, text=$5, media_type=$6, media_url=$7,
         media_placement=$8, buttons=$9::jsonb, scheduled_at=$10, updated_at=now()
       WHERE id=$1 AND status='pending' RETURNING *`,
      [id, p.channelId, p.sender, p.botId, p.text, p.mediaType, p.mediaUrl,
       p.mediaPlacement, JSON.stringify(p.buttons), p.scheduledAt],
    );
    return rows[0] ? toEntity(rows[0]) : null;
  }

  async cancel(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE scheduled_publications SET status='canceled', updated_at=now()
       WHERE id=$1 AND status='pending'`, [id]);
    return (rowCount ?? 0) > 0;
  }

  /** Atomically claim one due pending post (prevents double-send across ticks). */
  async claimDue(now: Date): Promise<ScheduledPost | null> {
    const { rows } = await this.pool.query(
      `UPDATE scheduled_publications SET status='sending', updated_at=now()
       WHERE id = (
         SELECT id FROM scheduled_publications
         WHERE status='pending' AND scheduled_at <= $1
         ORDER BY scheduled_at ASC FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING *`, [now]);
    return rows[0] ? toEntity(rows[0]) : null;
  }

  /** Recover posts claimed but never finished (process crash between claim and
   *  markSent): flip stale 'sending' rows back to 'pending' so they get retried. */
  async rependStale(): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE scheduled_publications SET status='pending', updated_at=now()
       WHERE status='sending' AND updated_at < now() - interval '5 minutes'`);
    return rowCount ?? 0;
  }

  async markSent(id: string, messageId: number): Promise<void> {
    await this.pool.query(
      `UPDATE scheduled_publications SET status='sent', message_id=$2, error=NULL, updated_at=now() WHERE id=$1`,
      [id, messageId]);
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE scheduled_publications SET status='failed', error=$2, updated_at=now() WHERE id=$1`,
      [id, error.slice(0, 500)]);
  }
}
