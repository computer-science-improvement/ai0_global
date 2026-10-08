import type { EditorCard } from '../card';
import type { Block, PostSpec } from './post-spec';
import type { PreparedMedia } from './render-telegram';
import { normalizeHashtag } from './render-telegram';
import { blockPlain } from './blocks';

/** Mirrors of a Telegram channel: the Meta platforms plus TikTok photo posts. */
export type MirrorPlatform = 'instagram' | 'facebook' | 'threads' | 'tiktok';
export const MIRROR_PLATFORMS: readonly MirrorPlatform[] = ['instagram', 'facebook', 'threads', 'tiktok'];

/** Plain-text payload for one mirror platform (no HTML; the publishers take it as is). */
export interface MirrorPost {
  caption:   string;
  /** 0 = text-only (Facebook/Threads), 1 = single image, ≥2 = carousel/album. */
  imageUrls: string[];
  carousel:  boolean;
}

export interface MetaRender {
  posts:   Partial<Record<MirrorPlatform, MirrorPost>>;
  /** Why a platform gets nothing for this post. */
  skipped: Partial<Record<MirrorPlatform, string>>;
}

/** Caption ceilings: Instagram 2200, Facebook 63k (we stay well below), Threads 500, TikTok photo description. */
export const MIRROR_CAPTION_LIMIT: Record<MirrorPlatform, number> = { instagram: 2200, facebook: 60_000, threads: 500, tiktok: 2200 };

/** Platforms where links in a caption are not clickable. */
const NO_LINKS: ReadonlySet<MirrorPlatform> = new Set(['instagram', 'tiktok']);

export const LINK_IN_BIO = 'Посилання в біо';
export const POLL_PROMPT = 'А ви як думаєте?';

const LINK_RE = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]{1,2000})\)/g;

/** Markdown-lite → plain text; links become "label (url)" where clickable, just "label" elsewhere. */
function inlinePlain(src: string, links: boolean): string {
  return (src ?? '')
    .replace(LINK_RE, (_m, label: string, url: string) => (links ? `${label} (${url})` : label))
    .replace(/\*\*([^*]+?)\*\*/g, '$1')
    .replace(/\|\|([^|]+?)\|\|/g, '$1')
    .replace(/(^|[\s(«"])_([^_\n]+?)_(?=$|[\s.,!?:;)»"])/g, '$1$2');
}

function blocksPlain(blocks: Block[], links: boolean): string {
  // Spec 033 FR-004: rich-only blocks (heading, olist, table, math, details …) become plain lines.
  return blocks.map((b) => blockPlain(b, (s) => inlinePlain(s, links))).filter(Boolean).join('\n\n');
}

function truncate(s: string, max: number): string {
  if (max <= 1) return s.slice(0, Math.max(0, max));
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** Body + tail (source, CTA, footer, link back, hashtags) fitted into the platform limit; only the body is cut. */
function assemble(body: string, tail: string[], max: number): string {
  const t = tail.filter(Boolean).join('\n');
  if (!t) return truncate(body, max);
  if (!body) return truncate(t, max);
  const room = max - t.length - 2;
  return room > 20 ? `${truncate(body, room)}\n\n${t}` : truncate(`${body}\n\n${t}`, max);
}

function images(spec: PostSpec, prepared: PreparedMedia): { urls: string[]; carousel: boolean } | null {
  switch (spec.format) {
    case 'carousel': return prepared.slideUrls && prepared.slideUrls.length >= 2 ? { urls: prepared.slideUrls, carousel: true } : null;
    case 'album':    return spec.media.length >= 2 ? { urls: spec.media.map((m) => m.url), carousel: true } : null;
    case 'video':    return null;
    default:         return spec.media[0] && spec.media[0].kind !== 'video' ? { urls: [spec.media[0].url], carousel: false } : null;
  }
}

/**
 * Pure PostSpec → per-platform mirror payloads (spec 009 T003).
 * - Captions are plain text: no HTML, markup stripped, inline links "label (url)" on Facebook/Threads.
 * - Instagram/TikTok links are not clickable: the source becomes "Посилання в біо" (only when a source exists).
 * - Hashtags from the spec are appended on every platform.
 * - album/carousel → image list (carousel); photo/text with an image → single image.
 * - Instagram and TikTok need an image; poll/quiz/longread/video degrade to text on Facebook/Threads and skip them.
 */
export function renderMeta(
  spec: PostSpec,
  card: Pick<EditorCard, 'footer'>,
  prepared: PreparedMedia = {},
  opts: { telegramLink?: string | null } = {},
): MetaRender {
  const out: MetaRender = { posts: {}, skipped: {} };
  const img = images(spec, prepared);
  const tags = spec.hashtags.map(normalizeHashtag).filter(Boolean).map((t) => `#${t}`).join(' ');

  for (const platform of MIRROR_PLATFORMS) {
    const links = !NO_LINKS.has(platform);

    // What is posted and whether this platform can show it at all.
    let body: string;
    let media: { urls: string[]; carousel: boolean } | null = img;
    switch (spec.format) {
      case 'poll':
      case 'quiz': {
        if (!links) { out.skipped[platform] = 'poll_not_supported'; continue; }
        const p = spec.poll;
        if (!p) { out.skipped[platform] = 'poll_missing'; continue; }
        const question = [inlinePlain(p.question, false), p.options.map((o) => `• ${inlinePlain(o, false)}`).join('\n'), POLL_PROMPT].join('\n\n');
        body = [blocksPlain(spec.body, true), question].filter(Boolean).join('\n\n');
        media = null; // a poll mirror is a discussion prompt, not a photo post
        break;
      }
      case 'longread':
        if (!links) { out.skipped[platform] = 'longread_not_supported'; continue; }
        if (!prepared.longreadUrl) { out.skipped[platform] = 'longread_not_prepared'; continue; }
        body = `${blocksPlain(spec.body, true)}\n\nЧитати: ${prepared.longreadUrl}`;
        media = null;
        break;
      case 'carousel':
        if (!img) { out.skipped[platform] = 'carousel_not_prepared'; continue; }
        body = blocksPlain(spec.body, links);
        break;
      default:
        body = blocksPlain(spec.body, links);
    }
    if (!links && !media) { out.skipped[platform] = spec.format === 'video' ? 'video_not_supported' : 'needs_image'; continue; }

    const tail: string[] = [];
    if (spec.source) tail.push(links ? `Джерело: ${spec.source.url}` : LINK_IN_BIO);
    if (spec.cta && links) tail.push(`${spec.cta.label}: ${spec.cta.url}`);
    if (card.footer) tail.push(card.footer);
    if (opts.telegramLink && links) tail.push(`↗ ${opts.telegramLink}`);
    if (tags) tail.push(tags);

    out.posts[platform] = {
      caption:   assemble(body, tail, MIRROR_CAPTION_LIMIT[platform]),
      imageUrls: media?.urls ?? [],
      carousel:  media?.carousel ?? false,
    };
  }
  return out;
}
