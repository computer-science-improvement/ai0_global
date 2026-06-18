import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../../database/database.tokens';
import { PollTier } from '../types';

export interface TrackedChannel {
  id:             string;
  tgChatId:       string | null;
  username:       string | null;
  title:          string | null;
  about:          string | null;
  category:       string | null;
  isMine:         boolean;
  isClosed:       boolean;
  pollTier:       PollTier;
  subsCount:      number | null;
  addedAt:        Date;
  lastPolledAt:   Date | null;
  /** Channel-key (e.g. "@motivation_local" or "-1001234"). Phase 5a column. */
  channelKey:     string | null;
  /** "public" | "private" | null — derived at import time. */
  kind:           string | null;
  /** UUID of `my_bots` row publishing into this channel. Null when external. */
  botId:          string | null;
  /** Brand group (meta_account_groups) this channel belongs to; null = none.
   *  Organizational only — does not affect publishing. */
  groupId:        string | null;
  /** Phase 4 themes assigned for recommendations / matching. */
  themes:         string[];
  /** Per-channel publishing kill switch. When true, publisher refuses to send. */
  publishPaused:  boolean;
  /** MTProto session reachability: 'unknown' until first poll, 'ok' when the
   *  session can read the channel, 'not_subscribed' when it can't. */
  trackingStatus:    'unknown' | 'ok' | 'not_subscribed';
  trackingCheckedAt: Date | null;
}

export interface UpsertChannelInput {
  username?:    string | null;
  tgChatId?:    string | null;
  title?:       string | null;
  about?:       string | null;
  isMine?:      boolean;
  isClosed?:    boolean;
  pollTier?:    PollTier;
  subsCount?:   number | null;
  meta?:        unknown;
}

@Injectable()
export class TrackedChannelsRepository {
  private readonly logger = new Logger(TrackedChannelsRepository.name);

  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  async getById(id: string): Promise<TrackedChannel | null> {
    const r = await this.pool.query<any>(
      `SELECT * FROM tracked_channels WHERE id = $1`, [id],
    );
    return r.rows[0] ? this.toEntity(r.rows[0]) : null;
  }

  async getByUsername(username: string): Promise<TrackedChannel | null> {
    const r = await this.pool.query<any>(
      `SELECT * FROM tracked_channels WHERE LOWER(username) = LOWER($1)`, [username],
    );
    return r.rows[0] ? this.toEntity(r.rows[0]) : null;
  }

  async getByChannelKey(channelKey: string): Promise<TrackedChannel | null> {
    const r = await this.pool.query<any>(
      `SELECT * FROM tracked_channels WHERE channel_key = $1`, [channelKey],
    );
    return r.rows[0] ? this.toEntity(r.rows[0]) : null;
  }

  /**
   * Upsert a private-channel row from invite-link metadata. The row is
   * keyed by `channel_key = 'invite:<hash>'` so subsequent posts that
   * mention the same invite link reuse it. tg_chat_id is left null until
   * the session joins the channel (at which point poll-meta picks up the
   * real id via checkChatInvite's ChatInviteAlready branch). is_mine
   * stays false — these are discovered external channels.
   */
  async upsertInviteChannel(input: {
    hash:      string;
    title:     string | null;
    subsCount: number | null;
    tgChatId:  string | null;
  }): Promise<string> {
    const key = `invite:${input.hash}`;
    const r = await this.pool.query<{ id: string }>(
      `INSERT INTO tracked_channels
         (channel_key, kind, is_mine, is_closed, poll_tier, title, subs_count, tg_chat_id)
       VALUES ($1, 'private', FALSE, FALSE, 'cold', $2, $3, $4)
       ON CONFLICT (channel_key) WHERE channel_key IS NOT NULL DO UPDATE SET
         title      = COALESCE(EXCLUDED.title,      tracked_channels.title),
         subs_count = COALESCE(EXCLUDED.subs_count, tracked_channels.subs_count),
         tg_chat_id = COALESCE(EXCLUDED.tg_chat_id, tracked_channels.tg_chat_id)
       RETURNING id`,
      [key, input.title, input.subsCount, input.tgChatId],
    );
    return r.rows[0].id;
  }

  async upsertByUsername(input: UpsertChannelInput & { username: string }): Promise<string> {
    const r = await this.pool.query<{ id: string }>(
      `INSERT INTO tracked_channels
         (username, tg_chat_id, title, about, is_mine, is_closed, poll_tier, subs_count, meta)
       VALUES ($1, $2, $3, $4, COALESCE($5,false), COALESCE($6,false),
               COALESCE($7,'warm'), $8, $9::jsonb)
       ON CONFLICT (LOWER(username))
       WHERE username IS NOT NULL
       DO UPDATE SET
         tg_chat_id = COALESCE(EXCLUDED.tg_chat_id, tracked_channels.tg_chat_id),
         title      = COALESCE(EXCLUDED.title,      tracked_channels.title),
         about      = COALESCE(EXCLUDED.about,      tracked_channels.about),
         is_closed  = COALESCE(EXCLUDED.is_closed,  tracked_channels.is_closed),
         poll_tier  = COALESCE(EXCLUDED.poll_tier,  tracked_channels.poll_tier),
         subs_count = COALESCE(EXCLUDED.subs_count, tracked_channels.subs_count),
         meta       = COALESCE(EXCLUDED.meta,       tracked_channels.meta)
       RETURNING id`,
      [
        input.username,
        input.tgChatId,
        input.title ?? null,
        input.about ?? null,
        input.isMine ?? null,
        input.isClosed ?? null,
        input.pollTier ?? null,
        input.subsCount ?? null,
        input.meta ? JSON.stringify(input.meta) : null,
      ],
    );
    return r.rows[0].id;
  }

  async listForPolling(tier: PollTier, olderThan: Date, limit: number): Promise<TrackedChannel[]> {
    const r = await this.pool.query<any>(
      `SELECT * FROM tracked_channels
       WHERE poll_tier = $1
         AND is_closed = FALSE
         AND (last_polled_at IS NULL OR last_polled_at < $2)
       ORDER BY last_polled_at NULLS FIRST
       LIMIT $3`,
      [tier, olderThan, limit],
    );
    return r.rows.map((row) => this.toEntity(row));
  }

  async markPolled(channelId: string, subsCount: number | null, snapshotAt: Date): Promise<void> {
    await this.pool.query(
      `UPDATE tracked_channels
       SET last_polled_at = $2,
           subs_count     = COALESCE($3, subs_count)
       WHERE id = $1`,
      [channelId, snapshotAt, subsCount],
    );
    if (subsCount !== null) {
      await this.pool.query(
        `INSERT INTO tracked_subs_history (channel_id, snapshot_at, subs_count)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [channelId, snapshotAt, subsCount],
      );
    }
  }

  async list(filter: {
    is_mine?: boolean;
    tier?:    PollTier;
    q?:       string;
    /** UUID of `my_bots` row. When set, return only channels with this bot. */
    bot_id?:  string;
    limit:    number;
    offset:   number;
  }): Promise<{ items: TrackedChannel[]; total: number }> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.is_mine !== undefined) { args.push(filter.is_mine); where.push(`is_mine = $${args.length}`); }
    if (filter.tier)                  { args.push(filter.tier);    where.push(`poll_tier = $${args.length}`); }
    if (filter.bot_id)                { args.push(filter.bot_id);  where.push(`bot_id = $${args.length}`); }
    if (filter.q)                     { args.push(`%${filter.q.toLowerCase()}%`); where.push(`LOWER(COALESCE(title,'') || ' ' || COALESCE(username,'') || ' ' || COALESCE(channel_key,'')) LIKE $${args.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const totalR = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM tracked_channels ${whereSql}`, args,
    );
    args.push(filter.limit);  const limitArg  = `$${args.length}`;
    args.push(filter.offset); const offsetArg = `$${args.length}`;

    const itemsR = await this.pool.query<any>(
      `SELECT * FROM tracked_channels ${whereSql}
       ORDER BY added_at DESC LIMIT ${limitArg} OFFSET ${offsetArg}`,
      args,
    );

    return {
      items: itemsR.rows.map((r) => this.toEntity(r)),
      total: parseInt(totalR.rows[0].count, 10),
    };
  }

  async softDelete(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM tracked_channels WHERE id = $1`, [id]);
  }

  /**
   * Patch any subset of editable config fields. Restricted to columns that
   * make sense to mutate from the dashboard — chrome fields (title/about/
   * subs_count/last_polled_at) come from the poller, not the user.
   */
  async patch(id: string, patch: {
    title?:         string | null;
    about?:         string | null;
    isMine?:        boolean;
    botId?:         string | null;
    channelKey?:    string | null;
    tgChatId?:      string | null;
    kind?:          string | null;
    pollTier?:      PollTier;
    themes?:        string[];
    publishPaused?: boolean;
    groupId?:       string | null;
  }): Promise<boolean> {
    const sets: string[] = [];
    const args: unknown[] = [id];
    let i = 2;
    if (patch.groupId       !== undefined) { sets.push(`group_id = $${i++}`);       args.push(patch.groupId); }
    if (patch.title         !== undefined) { sets.push(`title = $${i++}`);          args.push(patch.title); }
    if (patch.isMine        !== undefined) { sets.push(`is_mine = $${i++}`);        args.push(patch.isMine); }
    if (patch.botId         !== undefined) { sets.push(`bot_id = $${i++}`);         args.push(patch.botId); }
    if (patch.channelKey    !== undefined) { sets.push(`channel_key = $${i++}`);    args.push(patch.channelKey); }
    if (patch.tgChatId      !== undefined) { sets.push(`tg_chat_id = $${i++}`);     args.push(patch.tgChatId); }
    if (patch.kind          !== undefined) { sets.push(`kind = $${i++}`);           args.push(patch.kind); }
    if (patch.pollTier      !== undefined) { sets.push(`poll_tier = $${i++}`);      args.push(patch.pollTier); }
    if (patch.themes        !== undefined) { sets.push(`themes = $${i++}::text[]`); args.push(patch.themes); }
    if (patch.publishPaused !== undefined) { sets.push(`publish_paused = $${i++}`); args.push(patch.publishPaused); }
    if (patch.about         !== undefined) { sets.push(`about = $${i++}`);          args.push(patch.about); }
    if (sets.length === 0) return true;
    const { rowCount } = await this.pool.query(
      `UPDATE tracked_channels SET ${sets.join(', ')} WHERE id = $1`,
      args,
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Create a channel from a full config (private-channel path). The discovery
   * flow uses upsertByUsername (which requires a username); this path is
   * used by the dashboard's AddChannel modal when the operator already knows
   * the chat id + bot binding.
   */
  async createFull(input: {
    channelKey?: string | null;
    username?:   string | null;
    tgChatId?:   string | null;
    title?:      string | null;
    kind:        'public' | 'private';
    botId?:      string | null;
    isMine:      boolean;
    pollTier:    PollTier;
  }): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO tracked_channels
         (channel_key, username, tg_chat_id, title, kind, bot_id, is_mine, poll_tier)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        input.channelKey ?? null,
        input.username ?? null,
        input.tgChatId ?? null,
        input.title ?? null,
        input.kind,
        input.botId ?? null,
        input.isMine,
        input.pollTier,
      ],
    );
    return rows[0].id;
  }

  async subsHistory(channelId: string, from: Date | null, to: Date | null):
    Promise<{ snapshotAt: Date; subsCount: number }[]> {
    const args: unknown[] = [channelId];
    let where = `channel_id = $1`;
    if (from) { args.push(from); where += ` AND snapshot_at >= $${args.length}`; }
    if (to)   { args.push(to);   where += ` AND snapshot_at <= $${args.length}`; }
    const r = await this.pool.query<{ snapshot_at: Date; subs_count: number }>(
      `SELECT snapshot_at, subs_count FROM tracked_subs_history
       WHERE ${where} ORDER BY snapshot_at ASC`,
      args,
    );
    return r.rows.map((row) => ({ snapshotAt: row.snapshot_at, subsCount: row.subs_count }));
  }

  async listDiscoveryCandidates(): Promise<{
    id: string; username: string | null; isClosed: boolean; addedAt: Date;
  }[]> {
    const r = await this.pool.query<any>(
      `SELECT id, username, is_closed, added_at FROM tracked_channels
       WHERE is_closed = TRUE OR (last_polled_at IS NULL AND added_at < now() - INTERVAL '1 hour')
       ORDER BY added_at DESC LIMIT 200`,
    );
    return r.rows.map((row) => ({
      id: row.id, username: row.username, isClosed: row.is_closed, addedAt: row.added_at,
    }));
  }

  /** The single Telegram channel linked to a group (migration 034: <=1 per
   *  group via the partial unique index). Null when the group has none. */
  async findByGroupId(groupId: string): Promise<TrackedChannel | null> {
    const r = await this.pool.query<any>(
      `SELECT * FROM tracked_channels WHERE group_id = $1 LIMIT 1`, [groupId],
    );
    return r.rows[0] ? this.toEntity(r.rows[0]) : null;
  }

  /** The group a Telegram channel belongs to (by channel_key), or null. */
  async findGroupIdByChannelKey(channelKey: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ group_id: string | null }>(
      `SELECT group_id FROM tracked_channels WHERE channel_key = $1 LIMIT 1`, [channelKey],
    );
    return rows[0]?.group_id ?? null;
  }

  private toEntity(r: any): TrackedChannel {
    return {
      id:           r.id,
      tgChatId:     r.tg_chat_id !== null ? String(r.tg_chat_id) : null,
      username:     r.username,
      title:        r.title,
      about:        r.about,
      category:     r.category,
      isMine:       r.is_mine,
      isClosed:     r.is_closed,
      pollTier:     r.poll_tier,
      subsCount:    r.subs_count !== null ? Number(r.subs_count) : null,
      addedAt:      r.added_at,
      lastPolledAt: r.last_polled_at,
      channelKey:   r.channel_key ?? null,
      kind:         r.kind ?? null,
      botId:        r.bot_id ?? null,
      groupId:      r.group_id ?? null,
      themes:       Array.isArray(r.themes) ? r.themes : [],
      publishPaused: !!r.publish_paused,
      trackingStatus:    r.tracking_status ?? 'unknown',
      trackingCheckedAt: r.tracking_checked_at ?? null,
    };
  }

  async setTrackingStatus(channelId: string, status: 'ok' | 'not_subscribed'): Promise<void> {
    await this.pool.query(
      `UPDATE tracked_channels SET tracking_status = $2, tracking_checked_at = now() WHERE id = $1`,
      [channelId, status],
    );
  }
}
