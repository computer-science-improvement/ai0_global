import { createHash } from 'node:crypto';
import { inlineToPlain } from '../post/inline-markup';
import { normalizeHashtag, type RenderCard } from '../post/render-telegram';
import { INTEGRITY_CHECKS, runIntegrityChecks } from '../post/integrity/registry';
import { excerptOf, type AuditCard, type AuditPost, type AuditSource, type Finding, type IntegrityCheck } from '../post/integrity/types';
import type { PlatformPostSpec } from '../platform/platform-spec';
import { isSiteIndexUrl } from '../../data/source-tier';

/**
 * Spec 037 FR-014 (T14): the post audit, the pure part. Every registered deterministic check (`INTEGRITY_CHECKS`,
 * the spec 034 adapters included) runs over a resource's published posts of the last 7 days, each post with the
 * resource's earlier posts as `previous` (newest first, the 14 days before the window included, as a story check
 * needs), the network siblings' earlier posts as `network`, the resource card and the sources stored with the post.
 * The audit is generic over codes: a check a later task registers (T2 stories, T4 facts, T11 media) is audited
 * without a change here. The findings become `editor_post_audit` rows (post-audit.service.ts).
 */

export const AUDIT_DAYS = 7;
/** Earlier posts before the window that are still history for the first posts in it (story repeats look 14 days back). */
export const HISTORY_DAYS = 14;
/** Findings older than this are pruned from the table. */
export const KEEP_DAYS = 30;
/**
 * Bump when a check's logic changes without a change of its id or codes: the rules hash changes and every
 * resource's last 7 days are recomputed at the next tick.
 */
export const AUDIT_RULES_VERSION = 1;

/** A hash of the registered check ids and their codes (and AUDIT_RULES_VERSION): a new rule recomputes the audit. */
export function rulesHash(checks: readonly IntegrityCheck[] = INTEGRITY_CHECKS): string {
  const lines = checks.map((c) => `${c.id}:${[...c.codes].sort().join(',')}`).sort();
  return createHash('sha256').update(`v${AUDIT_RULES_VERSION}\n${lines.join('\n')}`).digest('hex').slice(0, 16);
}

/** One published post of the resource the audit reads: the integrity view plus where it lives. */
export interface AuditTarget {
  post:        AuditPost;
  kind:        'slot' | 'platform';
  /** The slot id or the platform_posts id. */
  postId:      string;
  slotId?:     string | null;
  channelKey?: string | null;
  messageId?:  number | null;
  url?:        string | null;
  /** The pages / feed items the run read, when they were stored with the post (T5 `ctx.sources`). */
  sources?:    AuditSource[] | null;
}

/** One finding of the audit, as stored. */
export interface AuditRow {
  resourceRef: string;
  channelKey:  string | null;
  postKind:    'slot' | 'platform';
  postId:      string;
  slotId:      string | null;
  messageId:   number | null;
  postUrl:     string | null;
  postExcerpt: string;
  format:      string | null;
  code:        string;
  level:       'error' | 'warning';
  message:     string;
  excerpt:     string | null;
  /** Any field a check adds beyond code / level / message / excerpt (links or ids of matched posts, …). */
  extra:       Record<string, unknown> | null;
  fingerprint: string;
  publishedAt: string;
}

const at = (p: AuditPost) => Date.parse(p.publishedAt);

/** The post as the owner recognises it in a list: the bold lead, else the start of the text (or the poll question). */
export function postExcerpt(p: AuditPost, max = 160): string {
  return excerptOf(p.lead || p.text || p.poll?.question || '', max);
}

/** `https://t.me/<name>/<id>` for a public channel key `@name`, `https://t.me/c/<id>/<msg>` for a `-100…` chat id. */
export function telegramPostUrl(channelKey: string | null | undefined, messageId: number | null | undefined): string | null {
  if (!channelKey || !messageId || !Number.isFinite(messageId)) return null;
  const k = channelKey.trim();
  if (/^@[A-Za-z0-9_]{4,64}$/.test(k)) return `https://t.me/${k.slice(1)}/${messageId}`;
  if (/^-100\d{5,}$/.test(k)) return `https://t.me/c/${k.slice(4)}/${messageId}`;
  return null;
}

const FINDING_KEYS = new Set(['code', 'level', 'message', 'excerpt']);

/** The fields of a finding beyond the four of `Finding` (null when there are none). */
export function findingExtra(f: Finding): Record<string, unknown> | null {
  const extra = Object.fromEntries(Object.entries(f).filter(([k, v]) => !FINDING_KEYS.has(k) && v !== undefined));
  return Object.keys(extra).length ? extra : null;
}

/** Tells two findings of one code on one post apart; the same finding on a rerun gets the same value. */
export function fingerprintOf(f: Finding): string {
  return createHash('sha1').update(`${f.code}\n${f.message}\n${f.excerpt ?? ''}`).digest('hex').slice(0, 16);
}

/**
 * Spec 037 T7: of two posts of the same instant (an intro and the poll right under it), the one the reader sees first:
 * the lower Telegram message id when both are known, else the id.
 */
function readFirst(p: AuditPost, q: AuditPost): boolean {
  const a = p.messageIds?.[0];
  const b = q.messageIds?.[0];
  return a != null && b != null && a !== b ? a < b : p.id < q.id;
}

/**
 * Every finding of every check on the targets (any order). `history` holds the resource's posts before the window
 * (any order); a target's `previous` is every earlier post of the resource, newest first. `network` holds the
 * siblings' posts; a target sees the ones published before it. A check that throws is a `check_failed` row.
 */
export function auditFindings(i: {
  resourceRef: string;
  targets:     AuditTarget[];
  history?:    AuditPost[];
  network?:    AuditPost[];
  card?:       AuditCard | null;
  checks?:     readonly IntegrityCheck[];
}): AuditRow[] {
  const own = [...(i.history ?? []), ...i.targets.map((t) => t.post)];
  const seen = new Set<string>();
  const timeline = own.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true))).sort((a, b) => at(b) - at(a) || b.id.localeCompare(a.id));
  const network = [...(i.network ?? [])].sort((a, b) => at(b) - at(a));
  const rows: AuditRow[] = [];
  for (const t of [...i.targets].sort((a, b) => at(a.post) - at(b.post))) {
    const when = at(t.post);
    const previous = timeline.filter((p) => p.id !== t.post.id && (at(p) < when || (at(p) === when && readFirst(p, t.post))));
    const findings = runIntegrityChecks(t.post, {
      previous,
      network: network.filter((p) => at(p) < when),
      ...(i.card ? { card: i.card } : {}),
      now: t.post.publishedAt,
      ...(t.sources?.length ? { sources: t.sources } : {}),
    }, i.checks ?? INTEGRITY_CHECKS);
    const keys = new Set<string>();
    for (const f of findings) {
      const fingerprint = fingerprintOf(f);
      if (keys.has(`${f.code}|${fingerprint}`)) continue; // the same finding twice is one row
      keys.add(`${f.code}|${fingerprint}`);
      rows.push({
        resourceRef: i.resourceRef, channelKey: t.channelKey ?? null, postKind: t.kind, postId: t.postId, slotId: t.slotId ?? null,
        messageId: t.messageId ?? null, postUrl: t.url ?? null, postExcerpt: postExcerpt(t.post), format: t.post.format ?? null,
        code: f.code, level: f.level === 'error' ? 'error' : 'warning', message: f.message, excerpt: f.excerpt ?? null,
        extra: findingExtra(f), fingerprint, publishedAt: t.post.publishedAt,
      });
    }
  }
  return rows;
}

/** Stored sources (`[{url, publishedAt|published_at, title, image?, images?}]`, critic/stored-sources.ts) → AuditSource[]; anything else → null. */
export function parseSources(raw: unknown): AuditSource[] | null {
  if (!Array.isArray(raw)) return null;
  const out: AuditSource[] = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object' || typeof (s as any).url !== 'string') continue;
    const x = s as Record<string, unknown>;
    const published = typeof x.publishedAt === 'string' ? x.publishedAt : typeof x.published_at === 'string' ? x.published_at : null;
    out.push({
      url: x.url as string, publishedAt: published, title: typeof x.title === 'string' ? x.title : null,
      // Spec 037 T11: the page's main image when it was stored (null = the page had none).
      ...('image' in x && (typeof x.image === 'string' || x.image === null) ? { image: x.image as string | null } : {}),
      // Spec 037 T17: every image of the page a news post may use (main first), when it was stored.
      ...(Array.isArray(x.images) ? { images: (x.images as unknown[]).filter((u): u is string => typeof u === 'string').slice(0, 10) } : {}),
    });
  }
  return out.length ? out : null;
}

const LINK_RE = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]{1,2000})\)/g;

const URL_RE = /https?:\/\/[^\s)\]>"']+/i;

/**
 * Spec 037 T17: the page a platform post cites. `source.url` first; without it the shapes cite otherwise: the `link`
 * of an `fb_link` (the shared article), the first URL of Instagram's `first_comment` («джерело: …»), or the caption's
 * only link (Threads / Facebook). The `link` of other formats is a "link in bio" call to action, not a source, and so
 * is a site root or section index anywhere.
 */
export function platformCitedUrl(spec: PlatformPostSpec): string | undefined {
  if (spec.source?.url) return spec.source.url;
  const ok = (u: string | undefined): u is string => !!u && !isSiteIndexUrl(u);
  const fromComment = spec.first_comment ? URL_RE.exec(spec.first_comment)?.[0]?.replace(/[.,;:!?]+$/, '') : undefined;
  const inCaption = [...new Set([...spec.caption.matchAll(LINK_RE)].map((m) => m[2]).filter(ok))];
  return [spec.format === 'fb_link' ? spec.link?.url : undefined, fromComment, inCaption.length === 1 ? inCaption[0] : undefined].find(ok);
}

/**
 * A native platform post (Instagram, Facebook, Threads, TikTok, YouTube) → the integrity view: the caption as the
 * reader sees it (markup and links as plain labels), the slides, the hashtags, the source as the source line.
 * Spec 037 T17: plus its images (image media, slide backgrounds), the internal title and the cited page
 * (`platformCitedUrl`), so the media / poster check (T11) runs on platform posts too.
 */
export function auditPostFromPlatformSpec(spec: PlatformPostSpec, meta: { id: string; channel: string; publishedAt: string; timezone: string; topic?: string }): AuditPost {
  const caption = inlineToPlain(spec.caption.replace(LINK_RE, (_m, label: string) => label)).trim();
  const slides = (spec.slides ?? []).map((s) => `${s.title}\n${s.text}`);
  const hashtags = spec.hashtags.map(normalizeHashtag);
  const text = [caption, ...slides, hashtags.length ? hashtags.map((h) => `#${h}`).join(' ') : ''].filter((s) => s.trim()).join('\n\n');
  const mediaCount = spec.slides?.length ? spec.slides.length : spec.media.length;
  const imageUrls = [...spec.media.filter((m) => m.kind !== 'video').map((m) => m.url), ...(spec.slides ?? []).flatMap((s) => (s.image ? [s.image] : []))];
  const cited = platformCitedUrl(spec);
  return {
    id: meta.id, channel: meta.channel, publishedAt: meta.publishedAt, timezone: meta.timezone,
    text,
    links: [...spec.caption.matchAll(LINK_RE)].map((m) => ({ text: inlineToPlain(m[1]), url: m[2] })),
    buttons: spec.link ? [{ text: spec.link.label ?? 'Link', url: spec.link.url }] : [],
    hashtags,
    media: mediaCount ? { kind: spec.media.some((m) => m.kind === 'video') ? 'video' : 'photo', count: mediaCount } : null,
    format: spec.format,
    ...(spec.source ? { sourceUrl: spec.source.url } : {}),
    ...(cited ? { citedSourceUrl: cited } : {}),
    title: spec.title,
    ...(meta.topic ? { topic: meta.topic } : {}),
    ...(imageUrls.length ? { imageUrls: [...new Set(imageUrls)] } : {}),
    // Spec 067 FR-005: a post made from a library row is not news (platform specs carry the row's `library_ref`).
    ...(spec.library_ref ? { fromLibrary: true } : {}),
  };
}

/** The render settings auditPostFromSpec needs from a card (how the source line and the footer show). */
export type AuditRenderCard = Partial<RenderCard>;
