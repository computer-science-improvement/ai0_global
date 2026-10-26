import type { EditorCard } from '../../card';
import type { VoicePrefs } from '../slop-lint';
import type { ResourceStyle } from '../style/resource-style';

/**
 * Spec 037 FR-001: the integrity check seam. Every deterministic content check of the epic (story repeats, dates,
 * text hygiene, style, polls, sources, …) runs on one platform-neutral view of a post, `AuditPost`, built either
 * from a PostSpec before publishing (`from-post-spec.ts`) or from a published post (Telegram Desktop export,
 * `tg-export.ts`; later the post audit of T14). A check is a pure function of the post and its context; it never
 * reads the DB or the network.
 */

export type AuditMediaKind = 'photo' | 'video' | 'document' | 'other';

export interface AuditPoll {
  question: string;
  options: string[];
  kind: 'regular' | 'quiz';
  anonymous: boolean;
  /** Quiz only, when known (a PostSpec has it; a Telegram export does not show it). */
  correctIndex?: number;
  explanation?: string;
}

/** One post as the reader sees it, normalised across sources and platforms. */
export interface AuditPost {
  /** Stable id: `<channel slug>:<message id>` for an export, the slot id for a spec. */
  id: string;
  /** Channel / resource title or key. */
  channel: string;
  /** Publish (or scheduled) instant, ISO 8601 with the offset, e.g. `2026-10-07T14:02:41+02:00`. */
  publishedAt: string;
  /** The resource zone (IANA) relative words and weekdays resolve in, e.g. `Europe/Kyiv`. */
  timezone: string;
  /** Plain reader text: paragraphs split by blank lines, list items as `• …`, the `→ source` line and hashtags as shown. */
  text: string;
  /** The bold first line / sentence, when the post opens with one. */
  lead?: string;
  links: { text: string; url: string }[];
  buttons: { text: string; url?: string }[];
  /** Hashtags without `#`, as written (case kept). */
  hashtags: string[];
  media: { kind: AuditMediaKind; count: number } | null;
  poll?: AuditPoll;
  /** The URL of the code-rendered `→ Source` line, when present. */
  sourceUrl?: string;
  /** Spec 037 T4: a spec's `source.url` whatever the card's link style (a button / footer source has no `→` line). */
  citedSourceUrl?: string;
  /** Every platform message the post is made of (an album is several), for traceability; export only. */
  messageIds?: number[];
  /**
   * Spec 037 T2: the story fields the writer declared (PostSpec `story`). Present (possibly empty) on a post built from
   * a spec, absent on an export: a check then infers reminders and giveaway follow-ups from the text.
   */
  story?: AuditStory;
  /** Spec 037 T9: the slot's format and the planner's topic (a fixed slot); an export knows neither. */
  format?: string;
  topic?: string;
  /**
   * Spec 037 T11: the URLs of the post's images (spec media other than video, carousel slide backgrounds) and the
   * spec's internal title; a spec has them, an export does not (a media check then says nothing).
   */
  imageUrls?: string[];
  title?: string;
  /**
   * Spec 067 FR-005: the post is made from a library row (`origin: library` or a `library_ref`). Its source URL is the row's
   * own page, not a news item, so the news-only media rules (no poster, only the source image) do not apply. A published
   * post of an export has no origin: unset.
   */
  fromLibrary?: boolean;
}

/** Spec 037 T2: a post's place in its story. */
export interface AuditStory {
  key?: string;
  /** The original's id (an AuditPost id: slot id, `pp:<published post id>`, or `<channel>:<message id>`). */
  followupOf?: string;
  kind?: 'followup' | 'reminder' | 'roundup' | 'evergreen';
  newFacts?: string[];
  /** A sibling channel posted the story in the last 24 h and this post takes its own angle. */
  decision?: 'own_angle';
  /** Spec 037 T3: the announced event — `YYYY-MM-DD` / `YYYY-MM-DDTHH:MM` (resource time) — and its name. */
  eventAt?: string;
  eventName?: string;
}

/**
 * Resource settings a check may read. A partial card so a test or the export audit can pass only what matters;
 * `style` is the resource style sheet of T8 (address, hashtags, glossary, …).
 */
export type AuditCard = Partial<Pick<EditorCard,
  'timezone' | 'language' | 'bannedTerms' | 'hashtags' | 'emojiPolicy' | 'humor' | 'slang' | 'emojiPref' | 'readerQuestionsMax' | 'pollsPerWeek'>> & {
  style?: AuditStyle;
};

/** The resource style sheet of T8 (`format_prefs.style`, effective: the owner's defaults filled in). */
export type AuditStyle = ResourceStyle;

export interface AuditContext {
  /** Earlier posts of the same resource, newest first. */
  previous: AuditPost[];
  /** Posts of sibling resources of the network group (any order). */
  network?: AuditPost[];
  card?: AuditCard;
  /** "Now" for the check (ISO); defaults to the post's publishedAt where a check needs a clock. */
  now?: string;
  /** Spec 037 T5: the pages and feed items the run read, with their publication date when known. */
  sources?: AuditSource[];
  /**
   * Spec 067 FR-005: the check runs on a post that is about to be stored, sent or put up for approval (the publish guards,
   * the platform media findings), not on a published one. A finding the executor can still fix — an off-topic poster — is an
   * error then and a warning in the weekly audit.
   */
  prePublish?: boolean;
}

/** A source the writer read: `publishedAt` is ISO (an instant) or `YYYY-MM-DD` (a day), absent when unknown. */
export interface AuditSource {
  url: string;
  publishedAt?: string | null;
  title?: string | null;
  /** Spec 037 T4: the text the run read (page ≤ 60k chars, feed item title + snippet, library row) for grounding. */
  text?: string | null;
  /** Spec 037 T4: links of the page to a primary source on another site (an aggregator's "take the primary"). */
  primaryLinks?: string[];
  /**
   * Spec 037 T11: the page's main image (og:image, twitter:image, else the first article image). `null` = the page
   * was read and has none; absent = unknown (a feed item, a page not read in this run).
   */
  image?: string | null;
  /**
   * Spec 037 T17: every image of that page a news post may use (the main one first, then the article's own images,
   * ≤ 10). Absent = only `image` is known (T11 behaviour).
   */
  images?: string[];
}

export interface Finding {
  code: string;
  level: 'error' | 'warning';
  message: string;
  /** The words of the post the finding is about (short). */
  excerpt?: string;
  /** Spec 041 T2: an exact replacement code may apply to the spec without an LLM turn (`from` as written in the post). */
  fix?: { from: string; to: string };
}

/**
 * One deterministic check. `codes` lists every code `run` may return; the golden set treats a code as
 * implemented once a registered check declares it.
 */
export interface IntegrityCheck {
  id: string;
  codes: readonly string[];
  run(post: AuditPost, ctx: AuditContext): Finding[];
  /**
   * The check adapts a rule lintPost already enforces on the PostSpec (spec 034), so lintPost skips it and only the
   * export / post audit runs it. Spec 037 checks leave it unset: lintPost runs them before publishing.
   */
  lintEnforced?: true;
}

/** The slop counters' voice prefs from a card (absent = humour and slang off, as in lintPost). */
export function voiceOf(card: AuditCard | undefined): VoicePrefs {
  return { humor: card?.humor, slang: card?.slang, emoji: card?.emojiPref, readerQuestionsMax: card?.readerQuestionsMax };
}

/** Everything the reader reads in a post: the text plus the poll question and options. */
export function readerText(post: AuditPost): string {
  return [post.text, post.poll?.question ?? '', ...(post.poll?.options ?? [])].filter(Boolean).join('\n');
}

/** A line the code renders after the body: the `→ Source` link or a line of hashtags. */
const TRAILER_LINE = /^(?:→\s.*|(?:#[\p{L}\p{N}_]+\s*)+)$/u;

/**
 * The author's text without the code-rendered trailer (the `→ Source` line and the hashtag line at the end), the
 * same text lintPost calls the body: sentence-structure checks (closing sentence, rhetorical Q&A) look at it.
 */
export function bodyText(post: Pick<AuditPost, 'text'>): string {
  const lines = post.text.split('\n');
  while (lines.length && (!lines[lines.length - 1].trim() || TRAILER_LINE.test(lines[lines.length - 1].trim()))) lines.pop();
  return lines.join('\n');
}

/** A short excerpt for a finding: the first `max` chars, one line. */
export function excerptOf(s: string, max = 120): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
