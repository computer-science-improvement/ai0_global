import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { DB_POOL } from '../database/database.module';
import { PublicationsRepository } from './publications.repository';

export interface ChannelSummary {
  channelId:        string;
  subscribers:      number | null;
  subscribersDelta24h: number | null;
  title:            string | null;
  lastSnapshotAt:   Date | null;
}

export interface ChannelSnapshot {
  capturedAt:  Date;
  subscribers: number | null;
  onlineCount: number | null;
}

export interface PostSnapshot {
  capturedAt:     Date;
  views:          number | null;
  forwards:       number | null;
  replies:        number | null;
  reactions:      Record<string, number> | null;
  reactionsTotal: number | null;
}

export interface PostWithLatest {
  id:            number;
  channelId:     string;
  messageId:     number;
  title:         string | null;
  sourceUrl:     string | null;
  strategyType:  string | null;
  postedAt:      Date;
  latestViews:   number | null;
  latestReactions: number | null;
  latestForwards: number | null;
}

@Injectable()
export class StatsService {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly publications: PublicationsRepository,
  ) {}

  async channelsSummary(): Promise<ChannelSummary[]> {
    const { rows } = await this.pool.query(
      `WITH latest AS (
         SELECT DISTINCT ON (channel_id)
                channel_id, subscribers, title, captured_at
           FROM channel_stats_snapshots
           ORDER BY channel_id, captured_at DESC
       ),
       day_ago AS (
         SELECT DISTINCT ON (channel_id)
                channel_id, subscribers
           FROM channel_stats_snapshots
           WHERE captured_at <= now() - INTERVAL '24 hours'
           ORDER BY channel_id, captured_at DESC
       )
       SELECT l.channel_id, l.subscribers, l.title, l.captured_at,
              (l.subscribers - d.subscribers) AS delta24h
         FROM latest l
         LEFT JOIN day_ago d ON d.channel_id = l.channel_id`,
    );
    return rows.map((r: any) => ({
      channelId:           r.channel_id,
      subscribers:         r.subscribers,
      title:               r.title,
      lastSnapshotAt:      r.captured_at,
      subscribersDelta24h: r.delta24h,
    }));
  }

  async channelTimeseries(
    channelId: string,
    from?: Date,
    to?: Date,
  ): Promise<ChannelSnapshot[]> {
    const params: unknown[] = [channelId];
    const where: string[] = ['channel_id = $1'];
    if (from) { params.push(from); where.push(`captured_at >= $${params.length}`); }
    if (to)   { params.push(to);   where.push(`captured_at <= $${params.length}`); }
    const { rows } = await this.pool.query(
      `SELECT captured_at, subscribers, online_count
         FROM channel_stats_snapshots
         WHERE ${where.join(' AND ')}
         ORDER BY captured_at ASC`,
      params,
    );
    return rows.map((r: any) => ({
      capturedAt:  r.captured_at,
      subscribers: r.subscribers,
      onlineCount: r.online_count,
    }));
  }

  /**
   * One point per day: last snapshot of each calendar day (UTC).
   * Use for bar charts "date → subscribers".
   */
  async channelDailySubscribers(
    channelId: string,
    from?: Date,
    to?: Date,
  ): Promise<{ date: string; subscribers: number | null }[]> {
    const params: unknown[] = [channelId];
    const where: string[]   = ['channel_id = $1'];
    if (from) { params.push(from); where.push(`captured_at >= $${params.length}`); }
    if (to)   { params.push(to);   where.push(`captured_at <= $${params.length}`); }
    const { rows } = await this.pool.query(
      `SELECT DISTINCT ON (date_trunc('day', captured_at))
              to_char(date_trunc('day', captured_at), 'YYYY-MM-DD') AS date,
              subscribers
         FROM channel_stats_snapshots
         WHERE ${where.join(' AND ')}
         ORDER BY date_trunc('day', captured_at) ASC, captured_at DESC`,
      params,
    );
    return rows.map((r: any) => ({
      date:        r.date,
      subscribers: r.subscribers,
    }));
  }

  async postsByChannel(channelId: string, limit: number, offset: number): Promise<PostWithLatest[]> {
    const { rows } = await this.pool.query(
      `SELECT p.id, p.channel_id, p.message_id, p.title, p.source_url,
              p.strategy_type, p.posted_at,
              s.views          AS latest_views,
              s.reactions_total AS latest_reactions,
              s.forwards       AS latest_forwards
         FROM published_posts p
         LEFT JOIN LATERAL (
           SELECT views, reactions_total, forwards
             FROM post_stats_snapshots
             WHERE post_id = p.id
             ORDER BY captured_at DESC
             LIMIT 1
         ) s ON true
         WHERE p.channel_id = $1
         ORDER BY p.posted_at DESC
         LIMIT $2 OFFSET $3`,
      [channelId, limit, offset],
    );
    return rows.map(this.mapPost);
  }

  async postTimeseries(postId: number): Promise<{
    post: PostWithLatest | null;
    snapshots: PostSnapshot[];
  }> {
    const post = await this.publications.getById(postId);
    if (!post) return { post: null, snapshots: [] };

    const { rows: latestRows } = await this.pool.query(
      `SELECT views, reactions_total, forwards
         FROM post_stats_snapshots
         WHERE post_id = $1
         ORDER BY captured_at DESC
         LIMIT 1`,
      [postId],
    );
    const latest = latestRows[0];

    const { rows } = await this.pool.query(
      `SELECT captured_at, views, forwards, replies, reactions, reactions_total
         FROM post_stats_snapshots
         WHERE post_id = $1
         ORDER BY captured_at ASC`,
      [postId],
    );

    const withLatest: PostWithLatest = {
      id:            post.id,
      channelId:     post.channelId,
      messageId:     post.messageId,
      title:         post.title,
      sourceUrl:     post.sourceUrl,
      strategyType:  post.strategyType,
      postedAt:      post.postedAt,
      latestViews:    latest?.views ?? null,
      latestReactions: latest?.reactions_total ?? null,
      latestForwards: latest?.forwards ?? null,
    };

    const snapshots: PostSnapshot[] = rows.map((r: any) => ({
      capturedAt:     r.captured_at,
      views:          r.views,
      forwards:       r.forwards,
      replies:        r.replies,
      reactions:      r.reactions,
      reactionsTotal: r.reactions_total,
    }));

    return { post: withLatest, snapshots };
  }

  async summary(): Promise<{
    postsToday:    number;
    postsWeek:     number;
    postsMonth:    number;
    topPosts:      PostWithLatest[];
    channelGrowth: ChannelSummary[];
  }> {
    const { rows: counts } = await this.pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE posted_at >= now() - INTERVAL '1 day')   AS today,
         COUNT(*) FILTER (WHERE posted_at >= now() - INTERVAL '7 days')  AS week,
         COUNT(*) FILTER (WHERE posted_at >= now() - INTERVAL '30 days') AS month
       FROM published_posts`,
    );
    const c = counts[0];

    const { rows: top } = await this.pool.query(
      `SELECT p.id, p.channel_id, p.message_id, p.title, p.source_url,
              p.strategy_type, p.posted_at,
              s.views           AS latest_views,
              s.reactions_total AS latest_reactions,
              s.forwards        AS latest_forwards
         FROM published_posts p
         JOIN LATERAL (
           SELECT views, reactions_total, forwards
             FROM post_stats_snapshots
             WHERE post_id = p.id
             ORDER BY captured_at DESC
             LIMIT 1
         ) s ON true
         WHERE p.posted_at >= now() - INTERVAL '30 days'
         ORDER BY s.views DESC NULLS LAST
         LIMIT 3`,
    );

    return {
      postsToday: Number(c.today),
      postsWeek:  Number(c.week),
      postsMonth: Number(c.month),
      topPosts:   top.map(this.mapPost),
      channelGrowth: await this.channelsSummary(),
    };
  }

  private mapPost = (r: any): PostWithLatest => ({
    id:             Number(r.id),
    channelId:      r.channel_id,
    messageId:      Number(r.message_id),
    title:          r.title,
    sourceUrl:      r.source_url,
    strategyType:   r.strategy_type,
    postedAt:       r.posted_at,
    latestViews:    r.latest_views !== undefined ? r.latest_views : null,
    latestReactions: r.latest_reactions !== undefined ? r.latest_reactions : null,
    latestForwards: r.latest_forwards !== undefined ? r.latest_forwards : null,
  });
}
