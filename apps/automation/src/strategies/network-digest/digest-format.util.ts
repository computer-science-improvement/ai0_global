// Pure formatting helpers shared by the digest strategies (network-digest,
// topic-digest). No DB, no network — fully unit-testable.
//
// Digests are DETERMINISTIC HTML: they bypass the AI ReviewAgent on purpose —
// its 1024-token output cap would truncate a multi-link digest and an AI pass
// can mangle <a href> URLs. Titles were already AI-written and reviewed by the
// source strategies, so the digest only assembles and escapes them.
import { escapeHtml } from '../../common/html';

/**
 * Recommended binding schedule for network-digest / topic-digest: every 10 min
 * from 19:00 to 20:50 (Kyiv — the scheduler's zone). A single "0 19 * * *"
 * tick loses the whole day whenever the channel's 20-min posting cooldown or
 * another strategy's in-flight lock happens to be active at 19:00; the window
 * retries, and the date-keyed posted_news sentinel turns every tick after the
 * first successful publish into a cheap no-op. Suggested by the dashboard's
 * new-strategy form for both digest types.
 */
export const DIGEST_RETRY_SCHEDULE = '*/10 19-20 * * *';

/** Prefix for titles of non-news strategies, whose published_posts.title is
 *  not a headline (quotes store the author, prompts the raw prompt text…). */
const TITLE_PREFIX: Record<string, string> = {
  'quotes':            'Цитата',
  'ai0-prompts':       'Промпт',
  'curated-prompts':   'Промпт',
  'recipes':           'Рецепт',
  'recipe-carousel':   'Рецепт',
  'birthday-strategy': 'Біографія',
  'pdr-quiz':          'Тест ПДР',
};

/**
 * Digest line title from a published_posts row: HTML tags stripped, whitespace
 * collapsed, and a type label for strategies whose stored title isn't a
 * headline (e.g. quotes → "Цитата: <author>"). Escaping happens at render.
 */
export function digestTitle(title: string, strategyType: string | null | undefined): string {
  const clean = title.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const prefix = strategyType ? TITLE_PREFIX[strategyType] : undefined;
  if (!prefix) return clean;
  if (strategyType === 'quotes' && (!clean || clean.toLowerCase() === 'quote')) return 'Цитата дня';
  return clean ? `${prefix}: ${clean}` : prefix;
}

/** True when the item's channel can be deep-linked (public @username). */
export function isLinkable(it: Pick<DigestItem, 'channelKey' | 'username'>): boolean {
  return linkUsername(it.channelKey, it.username) !== null;
}

/** Telegram hard message limit is 4096; leave headroom for safety. */
export const DIGEST_CHAR_BUDGET = 3800;

export interface DigestItem {
  /** Channel key like '@ai_news_local' (or username without @). */
  channelKey: string;
  /** Explicit username when known; falls back to channelKey minus '@'. */
  username: string | null;
  messageId: number;
  title: string;
  views: number | null;
  postedAt: Date;
}

export interface SponsorSlot {
  text: string;
  url: string;
}

export interface DigestRenderOptions {
  header: string;
  items: DigestItem[];
  /** Footer stats line, e.g. '+12 підписників · 9 постів'. Optional. */
  statsLine?: string | null;
  ctaText?: string | null;
  sponsor?: SponsorSlot | null;
  charBudget?: number;
}

// Re-exported for existing importers; the implementation lives in common/html.
export { escapeHtml };

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** t.me deep-link username for a channel, or null when not linkable
 *  (private channels / invite keys / numeric ids can't be deep-linked). */
export function linkUsername(channelKey: string, username: string | null): string | null {
  if (username && username.trim()) return username.trim().replace(/^@/, '');
  const key = channelKey.trim();
  if (key.startsWith('@') && key.length > 1) return key.slice(1);
  return null;
}

/**
 * Ranking score: views per hour with a 3h floor, so a fresh post isn't
 * infinitely boosted and a morning post doesn't win purely by accrual time.
 * Posts without any snapshot rank at 0 (still listable, just last).
 */
export function viewsPerHour(views: number | null, postedAt: Date, now: Date): number {
  if (views == null || views <= 0) return 0;
  const hours = Math.max((now.getTime() - postedAt.getTime()) / 3_600_000, 3);
  return views / hours;
}

function itemLine(it: DigestItem): string | null {
  const user = linkUsername(it.channelKey, it.username);
  if (!user) return null;
  const title = escapeHtml(truncate(it.title.trim(), 90));
  const views = it.views != null && it.views > 0 ? ` — 👁 ${it.views.toLocaleString('uk-UA')}` : '';
  return `🔘 <a href="https://t.me/${user}/${it.messageId}">${title}</a>${views}`;
}

/**
 * Assemble the digest post. Header + footer are reserved FIRST; items are
 * added while they fit the budget — the result is guaranteed under the
 * Telegram limit without splitting.
 */
export function renderDigest(opts: DigestRenderOptions): { text: string; itemsUsed: number } {
  const budget = opts.charBudget ?? DIGEST_CHAR_BUDGET;

  const footerParts: string[] = [];
  if (opts.statsLine) footerParts.push(`📈 ${escapeHtml(opts.statsLine)}`);
  if (opts.ctaText)   footerParts.push(escapeHtml(opts.ctaText));
  if (opts.sponsor) {
    footerParts.push(
      `—\n<b>Партнер дайджесту:</b> <a href="${escapeAttr(opts.sponsor.url)}">${escapeHtml(opts.sponsor.text)}</a>  <i>#реклама</i>`,
    );
  }

  const header = `📑 <b>${escapeHtml(opts.header)}</b>`;
  const footer = footerParts.length ? `\n\n${footerParts.join('\n\n')}` : '';
  const fixedLen = header.length + footer.length + 2; // +2 for the blank line after header

  const lines: string[] = [];
  let used = fixedLen;
  let itemsUsed = 0;
  for (const it of opts.items) {
    const line = itemLine(it);
    if (!line) continue;
    const cost = line.length + 1; // newline
    if (used + cost > budget) break;
    lines.push(line);
    used += cost;
    itemsUsed++;
  }

  const text = `${header}\n\n${lines.join('\n')}${footer}`;
  return { text, itemsUsed };
}

/** Kyiv calendar date (YYYY-MM-DD) — the dedup key for one-digest-per-day. */
export function kyivDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(now);
}
