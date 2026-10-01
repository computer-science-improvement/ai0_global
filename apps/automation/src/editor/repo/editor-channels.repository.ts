import type { Pool } from 'pg';
import type { EditorCard } from '../card';

export function rowToCard(r: any): EditorCard & { createdAt: Date } {
  return {
    channelKey:     r.channel_key,
    mode:           r.mode,
    title:          r.title ?? null,
    language:       r.language,
    timezone:       r.timezone,
    postsPerDayMin: Number(r.posts_per_day_min),
    postsPerDayMax: Number(r.posts_per_day_max),
    quietStartHour: Number(r.quiet_start_hour),
    quietEndHour:   Number(r.quiet_end_hour),
    minGapMinutes:  Number(r.min_gap_minutes),
    planHour:       Number(r.plan_hour),
    brief:          r.brief ?? '',
    formats:        r.formats ?? {},
    hashtags:       r.hashtags ?? [],
    hashtagMin:     Number(r.hashtag_min),
    hashtagMax:     Number(r.hashtag_max),
    footer:         r.footer ?? null,
    linkStyle:      r.link_style,
    emojiPolicy:    r.emoji_policy,
    skills:         r.skills ?? [],
    sources:        r.sources ?? [],
    toolsAllow:     r.tools_allow ?? null,
    exploreRatio:   Number(r.explore_ratio),
    dailyBudgetUsd: r.daily_budget_usd == null ? null : Number(r.daily_budget_usd),
    models:         r.models ?? {},
    bannedTerms:    r.banned_terms ?? [],
    createdAt:      r.created_at,
  };
}

export class EditorChannelsRepository {
  constructor(private readonly pool: Pool) {}

  async get(channelKey: string): Promise<(EditorCard & { createdAt: Date }) | null> {
    const { rows } = await this.pool.query(`SELECT * FROM editor_channels WHERE channel_key = $1`, [channelKey]);
    return rows[0] ? rowToCard(rows[0]) : null;
  }

  async listActive(): Promise<Array<EditorCard & { createdAt: Date }>> {
    const { rows } = await this.pool.query(`SELECT * FROM editor_channels WHERE mode <> 'off' ORDER BY channel_key`);
    return rows.map(rowToCard);
  }

  async list(): Promise<Array<EditorCard & { createdAt: Date }>> {
    const { rows } = await this.pool.query(`SELECT * FROM editor_channels ORDER BY channel_key`);
    return rows.map(rowToCard);
  }

  /** Reviewer-bounded write: only weights of formats already present in the card, clamped to 0.05..1. */
  async setFormatWeights(channelKey: string, weights: Record<string, number>): Promise<Record<string, number> | null> {
    const card = await this.get(channelKey);
    if (!card) return null;
    const next = { ...card.formats };
    for (const [f, w] of Object.entries(weights)) {
      if (!(f in next)) continue;
      next[f] = Math.round(Math.min(1, Math.max(0.05, Number(w))) * 100) / 100;
    }
    await this.pool.query(
      `UPDATE editor_channels SET formats = $2, updated_at = now() WHERE channel_key = $1`,
      [channelKey, JSON.stringify(next)],
    );
    return next;
  }
}
