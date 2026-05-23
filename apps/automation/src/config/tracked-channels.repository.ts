import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.tokens';

export interface TrackedChannelConfigRow {
  id:           string;
  channelKey:   string | null;
  kind:         string | null;
  botId:        string | null;
  tgChatId:     string | null;
  username:     string | null;
  title:        string | null;
  about:        string | null;
  isMine:       boolean;
  isClosed:     boolean;
  pollTier:     string;
  subsCount:    number | null;
  addedAt:      Date;
}

export interface TrackedChannelUpsertInput {
  channelKey:  string;
  kind?:       string | null;
  botId?:      string | null;
  tgChatId?:   string | null;
  username?:   string | null;
  title?:      string | null;
  about?:      string | null;
  isMine?:     boolean;
  isClosed?:   boolean;
  pollTier?:   string;
  subsCount?:  number | null;
}

@Injectable()
export class TrackedChannelsConfigRepository {
  private readonly logger = new Logger(TrackedChannelsConfigRepository.name);

  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async list(): Promise<TrackedChannelConfigRow[]> {
    const r = await this.pool.query<any>(
      `SELECT id, channel_key, kind, bot_id,
              tg_chat_id::text AS tg_chat_id,
              username, title, about,
              is_mine, is_closed, poll_tier, subs_count, added_at
       FROM tracked_channels
       ORDER BY added_at ASC`,
    );
    return r.rows.map((row) => this.toEntity(row));
  }

  async findByChannelKey(key: string): Promise<TrackedChannelConfigRow | null> {
    const r = await this.pool.query<any>(
      `SELECT id, channel_key, kind, bot_id,
              tg_chat_id::text AS tg_chat_id,
              username, title, about,
              is_mine, is_closed, poll_tier, subs_count, added_at
       FROM tracked_channels
       WHERE channel_key = $1`,
      [key],
    );
    return r.rows[0] ? this.toEntity(r.rows[0]) : null;
  }

  async upsertByKey(input: TrackedChannelUpsertInput): Promise<string> {
    const r = await this.pool.query<{ id: string }>(
      `INSERT INTO tracked_channels
         (channel_key, kind, bot_id, tg_chat_id, username, title, about,
          is_mine, is_closed, poll_tier, subs_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7,
               COALESCE($8, false), COALESCE($9, false),
               COALESCE($10, 'warm'), $11)
       ON CONFLICT (channel_key) WHERE channel_key IS NOT NULL
       DO UPDATE SET
         kind       = COALESCE(EXCLUDED.kind,       tracked_channels.kind),
         bot_id     = COALESCE(EXCLUDED.bot_id,     tracked_channels.bot_id),
         tg_chat_id = COALESCE(EXCLUDED.tg_chat_id, tracked_channels.tg_chat_id),
         username   = COALESCE(EXCLUDED.username,   tracked_channels.username),
         title      = COALESCE(EXCLUDED.title,      tracked_channels.title),
         about      = COALESCE(EXCLUDED.about,      tracked_channels.about),
         is_mine    = COALESCE(EXCLUDED.is_mine,    tracked_channels.is_mine),
         is_closed  = COALESCE(EXCLUDED.is_closed,  tracked_channels.is_closed),
         poll_tier  = COALESCE(EXCLUDED.poll_tier,  tracked_channels.poll_tier),
         subs_count = COALESCE(EXCLUDED.subs_count, tracked_channels.subs_count)
       RETURNING id`,
      [
        input.channelKey,
        input.kind ?? null,
        input.botId ?? null,
        input.tgChatId ?? null,
        input.username ?? null,
        input.title ?? null,
        input.about ?? null,
        input.isMine ?? null,
        input.isClosed ?? null,
        input.pollTier ?? null,
        input.subsCount ?? null,
      ],
    );
    return r.rows[0].id;
  }

  private toEntity(r: any): TrackedChannelConfigRow {
    return {
      id:         r.id,
      channelKey: r.channel_key,
      kind:       r.kind,
      botId:      r.bot_id,
      tgChatId:   r.tg_chat_id !== null ? String(r.tg_chat_id) : null,
      username:   r.username,
      title:      r.title,
      about:      r.about,
      isMine:     r.is_mine,
      isClosed:   r.is_closed,
      pollTier:   r.poll_tier,
      subsCount:  r.subs_count !== null ? Number(r.subs_count) : null,
      addedAt:    r.added_at,
    };
  }
}
