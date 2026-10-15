import { dateFromUrl, localDay, mentionInstant, parseDateMentions, sourceAgeHours, WEEKDAY_NAME, weekdayOf, type DateMention } from '../../dates';
import { bodyText, excerptOf, type AuditCard, type AuditContext, type AuditPost, type Finding, type IntegrityCheck } from '../types';

/**
 * Spec 037 FR-005 (T5): dates and freshness, resolved against the post's (scheduled) publish instant in the resource
 * zone.
 *   • date_relative_mismatch (error): a relative word and the date next to it name different days («вже завтра,
 *     12 жовтня» in a post of 10.10);
 *   • weekday_mismatch (error): a weekday next to a date that falls on another day («у вівторок, 14 жовтня»);
 *   • relative_date_unanchored (warning): «завтра» / «з завтра» / «післязавтра» with no date next to it in a news post
 *     (resource content_kind news / games, or a post with a source line);
 *   • deal_expired (error) / deal_expiring (warning, under 6 h): a giveaway or deal «до <дата>» that is over at publish
 *     time (a deadline without a time ends during its day, so posting on that day is too late);
 *   • stale_now_word (warning): «щойно», «тільки-но», «прямо зараз» while the newest source, or the first post of the
 *     resource with the same article link, is older than 24 h;
 *   • stale_source (warning): the post's source is older than the resource freshness (style.freshness_hours, else
 *     content_kind news 36 h / games 72 h; evergreen, explainer and education resources are exempt; no kind → silent).
 * Source dates come from `ctx.sources` (pages and feed items the run read), else from a dated article URL
 * (`/2026/10/07/…`). Story repeats beyond a shared link are T2's.
 */

export const DEAL_EXPIRING_HOURS = 6;
export const NOW_WORD_MAX_HOURS = 24;
export const FRESHNESS_HOURS = { news: 36, games: 72 } as const;

const DEAL_RE = /(?<![\p{L}])(?:роздач|роздає|роздаю|розіграш|безкоштовн|безплатн|знижк|розпродаж|акці[яїюйє]|промокод|giveaway|free\b|sale\b)/iu;
const NOW_RE = /(?<![\p{L}])(щойно|тільки-но|тільки\s+що|прямо\s+зараз)(?![\p{L}])/iu;
const EXEMPT_KINDS = new Set(['evergreen', 'explainer', 'education']);

const normUrl = (u: string): string => u.trim().replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();
const ddmm = (date: string) => `${date.slice(8, 10)}.${date.slice(5, 7)}`;

function contentKind(card: AuditCard | undefined): string | undefined {
  const k = card?.style?.content_kind;
  return typeof k === 'string' ? k.toLowerCase() : undefined;
}

/** Hours after which the resource's source is stale; null when the resource does not say what it is. */
export function freshnessHoursOf(card: AuditCard | undefined): number | null {
  const kind = contentKind(card);
  if (kind && EXEMPT_KINDS.has(kind)) return null;
  const h = card?.style?.freshness_hours;
  if (typeof h === 'number' && h > 0) return h;
  if (kind === 'news') return FRESHNESS_HOURS.news;
  if (kind === 'games' || kind === 'gaming') return FRESHNESS_HOURS.games;
  return null;
}

/** An article page, not a site root or section («/p/buried-stars», «/2026/10/07/…»), so a shared link means one story. */
function articleLike(url: string): boolean {
  try {
    const segs = new URL(url).pathname.split('/').filter(Boolean);
    const last = segs[segs.length - 1] ?? '';
    return last.length >= 12 || /\d{5,}/.test(last) || !!dateFromUrl(url);
  } catch { return false; }
}

const urlsOf = (p: AuditPost): string[] =>
  [...new Set([p.sourceUrl, ...p.links.map((l) => l.url), ...p.buttons.map((b) => b.url)].filter((u): u is string => !!u))];

/** The publication date of a URL: the page / feed item the run read, else the date in the article path. */
function sourceDate(url: string, known: Map<string, string>): string | null {
  return known.get(normUrl(url)) ?? dateFromUrl(url);
}

function dateChecks(post: AuditPost, ctx: AuditContext, text: string): Finding[] {
  const out: Finding[] = [];
  const tz = post.timezone || ctx.card?.timezone || 'Europe/Kyiv';
  const publishDay = localDay(post.publishedAt, tz);
  const ms = parseDateMentions(text, { publishedAt: post.publishedAt, timezone: tz });
  const groups = new Map<number, DateMention[]>();
  for (const m of ms) groups.set(m.group, [...(groups.get(m.group) ?? []), m]);
  const groupText = (g: DateMention[]) => excerptOf(text.slice(g[0].span[0], g[g.length - 1].span[1]));
  const kind = contentKind(ctx.card);
  const newsLike = kind ? kind === 'news' || kind === 'games' || kind === 'gaming' : !!post.sourceUrl;
  const deal = DEAL_RE.test(text);
  let unanchored = false;

  for (const g of groups.values()) {
    const rel = g.filter((m) => m.kind === 'relative');
    const dates = g.filter((m) => m.kind === 'date' && !m.historical);
    if (g.some((m) => m.historical)) continue;

    for (const r of rel) {
      const d = dates.find((x) => x.date !== r.date);
      if (d) {
        out.push({
          code: 'date_relative_mismatch', level: 'error', excerpt: groupText(g),
          message: `«${r.text}» у пості від ${ddmm(publishDay)} — це ${ddmm(r.date!)}, а поруч стоїть «${d.text}» (${ddmm(d.date!)}): звір дату з джерелом (американське MM.DD?) і залиш одну правильну`,
        });
      }
    }

    for (const w of g.filter((m) => m.kind === 'weekday')) {
      const days = [...dates, ...rel];
      if (!days.length) continue;
      const day = days.reduce((a, b) => (Math.abs(a.span[0] - w.span[0]) <= Math.abs(b.span[0] - w.span[0]) ? a : b));
      const actual = weekdayOf(day.date!);
      if (actual !== w.weekday) {
        out.push({
          code: 'weekday_mismatch', level: 'error', excerpt: groupText(g),
          message: `«${w.text}» не збігається з датою: ${ddmm(day.date!)} — це ${WEEKDAY_NAME(actual)}`,
        });
      }
    }

    if (newsLike && !unanchored && !dates.length) {
      const r = rel.find((x) => (x.offset ?? 0) >= 1);
      if (r) {
        unanchored = true;
        out.push({
          code: 'relative_date_unanchored', level: 'warning', excerpt: excerptOf(text.slice(Math.max(0, r.span[0] - 40), r.span[1] + 20)),
          message: `«${r.text}» без дати: пост читатимуть і завтра — напиши дату (${ddmm(r.date!)}) або перевір, від якого дня рахує джерело`,
        });
      }
    }

    if (deal && g.some((m) => m.preposition === 'until')) {
      const day = dates[0] ?? rel[0];
      if (!day?.date) continue;
      const at = mentionInstant(day);
      const publish = Date.parse(post.publishedAt);
      if (at) {
        const left = (at.getTime() - publish) / 3_600_000;
        if (left <= 0) {
          out.push({ code: 'deal_expired', level: 'error', excerpt: groupText(g), message: `пропозиція «до ${groupText(g)}» уже завершилась на момент публікації` });
        } else if (left < DEAL_EXPIRING_HOURS) {
          out.push({ code: 'deal_expiring', level: 'warning', excerpt: groupText(g), message: `до кінця пропозиції менше ${DEAL_EXPIRING_HOURS} год (${left.toFixed(1)} год) на момент публікації` });
        }
      } else if (day.date <= publishDay) {
        out.push({
          code: 'deal_expired', level: 'error', excerpt: groupText(g),
          message: `пропозиція «до ${groupText(g)}», а пост виходить ${ddmm(publishDay)}: вона завершується сьогодні (час невідомий) або вже минула — такий пост не публікують`,
        });
      }
    }
  }
  return out;
}

function freshnessChecks(post: AuditPost, ctx: AuditContext, text: string): Finding[] {
  const out: Finding[] = [];
  const known = new Map<string, string>();
  for (const s of ctx.sources ?? []) if (s.url && s.publishedAt) known.set(normUrl(s.url), s.publishedAt);

  const now = NOW_RE.exec(text);
  if (now) {
    const ages = urlsOf(post).map((u) => sourceAgeHours(sourceDate(u, known), post.publishedAt)).filter((a): a is number => a != null);
    const sourceAge = ages.length ? Math.min(...ages) : null;
    const mine = new Set(urlsOf(post).filter(articleLike).map(normUrl));
    const first = [...ctx.previous].reverse().find((p) => urlsOf(p).some((u) => mine.has(normUrl(u))));
    const storyAge = first ? (Date.parse(post.publishedAt) - Date.parse(first.publishedAt)) / 3_600_000 : null;
    const stale = [sourceAge != null && sourceAge > NOW_WORD_MAX_HOURS ? `джерелу ${Math.round(sourceAge)} год` : null,
      storyAge != null && storyAge > NOW_WORD_MAX_HOURS ? `перший пост про це вийшов ${Math.round(storyAge)} год тому` : null].filter(Boolean);
    if (stale.length) {
      out.push({
        code: 'stale_now_word', level: 'warning', excerpt: excerptOf(text.slice(Math.max(0, now.index - 30), now.index + now[0].length + 40)),
        message: `«${now[1]}» про те, що сталося понад ${NOW_WORD_MAX_HOURS} год тому (${stale.join('; ')}): прибери слово або дай новий факт`,
      });
    }
  }

  const limit = freshnessHoursOf(ctx.card);
  if (limit != null) {
    const primary = post.sourceUrl ?? urlsOf(post).find((u) => known.has(normUrl(u)));
    const age = primary ? sourceAgeHours(sourceDate(primary, known), post.publishedAt) : null;
    if (age != null && age > limit) {
      out.push({
        code: 'stale_source', level: 'warning', excerpt: primary,
        message: `джерелу ${Math.round(age)} год, поріг свіжості ресурсу ${limit} год: потрібен кут «чому зараз» або свіжіше джерело`,
      });
    }
  }
  return out;
}

export const datesCheck: IntegrityCheck = {
  id: 'dates',
  codes: ['date_relative_mismatch', 'weekday_mismatch', 'relative_date_unanchored', 'stale_now_word', 'deal_expired', 'deal_expiring', 'stale_source'],
  run: (post, ctx) => {
    const text = [bodyText(post), post.poll?.question ?? '', ...(post.poll?.options ?? [])].filter(Boolean).join('\n');
    return [...dateChecks(post, ctx, text), ...freshnessChecks(post, ctx, text)];
  },
};
