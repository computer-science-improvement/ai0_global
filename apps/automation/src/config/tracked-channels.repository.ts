// apps/automation/src/config/tracked-channels.repository.ts
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';

export interface TrackedChannelConfigRow {
  id:              string;
  channel_key:     string | null;
  username:        string | null;
  tg_chat_id:      string | null;       // bigint → string from pg
  title:           string | null;
  kind:            'public' | 'private' | null;
  bot_id:          string | null;
  is_mine:         boolean;
  themes:          string[];
  /** Per-channel kill switch. When true, publisher refuses to send. */
  publish_paused:  boolean;
}

export interface TrackedChannelUpsertInput {
  channel_key:  string;
  username:     string | null;
  tg_chat_id:   number | string | null;
  kind:         'public' | 'private';
  bot_id:       string | null;
  is_mine:      boolean;
}

@Injectable()
export class TrackedChannelsConfigRepository {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async list(): Promise<TrackedChannelConfigRow[]> {
    const { rows } = await this.pool.query<TrackedChannelConfigRow>(
      `SELECT id, channel_key, username, tg_chat_id::text AS tg_chat_id,
              title, kind, bot_id, is_mine, themes, publish_paused
       FROM tracked_channels
       ORDER BY added_at`,
    );
    return rows;
  }

  async findByChannelKey(channelKey: string): Promise<TrackedChannelConfigRow | null> {
    const { rows } = await this.pool.query<TrackedChannelConfigRow>(
      `SELECT id, channel_key, username, tg_chat_id::text AS tg_chat_id,
              title, kind, bot_id, is_mine, themes, publish_paused
       FROM tracked_channels WHERE channel_key = $1`,
      [channelKey],
    );
    return rows[0] ?? null;
  }

  /** Upsert by channel_key. Idempotent. Returns the id. */
  async upsertByKey(input: TrackedChannelUpsertInput): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO tracked_channels
         (channel_key, username, tg_chat_id, kind, bot_id, is_mine, poll_tier)
       VALUES ($1, $2, $3, $4, $5, $6, 'warm')
       ON CONFLICT (channel_key) WHERE channel_key IS NOT NULL DO UPDATE SET
         username   = EXCLUDED.username,
         tg_chat_id = EXCLUDED.tg_chat_id,
         kind       = EXCLUDED.kind,
         bot_id     = EXCLUDED.bot_id,
         is_mine    = EXCLUDED.is_mine
       RETURNING id`,
      [
        input.channel_key,
        input.username,
        input.tg_chat_id,
        input.kind,
        input.bot_id,
        input.is_mine,
      ],
    );
    return rows[0].id;
  }
}
