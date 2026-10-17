import { localDate, localHour } from '../roles/time';
import { hasPostText, type SetupPost } from './setup-posts.types';

/**
 * Spec 042 FR-002: what a channel's last posts show, computed in code (no LLM). The model gets these numbers with the
 * texts and has to agree with them (FR-003 checks); the owner sees them in the proposal dialog.
 */

/** The channel's post formats as the card knows them; `other` = media we cannot tell (a poll, a file, an album part). */
export type ObservedFormat = 'text' | 'photo' | 'video' | 'other';

export interface ChannelMetrics {
  posts:       number;
  /** Spec 041 FR-008: posts with text; the text medians and shares count only these. */
  textPosts?:  number;
  timezone:    string;
  /** Days from the oldest to the newest post (≥ 1), the days with a post, and posts per active day. */
  spanDays:    number;
  activeDays:  number;
  perDay:      number;
  /** Posts per local hour 0–23. */
  hours:       number[];
  /** Up to 3 hours with the best median views (≥ 2 posts each), best first; by post count when there are no views. */
  peakHours:   number[];
  /** The longest run of hours without a post: quiet from `start` to `end` (exclusive), null when every hour has posts. */
  quiet:       { start: number; end: number } | null;
  /** Share of posts per format (sums to 1). */
  formatMix:   Partial<Record<ObservedFormat, number>>;
  length:      { median: number; p90: number };
  /** Median count of line breaks per post. */
  lineBreaks:  number;
  emoji:       { share: number; median: number };
  hashtags:    { share: number; vocabulary: string[] };
  links:       number;
  mentions:    number;
  cta:         number;
  /** A last line repeated in ≥ 30 % of the posts (the channel's signature / footer). */
  signature:   string | null;
  address:     { ty: number; vy: number };
  /** Post keys by engagement ((reactions + forwards + comments) / views), best first (top 5). */
  topPosts:    string[];
  /** Repeated openings (leading emoji + first words) seen in ≥ 2 posts: rubric candidates. */
  rubrics:     Array<{ label: string; posts: string[] }>;
  medianViews: number | null;
}

export const EMOJI_RE = /\p{Extended_Pictographic}/gu;
export const HASHTAG_RE = /#([\p{L}\p{N}_]{1,50})/gu;
const LINK_RE = /https?:\/\/\S+|\bt\.me\/\S+/iu;
const MENTION_RE = /(?:^|[^\p{L}\p{N}_])@[A-Za-z][A-Za-z0-9_]{3,}/u;
const CTA_RE = /(?<![\p{L}])(?:підпис\p{L}*|пиш\p{L}*\s+в\s+коментар\p{L}*|діл\p{L}*сь|постав\p{L}*|переход\p{L}*|чита\p{L}*\s+(?:далі|більше)|дивіть\p{L}*|голосу\p{L}*|долуча\p{L}*|subscribe|follow|share|join|read\s+more)(?![\p{L}])|👇|⬇️/iu;
const TY_RE = /(?<![\p{L}])(?:ти|тебе|тобі|тобою|твій|твоя|твоє|твої|твого|твоїх)(?![\p{L}])/giu;
const VY_RE = /(?<![\p{L}])(?:ви|вас|вам|вами|ваш|ваша|ваше|ваші|вашого|ваших)(?![\p{L}])/giu;

/** The format a post was published in, from the stored media flags. */
export function observedFormat(p: Pick<SetupPost, 'hasMedia' | 'mediaType'>): ObservedFormat {
  if (!p.hasMedia) return 'text';
  if (p.mediaType === 'photo') return 'photo';
  if (p.mediaType === 'video') return 'video';
  return 'other';
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

const share = (n: number, total: number) => (total ? Math.round((n / total) * 100) / 100 : 0);

const lastLine = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';

/** (reactions + forwards + comments) / views; null without views. */
export function engagementOf(p: SetupPost): number | null {
  if (!p.views) return null;
  return ((p.reactionsTotal ?? 0) + (p.forwards ?? 0) + (p.comments ?? 0)) / p.views;
}

/** The longest circular run of hours with no posts → quiet window [start, end); null when none or shorter than 3 h. */
function quietWindow(hours: number[]): { start: number; end: number } | null {
  let best: { start: number; len: number } | null = null;
  for (let start = 0; start < 24; start++) {
    if (hours[start] !== 0 || hours[(start + 23) % 24] === 0) continue;
    let len = 0;
    while (len < 24 && hours[(start + len) % 24] === 0) len++;
    if (!best || len > best.len) best = { start, len };
  }
  if (!best || best.len < 3 || best.len >= 24) return null;
  return { start: best.start, end: (best.start + best.len) % 24 };
}

/** The opening of a post that marks a rubric: leading emoji + the first three words, lowercased; null for a plain start. */
export function openingKey(text: string): string | null {
  const first = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const emoji = (first.match(/^(?:\p{Extended_Pictographic}|️|‍)+/u)?.[0] ?? '').replace(/[️‍]/g, '');
  let rest = first.replace(/^[^\p{L}\p{N}#]+/u, '');
  // «Порада дня: …», «Огляд тижня — …»: a short label before a colon or a dash is the rubric's name.
  const label = rest.match(/^(.{2,40}?)\s*(?::|\s[—–-]\s|\|)/u)?.[1];
  if (label && label.split(/\s+/).length <= 4) rest = label;
  const words = rest.split(/\s+/).map((w) => w.toLowerCase().replace(/[^\p{L}#]/gu, '')).filter(Boolean).slice(0, 3);
  if (!words.length) return null;
  // A hashtag or an emoji start is a strong marker; plain text needs the same three words.
  return `${emoji}${emoji ? ' ' : ''}${words.join(' ')}`;
}

export function computeMetrics(posts: SetupPost[], timezone: string): ChannelMetrics {
  const n = posts.length;
  const hours = new Array(24).fill(0) as number[];
  const viewsByHour = new Map<number, number[]>();
  const days = new Set<string>();
  for (const p of posts) {
    const h = localHour(p.postedAt, timezone);
    hours[h]++;
    if (p.views != null) viewsByHour.set(h, [...(viewsByHour.get(h) ?? []), p.views]);
    days.add(localDate(p.postedAt, timezone));
  }
  const times = posts.map((p) => p.postedAt.getTime());
  const spanDays = n ? Math.max(1, Math.ceil((Math.max(...times) - Math.min(...times)) / 86_400_000)) : 0;

  const withViews = [...viewsByHour.entries()].filter(([, v]) => v.length >= 2);
  const peakHours = (withViews.length
    ? withViews.sort((a, b) => median(b[1]) - median(a[1]) || b[1].length - a[1].length).map(([h]) => h)
    : hours.map((c, h) => [h, c] as const).filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).map(([h]) => h)
  ).slice(0, 3);

  const mix: Partial<Record<ObservedFormat, number>> = {};
  for (const p of posts) { const f = observedFormat(p); mix[f] = (mix[f] ?? 0) + 1; }
  for (const k of Object.keys(mix) as ObservedFormat[]) mix[k] = share(mix[k]!, n);

  // Spec 041 FR-008: a media post without text is not a zero-length, zero-emoji post — style numbers come from text.
  const texts = posts.filter(hasPostText).map((p) => p.text);
  const nt = texts.length;
  const emojiCounts = texts.map((t) => (t.match(EMOJI_RE) ?? []).length);
  const tags = new Map<string, number>();
  let tagged = 0;
  for (const t of texts) {
    const found = [...t.matchAll(HASHTAG_RE)].map((m) => m[1].toLowerCase());
    if (found.length) tagged++;
    for (const tag of new Set(found)) tags.set(tag, (tags.get(tag) ?? 0) + 1);
  }
  const lastLines = new Map<string, number>();
  for (const t of texts) {
    const l = lastLine(t).replace(/\s+/g, ' ');
    if (l.length >= 3 && l.length <= 200) lastLines.set(l, (lastLines.get(l) ?? 0) + 1);
  }
  const sig = [...lastLines.entries()].sort((a, b) => b[1] - a[1])[0];

  const engaged = posts.map((p) => ({ key: p.key, e: engagementOf(p), v: p.views ?? 0 }))
    .sort((a, b) => (b.e ?? -1) - (a.e ?? -1) || b.v - a.v);

  const groups = new Map<string, string[]>();
  for (const p of posts) {
    const k = openingKey(p.text ?? '');
    if (k) groups.set(k, [...(groups.get(k) ?? []), p.key]);
  }
  const views = posts.map((p) => p.views).filter((v): v is number => v != null);

  return {
    posts: n, textPosts: nt, timezone, spanDays, activeDays: days.size,
    perDay: days.size ? Math.round((n / days.size) * 10) / 10 : 0,
    hours, peakHours, quiet: quietWindow(hours),
    formatMix: mix,
    length: { median: median(texts.map((t) => t.length)), p90: percentile(texts.map((t) => t.length), 90) },
    lineBreaks: median(texts.map((t) => (t.match(/\n/g) ?? []).length)),
    emoji: { share: share(emojiCounts.filter((c) => c > 0).length, nt), median: median(emojiCounts.filter((c) => c > 0)) },
    hashtags: { share: share(tagged, nt), vocabulary: [...tags.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).map(([t]) => t).slice(0, 20) },
    links: share(texts.filter((t) => LINK_RE.test(t)).length, nt),
    mentions: share(texts.filter((t) => MENTION_RE.test(t)).length, nt),
    cta: share(texts.filter((t) => CTA_RE.test(lastLine(t))).length, nt),
    signature: sig && sig[1] >= 2 && sig[1] / Math.max(1, nt) >= 0.3 ? sig[0] : null,
    address: {
      ty: texts.reduce((a, t) => a + (t.match(TY_RE) ?? []).length, 0),
      vy: texts.reduce((a, t) => a + (t.match(VY_RE) ?? []).length, 0),
    },
    topPosts: engaged.slice(0, 5).map((x) => x.key),
    rubrics: [...groups.entries()].filter(([, ps]) => ps.length >= 2).sort((a, b) => b[1].length - a[1].length)
      .slice(0, 8).map(([label, ps]) => ({ label, posts: ps })),
    medianViews: views.length ? median(views) : null,
  };
}

/** The metrics for the prompt (Ukrainian, like the other prompts). */
export function renderMetrics(m: ChannelMetrics): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const mix = Object.entries(m.formatMix).map(([f, s]) => `${f} ${pct(s!)}`).join(', ');
  return [
    `Постів: ${m.posts} за ${m.spanDays} дн., днів з постами ${m.activeDays}, у середньому ${m.perDay} на активний день.`,
    `Години (${m.timezone}): ${m.hours.map((c, h) => (c ? `${h}:00×${c}` : '')).filter(Boolean).join(', ')}.`,
    `Найкращі години за медіаною переглядів: ${m.peakHours.length ? m.peakHours.map((h) => `${h}:00`).join(', ') : 'замало даних'}.`,
    `Тиха пора без постів: ${m.quiet ? `${m.quiet.start}:00–${m.quiet.end}:00` : 'немає'}.`,
    `Формати: ${mix}.`,
    m.textPosts != null && m.textPosts < m.posts ? `Постів із текстом: ${m.textPosts} з ${m.posts}; довжина, емодзі, хештеги, посилання й звертання нижче — лише з них.` : null,
    `Довжина: медіана ${m.length.median} символів, p90 ${m.length.p90}; переносів рядка в пості (медіана) ${m.lineBreaks}.`,
    `Емодзі: у ${pct(m.emoji.share)} постів, медіана ${m.emoji.median} на пост.`,
    `Хештеги: у ${pct(m.hashtags.share)} постів${m.hashtags.vocabulary.length ? `; повторювані: ${m.hashtags.vocabulary.map((t) => `#${t}`).join(' ')}` : ''}.`,
    `Посилання: ${pct(m.links)}; згадки @: ${pct(m.mentions)}; заклик в останньому рядку: ${pct(m.cta)}.`,
    `Підпис (останній рядок, що повторюється): ${m.signature ? `«${m.signature}»` : 'немає'}.`,
    `Звертання: «ти»-форм ${m.address.ty}, «ви»-форм ${m.address.vy}.`,
    `Медіана переглядів: ${m.medianViews ?? 'невідомо'}; найкраще залучення: ${m.topPosts.join(', ') || '—'}.`,
    `Повторювані початки (кандидати в рубрики): ${m.rubrics.length ? m.rubrics.map((r) => `«${r.label}» (${r.posts.join(', ')})`).join('; ') : 'немає'}.`,
  ].filter((x) => x !== null).join('\n');
}
