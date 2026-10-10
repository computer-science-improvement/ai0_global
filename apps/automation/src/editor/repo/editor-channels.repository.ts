import type { Pool } from 'pg';
import type { ChannelMode, EditorCard } from '../card';
import { bindingsStillEnabled, enabledBindingExtIds, liveRefsOf } from '../migration/binding-guard';
import { audienceCapsOfProfile } from '../post/audience-asks';

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
    crosspost:      r.crosspost ?? true,
    ...(r.approval_hold_hours != null ? { approvalHoldHours: Number(r.approval_hold_hours) } : {}),
    ...(r.approval_lead_hours != null ? { approvalLeadHours: Number(r.approval_lead_hours) } : {}),
    ...(r.rich_pref === 'auto' || r.rich_pref === 'prefer' || r.rich_pref === 'never' ? { richPref: r.rich_pref } : {}),
    ...(r.rich_unsupported ? { richUnsupported: true } : {}),
    ...(r.humor_pref === 'none' || r.humor_pref === 'light' ? { humor: r.humor_pref } : {}),
    ...(r.slang_pref === 'true' || r.slang_pref === true ? { slang: true } : r.slang_pref === 'false' || r.slang_pref === false ? { slang: false } : {}),
    ...(r.emoji_pref === 'none' || r.emoji_pref === 'light' || r.emoji_pref === 'rich' ? { emojiPref: r.emoji_pref } : {}),
    ...capsOfRow(r),
    createdAt:      r.created_at,
  };
}

/** Spec 034 FR-005: reader-question and poll caps of the channel's resource (defaults without a profile). */
function capsOfRow(r: any): Pick<EditorCard, 'readerQuestionsMax' | 'pollsPerWeek'> {
  if (!('format_prefs_json' in r) && !('profile_topic' in r)) return {}; // a row read without the profile join
  const caps = audienceCapsOfProfile({ format_prefs: r.format_prefs_json ?? {}, topic: r.profile_topic ?? null });
  return { readerQuestionsMax: caps.questionsPerDay, pollsPerWeek: caps.pollsPerWeek };
}

/**
 * Waiting and approved (not yet published) posts of a channel become `skipped`
 * with the reason `mode_changed`; their waiting platform rows are canceled.
 */
export async function dropWaitingPosts(db: Pick<Pool, 'query'>, channelKey: string): Promise<number> {
  const { rows } = await db.query(
    `UPDATE editor_slots SET status = 'skipped', error = 'mode_changed', updated_at = now()
      WHERE channel_key = $1 AND status IN ('awaiting_approval','approved') RETURNING platform_post_id`, [channelKey]);
  const ids = rows.map((r) => r.platform_post_id).filter((x) => x != null);
  if (ids.length) {
    await db.query(`UPDATE platform_posts SET status = 'canceled', error = 'mode_changed' WHERE id = ANY($1::bigint[]) AND status = 'awaiting_approval'`, [ids]);
  }
  return rows.length;
}

/** app_settings key of the spec 033 FR-003 capability flag: the ISO time until which rich messages are off. */
export const richUnsupportedKey = (channelKey: string) => `cap.tg_rich_unsupported:${channelKey}`;

/**
 * A card row plus what the renderer needs besides the card (spec 033):
 * format_prefs.rich of the resource and the live "rich unsupported" flag;
 * spec 034: format_prefs.humor / slang / emoji for the voice block and the slop lint.
 * The flag's value is an ISO time; anything else counts as no flag.
 */
const CARD_SELECT = `
  SELECT c.*,
         rp.profile->'format_prefs'->>'rich' AS rich_pref,
         rp.profile->'format_prefs'->>'humor' AS humor_pref,
         rp.profile->'format_prefs'->>'slang' AS slang_pref,
         rp.profile->'format_prefs'->>'emoji' AS emoji_pref,
         rp.profile->'format_prefs' AS format_prefs_json,
         rp.profile->>'topic' AS profile_topic,
         CASE WHEN s.value ~ '^\\d{4}-\\d{2}-\\d{2}T' THEN s.value::timestamptz > now() ELSE false END AS rich_unsupported
    FROM editor_channels c
    LEFT JOIN resource_profiles rp ON rp.resource_ref = 'telegram:' || c.channel_key
    LEFT JOIN app_settings s ON s.key = 'cap.tg_rich_unsupported:' || c.channel_key`;

export class EditorChannelsRepository {
  constructor(private readonly pool: Pool) {}

  async get(channelKey: string): Promise<(EditorCard & { createdAt: Date }) | null> {
    const { rows } = await this.pool.query(`${CARD_SELECT} WHERE c.channel_key = $1`, [channelKey]);
    return rows[0] ? rowToCard(rows[0]) : null;
  }

  async listActive(): Promise<Array<EditorCard & { createdAt: Date }>> {
    const { rows } = await this.pool.query(`${CARD_SELECT} WHERE c.mode <> 'off' ORDER BY c.channel_key`);
    return rows.map(rowToCard);
  }

  async list(): Promise<Array<EditorCard & { createdAt: Date }>> {
    const { rows } = await this.pool.query(`${CARD_SELECT} ORDER BY c.channel_key`);
    return rows.map(rowToCard);
  }

  /**
   * Create a card only when the channel has none (the chat's minimal card, spec
   * 010). Never touches an existing card. Returns true when a row was inserted.
   */
  async insertIfMissing(c: EditorCard): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO editor_channels (
         channel_key, mode, title, language, timezone, posts_per_day_min, posts_per_day_max,
         quiet_start_hour, quiet_end_hour, min_gap_minutes, plan_hour, brief, formats, hashtags,
         hashtag_min, hashtag_max, footer, link_style, emoji_policy, skills, sources, tools_allow,
         explore_ratio, daily_budget_usd, models, banned_terms, crosspost)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
       ON CONFLICT (channel_key) DO NOTHING`,
      [c.channelKey, c.mode, c.title, c.language, c.timezone, c.postsPerDayMin, c.postsPerDayMax,
        c.quietStartHour, c.quietEndHour, c.minGapMinutes, c.planHour, c.brief, JSON.stringify(c.formats), c.hashtags,
        c.hashtagMin, c.hashtagMax, c.footer, c.linkStyle, c.emojiPolicy, c.skills, JSON.stringify(c.sources), c.toolsAllow,
        c.exploreRatio, c.dailyBudgetUsd, JSON.stringify(c.models), c.bannedTerms, c.crosspost ?? true]);
    return (rowCount ?? 0) > 0;
  }

  /**
   * Spec 025 FR-009: a directive executor's write on a single-channel card without a playbook — the posts per
   * day range and/or the format weights (already validated and clamped by the executor).
   */
  async patchPlanning(channelKey: string, p: { postsPerDayMin?: number; postsPerDayMax?: number; formats?: Record<string, number> }): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE editor_channels SET posts_per_day_min = COALESCE($2, posts_per_day_min), posts_per_day_max = COALESCE($3, posts_per_day_max),
              formats = COALESCE($4::jsonb, formats), updated_at = now()
        WHERE channel_key = $1`,
      [channelKey, p.postsPerDayMin ?? null, p.postsPerDayMax ?? null, p.formats ? JSON.stringify(p.formats) : null]);
    return (rowCount ?? 0) > 0;
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

  /**
   * Owner upsert (006). Writes every card field; a mode change is audited in
   * editor_channel_memory as an owner `rule` in the same transaction. The audit
   * row is stored inactive so it stays out of the agents' prompts.
   */
  async upsert(c: EditorCard): Promise<{ card: EditorCard & { createdAt: Date }; previousMode: ChannelMode | null }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const prev = await client.query(`SELECT mode FROM editor_channels WHERE channel_key = $1 FOR UPDATE`, [c.channelKey]);
      const previousMode: ChannelMode | null = prev.rows[0]?.mode ?? null;
      // Spec 023 FR-012: no live switch while a strategy binding still publishes to the channel or its group.
      if (c.mode === 'live' && previousMode !== 'live') {
        const ext = await enabledBindingExtIds(client, await liveRefsOf(client, { scope: 'resource', scopeId: `telegram:${c.channelKey}` }));
        if (ext.length) throw bindingsStillEnabled(ext);
      }
      const { rows } = await client.query(
        `INSERT INTO editor_channels (
           channel_key, mode, title, language, timezone, posts_per_day_min, posts_per_day_max,
           quiet_start_hour, quiet_end_hour, min_gap_minutes, plan_hour, brief, formats, hashtags,
           hashtag_min, hashtag_max, footer, link_style, emoji_policy, skills, sources, tools_allow,
           explore_ratio, daily_budget_usd, models, banned_terms, crosspost)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
         ON CONFLICT (channel_key) DO UPDATE SET
           mode = EXCLUDED.mode, title = EXCLUDED.title, language = EXCLUDED.language, timezone = EXCLUDED.timezone,
           posts_per_day_min = EXCLUDED.posts_per_day_min, posts_per_day_max = EXCLUDED.posts_per_day_max,
           quiet_start_hour = EXCLUDED.quiet_start_hour, quiet_end_hour = EXCLUDED.quiet_end_hour,
           min_gap_minutes = EXCLUDED.min_gap_minutes, plan_hour = EXCLUDED.plan_hour, brief = EXCLUDED.brief,
           formats = EXCLUDED.formats, hashtags = EXCLUDED.hashtags, hashtag_min = EXCLUDED.hashtag_min,
           hashtag_max = EXCLUDED.hashtag_max, footer = EXCLUDED.footer, link_style = EXCLUDED.link_style,
           emoji_policy = EXCLUDED.emoji_policy, skills = EXCLUDED.skills, sources = EXCLUDED.sources,
           tools_allow = EXCLUDED.tools_allow, explore_ratio = EXCLUDED.explore_ratio,
           daily_budget_usd = EXCLUDED.daily_budget_usd, models = EXCLUDED.models,
           banned_terms = EXCLUDED.banned_terms, crosspost = EXCLUDED.crosspost, updated_at = now()
         RETURNING *`,
        [c.channelKey, c.mode, c.title, c.language, c.timezone, c.postsPerDayMin, c.postsPerDayMax,
          c.quietStartHour, c.quietEndHour, c.minGapMinutes, c.planHour, c.brief, JSON.stringify(c.formats), c.hashtags,
          c.hashtagMin, c.hashtagMax, c.footer, c.linkStyle, c.emojiPolicy, c.skills, JSON.stringify(c.sources), c.toolsAllow,
          c.exploreRatio, c.dailyBudgetUsd, JSON.stringify(c.models), c.bannedTerms, c.crosspost ?? true]);
      const from = previousMode ?? 'off';
      if (from !== c.mode) {
        await client.query(
          `INSERT INTO editor_channel_memory (channel_key, kind, text, evidence, created_by, active)
           VALUES ($1, 'rule', $2, $3, 'owner', false)`,
          [c.channelKey, `mode changed ${from}→${c.mode} by owner`,
            JSON.stringify({ audit: 'mode_change', from: previousMode, to: c.mode })]);
        // Spec 031: leaving approval for shadow/off drops the posts that still wait (nothing may go out).
        if (from === 'approve' && (c.mode === 'off' || c.mode === 'shadow')) await dropWaitingPosts(client, c.channelKey);
      }
      await client.query('COMMIT');
      return { card: rowToCard(rows[0]), previousMode };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
