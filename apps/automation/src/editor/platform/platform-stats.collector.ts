import type { Pool } from 'pg';
import { parseResourceRef } from '../agents/agent.types';
import type { PlatformPostsRepository } from './platform-posts.repository';

export interface PostMetrics { views?: number | null; reach?: number | null; likes?: number | null; comments?: number | null; shares?: number | null; saves?: number | null; extra?: unknown }

export interface StatsCollectorDeps {
  pool:  Pick<Pool, 'query'>;
  posts: Pick<PlatformPostsRepository, 'needingMetrics' | 'addMetrics' | 'upsertDaily'>;
  /** Access token of a Meta account (token_enc → token_env), null when missing. */
  metaToken(accountId: string): Promise<string | null>;
  /** Graph GET (token-redacting). */
  graphGet(url: string, params: Record<string, string>): Promise<any>;
  graphBase: { facebook: string; threads: string };
  /** TikTok follower count (user.info.stats scope); null when unavailable. */
  tiktokFollowers?: (accountId: string) => Promise<number | null>;
  log?: (msg: string) => void;
  now?: () => Date;
}

const num = (v: unknown): number | null => (v == null || Number.isNaN(Number(v)) ? null : Number(v));

function insightValue(data: any, name: string): number | null {
  const m = (data?.data ?? []).find((x: any) => x.name === name);
  return num(m?.values?.[0]?.value ?? m?.total_value?.value);
}

/**
 * Per-post metrics and per-resource daily stats of every platform (spec 019
 * FR-009). Never throws: a failing resource or post is logged and skipped.
 */
export class PlatformStatsCollector {
  constructor(private readonly d: StatsCollectorDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }

  async fetchPostMetrics(platform: string, externalId: string, token: string): Promise<PostMetrics> {
    if (platform === 'instagram') {
      const base = `${this.d.graphBase.facebook}/${externalId}`;
      const fields = await this.d.graphGet(base, { fields: 'like_count,comments_count', access_token: token });
      let ins: any = null;
      try { ins = await this.d.graphGet(`${base}/insights`, { metric: 'reach,saved,shares,views', access_token: token }); } catch { /* metrics vary by media type */ }
      return {
        likes: num(fields.like_count), comments: num(fields.comments_count),
        reach: insightValue(ins, 'reach'), saves: insightValue(ins, 'saved'), shares: insightValue(ins, 'shares'), views: insightValue(ins, 'views'),
      };
    }
    if (platform === 'facebook') {
      const r = await this.d.graphGet(`${this.d.graphBase.facebook}/${externalId}`, {
        fields: 'reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares', access_token: token,
      });
      return { likes: num(r?.reactions?.summary?.total_count), comments: num(r?.comments?.summary?.total_count), shares: num(r?.shares?.count) };
    }
    if (platform === 'threads') {
      const r = await this.d.graphGet(`${this.d.graphBase.threads}/${externalId}/insights`, { metric: 'views,likes,replies,reposts,quotes', access_token: token });
      return {
        views: insightValue(r, 'views'), likes: insightValue(r, 'likes'), comments: insightValue(r, 'replies'),
        shares: (insightValue(r, 'reposts') ?? 0) + (insightValue(r, 'quotes') ?? 0),
      };
    }
    return {};
  }

  async collectPosts(): Promise<{ posts: number; failed: number }> {
    let posts = 0;
    let failed = 0;
    for (const p of await this.d.posts.needingMetrics(7)) {
      const ref = parseResourceRef(p.resourceRef);
      if (!ref || !p.externalId || !['instagram', 'facebook', 'threads'].includes(ref.platform)) continue;
      try {
        const token = await this.d.metaToken(ref.id);
        if (!token) continue;
        await this.d.posts.addMetrics(p.id, await this.fetchPostMetrics(ref.platform, p.externalId, token));
        posts++;
      } catch (err: any) {
        failed++;
        this.d.log?.(`metrics ${p.resourceRef} post ${p.id}: ${err?.message ?? err}`);
      }
    }
    return { posts, failed };
  }

  /**
   * Today's followers/reach per resource from what the existing collectors already store.
   * Spec 024 FR-005: `day` is today in each resource's own zone (resource_tz()).
   */
  async rollupDaily(): Promise<number> {
    const now = this.now();
    let n = 0;
    const { rows: meta } = await this.d.pool.query(
      `SELECT m.id, m.platform, m.followers, i.reach, i.impressions, d.day::text AS day
         FROM meta_accounts m
         CROSS JOIN LATERAL (SELECT ($1::timestamptz AT TIME ZONE resource_tz(m.platform || ':' || m.id))::date AS day) d
         LEFT JOIN meta_account_insights i ON i.account_id = m.id AND i.day = d.day - 1
        WHERE m.active`, [now]);
    for (const r of meta) {
      await this.d.posts.upsertDaily(`${r.platform}:${r.id}`, r.day, { followers: num(r.followers), reach: num(r.reach), views: num(r.impressions) });
      n++;
    }
    const { rows: tg } = await this.d.pool.query(
      `SELECT DISTINCT ON (s.channel_id) s.channel_id, s.subscribers,
              ($1::timestamptz AT TIME ZONE resource_tz('telegram:' || s.channel_id))::date::text AS day
         FROM editor_v_channel_daily s
         JOIN tracked_channels t ON t.channel_key = s.channel_id AND t.is_mine
        ORDER BY s.channel_id, s.day DESC`, [now]);
    for (const r of tg) {
      await this.d.posts.upsertDaily(`telegram:${r.channel_id}`, r.day, { followers: num(r.subscribers) });
      n++;
    }
    if (this.d.tiktokFollowers) {
      const { rows: tt } = await this.d.pool.query(
        `SELECT id, ($1::timestamptz AT TIME ZONE resource_tz('tiktok:' || id))::date::text AS day FROM tiktok_accounts WHERE active`, [now]);
      for (const r of tt) {
        try {
          const f = await this.d.tiktokFollowers(r.id);
          if (f != null) { await this.d.posts.upsertDaily(`tiktok:${r.id}`, r.day, { followers: f }); n++; }
        } catch (err: any) {
          this.d.log?.(`tiktok followers ${r.id}: ${err?.message ?? err}`);
        }
      }
    }
    return n;
  }

  async run(): Promise<{ posts: number; failed: number; resources: number }> {
    let resources = 0;
    try { resources = await this.rollupDaily(); } catch (err: any) { this.d.log?.(`daily rollup failed: ${err?.message ?? err}`); }
    let r = { posts: 0, failed: 0 };
    try { r = await this.collectPosts(); } catch (err: any) { this.d.log?.(`post metrics failed: ${err?.message ?? err}`); }
    return { ...r, resources };
  }
}
