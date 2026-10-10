import type { Pool } from 'pg';
import type { EditorCard } from '../card';
import { SUPPORTED_FORMATS } from '../post/post-spec';
import { isPlaceholderPlan } from '../repo/editor-plans.repository';
import { isQuietHour, localDate, localHour, zonedToUtc } from '../roles/time';
import { filterFresh, readFeed, type FeedItem, type HttpSeams } from './feed-items';
import { liveTopicLabel, type LiveSpec } from './live-slot';
import {
  itemScore, keywordHits, NEWS_WATCH_MIN_SCORE, newsWatchConfig, type NewsWatch, type ResolvedNewsWatch,
} from './news-watch-config';

/**
 * The news watch (spec 034 FR-011): on a news resource, every `every_hours` within its active hours, a
 * code-only check (no LLM) of the card's feeds. A fresh, unposted, non-repeating, on-topic item becomes a
 * live slot 15–30 min ahead when the day has room (posts_per_day_max, `max_per_day` added slots, quiet
 * hours, min gap). Every decision is logged in news_watch_log (migration 067).
 */

export interface NewsWatchDeps {
  pool:    Pick<Pool, 'query'>;
  /** The resource profile of `telegram:<key>` (topic and the owner's news_watch settings). */
  profile: (ref: string) => Promise<{ topic?: string | null; news_watch?: NewsWatch | null } | null>;
  http?:   HttpSeams;
  log?:    (msg: string) => void;
}

export type NewsWatchOutcome =
  | { status: 'off' | 'outside_hours' | 'not_due' | 'no_plan' }
  | { status: 'checked'; added: { slotId: string; url: string; at: Date } | null; reason: string };

/** A new slot lands this far ahead (minutes): enough to write it, soon enough to be news. */
export const NEWS_WATCH_LEAD_MIN = [15, 20, 25, 30] as const;
const CONFIG_TTL_MS = 10 * 60_000;
const ACTIVE = `('planned','running','awaiting_approval','approved','published','shadowed')`;
/** Formats a news slot may take, in order of preference (the card must allow it). */
const NEWS_FORMATS = ['news', 'text', 'photo'];

interface Candidate extends FeedItem { feed: string; age_hours: number; hits: number; score: number }

export class NewsWatchService {
  private readonly last = new Map<string, number>();
  private readonly config = new Map<string, { at: number; cfg: ResolvedNewsWatch | null }>();

  constructor(private readonly d: NewsWatchDeps) {}

  private async cfgOf(card: EditorCard, now: Date): Promise<ResolvedNewsWatch | null> {
    const hit = this.config.get(card.channelKey);
    if (hit && now.getTime() - hit.at < CONFIG_TTL_MS) return hit.cfg;
    const profile = await this.d.profile(`telegram:${card.channelKey}`).catch(() => null);
    const cfg = newsWatchConfig(card, profile);
    this.config.set(card.channelKey, { at: now.getTime(), cfg });
    return cfg;
  }

  /** Drop the cached settings of a channel (after the owner edits its profile). */
  invalidate(channelKey: string): void {
    this.config.delete(channelKey);
  }

  private async lastCheck(channelKey: string): Promise<number> {
    const mem = this.last.get(channelKey);
    if (mem !== undefined) return mem;
    const { rows } = await this.d.pool.query(
      `SELECT max(checked_at) AS at FROM news_watch_log WHERE channel_key = $1 AND decision = 'checked'`, [channelKey]);
    const at = rows[0]?.at ? new Date(rows[0].at).getTime() : 0;
    this.last.set(channelKey, at);
    return at;
  }

  /** One scheduler tick for one card (cheap when not due). `force` ignores the cadence (tests, the owner). */
  async check(card: EditorCard, now: Date, o: { force?: boolean } = {}): Promise<NewsWatchOutcome> {
    if (card.mode === 'off') return { status: 'off' };
    const cfg = await this.cfgOf(card, now);
    if (!cfg) return { status: 'off' };
    const hour = localHour(now, card.timezone);
    if (hour < cfg.fromHour || hour >= cfg.toHour) return { status: 'outside_hours' };
    if (!o.force && now.getTime() - (await this.lastCheck(card.channelKey)) < cfg.everyHours * 3_600_000) return { status: 'not_due' };
    const date = localDate(now, card.timezone);
    const { rows: plans } = await this.d.pool.query(
      `SELECT id, rationale FROM editor_plans WHERE channel_key = $1 AND plan_date = $2 AND status = 'active'`, [card.channelKey, date]);
    // The day is not planned yet: the planner makes its live slots; the watch starts after it.
    if (!plans[0] || isPlaceholderPlan(plans[0].rationale)) return { status: 'no_plan' };
    this.last.set(card.channelKey, now.getTime());
    const res = await this.run(card, cfg, plans[0].id, date, now);
    await this.logRow(card, { decision: 'checked', reason: res.reason, slotId: res.added?.slotId ?? null });
    return { status: 'checked', ...res };
  }

  private async run(card: EditorCard, cfg: ResolvedNewsWatch, planId: string, date: string, now: Date) {
    const ref = `telegram:${card.channelKey}`;
    const items: Array<FeedItem & { feed: string }> = [];
    let failed = 0;
    for (const f of cfg.feeds) {
      try {
        items.push(...(await readFeed(f.url, now, this.d.http)).items.map((it) => ({ ...it, feed: f.id })));
      } catch (err: any) {
        failed++;
        this.d.log?.(`news watch ${card.channelKey}: feed ${f.id} failed: ${err?.message ?? err}`);
      }
    }
    const fresh = await filterFresh(items, { sinceHours: cfg.maxAgeHours, pool: this.d.pool, resourceRef: ref, now });
    const summary = (extra: string) =>
      `${cfg.feeds.length - failed}/${cfg.feeds.length} feed(s), ${items.length} item(s): ${fresh.kept.length} fresh and new `
      + `(${fresh.dropped.old} old, ${fresh.dropped.undated} undated, ${fresh.dropped.posted} posted, ${fresh.dropped.similar} similar); ${extra}`;

    const logged = await this.recentlyLogged(card.channelKey, fresh.kept.map((x) => x.link!));
    const scored: Candidate[] = fresh.kept.map((x) => {
      const hits = keywordHits(`${x.title ?? ''} ${x.snippet}`, cfg.keywords);
      return { ...x, hits, score: itemScore(x.age_hours, cfg.maxAgeHours, hits, cfg.keywords.length) };
    }).sort((a, b) => b.score - a.score);
    const eligible: Candidate[] = [];
    for (const c of scored) {
      const why = cfg.keywords.length && !c.hits ? 'off_topic' : c.score < NEWS_WATCH_MIN_SCORE ? 'low_score' : null;
      if (why) await this.ignore(card, c, why, logged);
      else eligible.push(c);
    }
    if (!eligible.length) return { added: null, reason: summary('nothing to add') };

    const block = await this.roomBlock(card, cfg, date, now);
    if (block) {
      for (const c of eligible) await this.ignore(card, c, block, logged);
      return { added: null, reason: summary(`not added: ${block}`) };
    }
    const at = await this.freeTime(card, now);
    if (!at) {
      for (const c of eligible) await this.ignore(card, c, 'no_gap', logged);
      return { added: null, reason: summary('not added: no_gap') };
    }
    const format = NEWS_FORMATS.find((f) => Number(card.formats[f] ?? 0) > 0 && (SUPPORTED_FORMATS as readonly string[]).includes(f));
    if (!format) {
      for (const c of eligible) await this.ignore(card, c, 'no_format', logged);
      return { added: null, reason: summary('not added: no_format (the card allows none of news, text, photo)') };
    }
    const best = eligible[0];
    const item = { url: best.link!, title: (best.title ?? best.link!).slice(0, 300), published_at: best.date };
    const live: LiveSpec = {
      sources: [cfg.feeds.find((f) => f.id === best.feed)?.id ?? best.feed], brief: `Свіжа новина з фіду: «${item.title}». Перевір першоджерело і подай коротко, по суті.`.slice(0, 400),
      max_age_hours: Math.max(cfg.maxAgeHours, 6), origin: 'news_watch', item,
    };
    const { rows } = await this.d.pool.query(
      `INSERT INTO editor_slots (plan_id, channel_key, scheduled_at, format, topic, source_hints, is_experiment, topic_mode, live_spec)
       VALUES ($1, $2, $3, $4, $5, $6, false, 'live', $7) RETURNING id`,
      [planId, card.channelKey, at, format, liveTopicLabel(live.sources, item), JSON.stringify([item.url, `feed:${best.feed}`]), JSON.stringify(live)]);
    const slotId: string = rows[0].id;
    await this.logRow(card, { decision: 'added', reason: `score ${best.score}, ${best.age_hours} h old, ${best.hits} keyword(s); slot at ${at.toISOString()}`, item: best, slotId });
    for (const c of eligible.slice(1)) await this.ignore(card, c, 'not_best', logged);
    return { added: { slotId, url: item.url, at }, reason: summary(`added «${item.title}»`) };
  }

  /** Why the day has no room for one more slot (null = it has). */
  private async roomBlock(card: EditorCard, cfg: ResolvedNewsWatch, date: string, now: Date): Promise<string | null> {
    if (cfg.maxPerDay <= 0) return 'daily_cap';
    const from = zonedToUtc(date, '00:00', card.timezone);
    const to = new Date(from.getTime() + 86_400_000);
    const { rows } = await this.d.pool.query(
      `SELECT count(*) FILTER (WHERE live_spec->>'origin' = 'news_watch')::int AS watch,
              count(*) FILTER (WHERE status IN ${ACTIVE})::int AS active
         FROM editor_slots WHERE channel_key = $1 AND resource_ref IS NULL AND scheduled_at >= $2 AND scheduled_at < $3`,
      [card.channelKey, from, to]);
    if (Number(rows[0]?.watch ?? 0) >= cfg.maxPerDay) return 'daily_cap';
    const { rows: pub } = await this.d.pool.query(
      `SELECT count(*)::int AS n FROM published_posts WHERE channel_id = $1 AND posted_at >= $2`, [card.channelKey, from]);
    if (Math.max(Number(rows[0]?.active ?? 0), Number(pub[0]?.n ?? 0)) >= card.postsPerDayMax) return 'day_full';
    if (now.getTime() >= to.getTime()) return 'day_over';
    return null;
  }

  /** The first of now + 15/20/25/30 min outside quiet hours and ≥ min_gap from every post of the channel. */
  private async freeTime(card: EditorCard, now: Date): Promise<Date | null> {
    const gap = card.minGapMinutes * 60_000;
    const { rows } = await this.d.pool.query(
      `SELECT scheduled_at AS at FROM editor_slots
        WHERE channel_key = $1 AND resource_ref IS NULL AND status IN ${ACTIVE}
          AND scheduled_at BETWEEN $2::timestamptz - interval '1 day' AND $2::timestamptz + interval '1 day'
       UNION ALL
       SELECT max(posted_at) FROM published_posts WHERE channel_id = $3`, [card.channelKey, now, card.channelKey]);
    const taken = rows.map((r: any) => (r.at ? new Date(r.at).getTime() : null)).filter((x): x is number => x != null);
    const base = Math.ceil(now.getTime() / 60_000) * 60_000;
    for (const m of NEWS_WATCH_LEAD_MIN) {
      const t = base + m * 60_000;
      if (isQuietHour(localHour(new Date(t), card.timezone), card.quietStartHour, card.quietEndHour)) continue;
      if (taken.every((x) => Math.abs(x - t) >= gap)) return new Date(t);
    }
    return null;
  }

  /** Items already logged for this channel in the last 24 h (an ignored item is logged once a day). */
  private async recentlyLogged(channelKey: string, urls: string[]): Promise<Set<string>> {
    if (!urls.length) return new Set();
    const { rows } = await this.d.pool.query(
      `SELECT DISTINCT item_url FROM news_watch_log WHERE channel_key = $1 AND item_url = ANY($2::text[]) AND checked_at > now() - interval '1 day'`,
      [channelKey, urls]);
    return new Set(rows.map((r: any) => String(r.item_url)));
  }

  private async ignore(card: EditorCard, c: Candidate, reason: string, logged: Set<string>): Promise<void> {
    if (logged.has(c.link!)) return;
    logged.add(c.link!);
    await this.logRow(card, { decision: 'ignored', reason, item: c });
  }

  private async logRow(card: EditorCard, r: { decision: 'checked' | 'added' | 'ignored'; reason: string; item?: Candidate; slotId?: string | null }): Promise<void> {
    try {
      const at = r.item?.date ? new Date(r.item.date) : null;
      await this.d.pool.query(
        `INSERT INTO news_watch_log (channel_key, resource_ref, decision, reason, item_url, item_title, item_at, feed, score, slot_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [card.channelKey, `telegram:${card.channelKey}`, r.decision, r.reason.slice(0, 1000), r.item?.link ?? null, r.item?.title?.slice(0, 500) ?? null,
          at && !Number.isNaN(at.getTime()) ? at : null, r.item?.feed ?? null, r.item ? r.item.score : null, r.slotId ?? null]);
    } catch (err: any) {
      this.d.log?.(`news watch log of ${card.channelKey} failed: ${err?.message ?? err}`);
    }
  }
}
