import type { Platform } from '../agents/agent.types';
import { formatSpec, implementedFormats } from '../platform/capabilities';
import type { PlatformPostSpec } from '../platform/platform-spec';
import { NATIVE_FORMATS } from '../platform/capabilities';
import type { Block, PostSpec } from './post-spec';
import { POST_FORMATS } from './post-spec';
import { blockPlain } from './blocks';

/**
 * Spec 024 FR-006/FR-007: what a derived post (duplicate / adapt) can carry
 * from its source, the platform hard limits that make a target format
 * impossible, and duplicateSpec() — the pure STARTING DRAFT handed to the
 * agent's formatting run (never the published result).
 */

export type Treatment = 'unique' | 'duplicate' | 'adapt';
export type DerivedTreatment = Exclude<Treatment, 'unique'>;

/** Media a format can carry: how many and of which kind (slides are rendered into images by code). */
export interface MediaCapacity {
  kind:   'none' | 'image' | 'video' | 'slides';
  min:    number;
  max:    number;
  /** Telegram poll / quiz: options cannot be carried by any other format. */
  poll?:  boolean;
}

const TELEGRAM_MEDIA: Record<string, MediaCapacity> = {
  text:     { kind: 'image', min: 0, max: 1 },
  photo:    { kind: 'image', min: 1, max: 1 },
  album:    { kind: 'image', min: 2, max: 10 },
  carousel: { kind: 'slides', min: 2, max: 10 },
  poll:     { kind: 'image', min: 0, max: 1, poll: true },
  quiz:     { kind: 'image', min: 0, max: 1, poll: true },
  longread: { kind: 'image', min: 0, max: 1 },
  video:    { kind: 'video', min: 1, max: 1 },
};

/** Media capacity of a format on a platform; null for an unknown format. */
export function mediaCapacity(platform: Platform, format: string): MediaCapacity | null {
  if (platform === 'telegram') return TELEGRAM_MEDIA[format] ?? null;
  const fs = formatSpec(platform, format);
  if (!fs) return null;
  const { kind, min, max } = fs.media;
  if (kind === 'none') return { kind: 'none', min: 0, max: 0 };
  if (kind === 'video') return { kind: 'video', min, max };
  return { kind: 'image', min: kind === 'image_or_none' ? 0 : min, max };
}

/** Does a target take rendered slides in place of images (platform slidesOk, Telegram carousel)? */
function takesSlides(platform: Platform, format: string): boolean {
  if (platform === 'telegram') return format === 'carousel';
  return !!formatSpec(platform, format)?.slidesOk;
}

export interface FormatEnd { platform: Platform; format: string }

/**
 * Plan-time hard-limit check of a derived target (FR-006 c, FR-008). Returns
 * null when the format is technically possible, else a short English reason.
 * Only platform limits count (implemented formats, media kinds and counts,
 * polls); everything else is the agent's choice. `sourceMedia` (the real
 * media count of a written source) narrows the check when known.
 */
export function derivedFormatProblem(src: FormatEnd, tgt: FormatEnd, treatment: DerivedTreatment, sourceMedia?: { images: number; videos: number; slides: number }): string | null {
  if (!implementedFormats(tgt.platform).includes(tgt.format)) return `${tgt.format} is not available on ${tgt.platform}`;
  const t = mediaCapacity(tgt.platform, tgt.format);
  const s = mediaCapacity(src.platform, src.format);
  if (!t) return `${tgt.format} is not a ${tgt.platform} format`;
  if (!s) return `${src.format} is not a ${src.platform} format`;
  if (t.poll && !s.poll && treatment === 'duplicate') return `${tgt.format} needs poll options the source does not have`;
  if (s.poll && !t.poll && treatment === 'duplicate' && t.kind !== 'none' && t.min > 0) return `a poll cannot be duplicated as ${tgt.format}`;
  if (t.kind === 'video') {
    const videos = sourceMedia ? sourceMedia.videos : s.kind === 'video' ? s.max : 0;
    return videos >= t.min ? null : `${tgt.format} needs a video and the source has none`;
  }
  if (t.min === 0) return null;
  // The target needs t.min images (or slides where the target takes them).
  if (treatment === 'adapt' && takesSlides(tgt.platform, tgt.format)) return null; // the agent writes slides for the target
  if (sourceMedia) {
    const usable = sourceMedia.images + (takesSlides(tgt.platform, tgt.format) || sourceMedia.slides ? sourceMedia.slides : 0);
    return usable >= t.min ? null : `${tgt.format} needs ${t.min}+ image(s), the source has ${usable}`;
  }
  if (s.kind === 'none' || s.kind === 'video') return `${tgt.format} needs ${t.min}+ image(s) and ${src.format} carries none`;
  return s.max >= t.min ? null : `${tgt.format} needs ${t.min}+ images, ${src.format} carries at most ${s.max}`;
}

/** Media actually present in a written source post. */
export function sourceMediaOf(source: SourcePost): { images: number; videos: number; slides: number } {
  const media = source.spec.media ?? [];
  return {
    images: media.filter((m) => (m.kind ?? 'image') === 'image').length,
    videos: media.filter((m) => m.kind === 'video').length,
    slides: (source.spec.slides ?? []).length,
  };
}

export type SourcePost =
  | { platform: 'telegram'; spec: PostSpec }
  | { platform: Exclude<Platform, 'telegram'>; spec: PlatformPostSpec };

/** A Telegram block as caption text (markdown-lite kept; the lead stays bold). Spec 033: rich blocks map to plain lines. */
const blockText = (b: Block): string => (b.type === 'lead' ? `**${b.text}**` : blockPlain(b, (s) => s));

/** Plain caption paragraphs → Telegram blocks (the first short one becomes the lead). */
function captionBlocks(caption: string): Block[] {
  const paras = caption.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return paras.slice(0, 30).map((p, i): Block => {
    const text = p.replace(/^\*\*(.+)\*\*$/s, '$1');
    return i === 0 && text.length <= 400 && paras.length > 1 ? { type: 'lead', text } : { type: 'p', text: text.slice(0, 1500) };
  });
}

function telegramFormatFor(spec: PlatformPostSpec): PostSpec['format'] {
  if (spec.slides && spec.slides.length >= 2) return 'carousel';
  const videos = spec.media.filter((m) => m.kind === 'video').length;
  const images = spec.media.filter((m) => m.kind !== 'video').length;
  if (videos) return 'video';
  if (images >= 2) return 'album';
  if (images === 1) return 'photo';
  return 'text';
}

/**
 * The starting draft of a duplicate for the target (pure). Same content and
 * media; no soft rules (no hashtag cut, no caption trim, no media reorder) —
 * the agent's formatting run decides the presentation from the target's
 * format_prefs and its own format notes. `slideUrls` are the source's hosted
 * slides when they are still held (FR-007 media lifetime).
 */
export function duplicateSpec(source: SourcePost, target: FormatEnd, o: { slideUrls?: string[]; ideaId?: string | null } = {}): PostSpec | PlatformPostSpec {
  if (target.platform === 'telegram') {
    if (source.platform === 'telegram') {
      const fmt = (POST_FORMATS as readonly string[]).includes(target.format) ? target.format as PostSpec['format'] : source.spec.format;
      return { ...structuredClone(source.spec), format: fmt };
    }
    const s = source.spec;
    const spec: PostSpec = {
      format: (POST_FORMATS as readonly string[]).includes(target.format) ? target.format as PostSpec['format'] : telegramFormatFor(s),
      title: s.title,
      origin: s.library_ref ? 'library' : s.source ? 'external' : 'original',
      ...(s.library_ref ? { library_ref: s.library_ref } : {}),
      body: captionBlocks(s.caption),
      media: s.media.map((m) => ({ url: m.url, ...(m.alt ? { alt: m.alt } : {}), ...(m.kind === 'video' ? { kind: 'video' as const } : {}) })),
      placement: 'above',
      hashtags: [...s.hashtags],
      ...(s.source ? { source: { ...s.source, url: s.source.url } } : {}),
      ...(s.link ? { cta: { url: s.link.url, label: (s.link.label ?? 'Детальніше').slice(0, 40) } } : {}),
      buttons: [],
      ...(s.slides?.length ? { slides: structuredClone(s.slides) } : {}),
    };
    return spec;
  }

  const fmt = (NATIVE_FORMATS as readonly string[]).includes(target.format) ? target.format as PlatformPostSpec['format'] : null;
  if (!fmt) throw new Error(`${target.format} is not a native format`);
  const cap = mediaCapacity(target.platform, fmt);
  const max = cap?.max ?? 10;
  if (source.platform !== 'telegram') {
    const s = structuredClone(source.spec);
    return {
      ...s, format: fmt,
      media: cap?.kind === 'none' ? [] : s.media.slice(0, max),
      ...(s.slides ? { slides: cap?.kind === 'none' ? undefined : s.slides } : {}),
      ...(target.platform === 'instagram' ? {} : { first_comment: undefined }),
      ...(o.ideaId ? { idea_id: o.ideaId } : {}),
    } as PlatformPostSpec;
  }
  const s = source.spec;
  const teaser = s.format === 'longread' && s.longread && !s.body.length ? s.longread.blocks : s.body;
  const caption = teaser.map(blockText).filter(Boolean).join('\n\n');
  const hosted = (o.slideUrls ?? []).map((url) => ({ url, kind: 'image' as const }));
  const media = s.format === 'carousel' && hosted.length
    ? hosted
    : s.media.map((m) => ({ url: m.url, kind: (m.kind ?? 'image') as 'image' | 'video', ...(m.alt ? { alt: m.alt } : {}) }));
  const link = s.cta ?? s.source;
  const draft: PlatformPostSpec = {
    format: fmt,
    title: s.title,
    caption,
    hashtags: [...s.hashtags],
    media: cap?.kind === 'none' ? [] : media.slice(0, max),
    ...(s.format === 'carousel' && !hosted.length && s.slides?.length && cap?.kind !== 'none' ? { slides: structuredClone(s.slides) } : {}),
    ...(link ? { link: { url: link.url, ...(link.label ? { label: link.label.slice(0, 60) } : {}) } } : {}),
    ...(s.source ? { source: { url: s.source.url, ...(s.source.label ? { label: s.source.label } : {}) } } : {}),
    ...(s.library_ref ? { library_ref: s.library_ref } : {}),
    ...(o.ideaId ? { idea_id: o.ideaId } : {}),
  };
  return draft;
}
