import { z } from 'zod';
import { CONTENT_REF_RE } from '../../data/data-refs';
import { SlideSchema } from '../post/post-spec';
import { GLOBAL_BANNED } from '../post/lint-post';
import { inlineToPlain } from '../post/inline-markup';
import { normalizeHashtag } from '../post/render-telegram';
import { CAPABILITIES, formatSpec, NATIVE_FORMATS, platformOfFormat } from './capabilities';
import type { Platform } from '../agents/agent.types';

const httpsUrl = z.string().url().refine((u) => /^https:\/\//i.test(u), 'must be https');

/**
 * A native post for a non-Telegram platform (spec 019 FR-002). Written by the
 * platform executor from an idea — not a converted Telegram post.
 */
export const PlatformPostSpecSchema = z.object({
  format:        z.enum(NATIVE_FORMATS).describe('Нативний формат платформи, напр. ig_carousel, th_text, tt_photo'),
  title:         z.string().min(3).max(120).describe('Внутрішній заголовок (аналітика); для TikTok/YouTube — також заголовок поста'),
  caption:       z.string().max(6000).default('').describe('Підпис: **жирний** і _курсив_ стануть звичайним текстом; [текст](url) — посилання там, де клікабельні'),
  hashtags:      z.array(z.string().min(1).max(40)).max(30).default([]).describe('Без #'),
  media:         z.array(z.object({ url: httpsUrl, kind: z.enum(['image', 'video']).default('image'), alt: z.string().max(200).optional() })).max(35).default([]),
  slides:        z.array(SlideSchema).max(10).optional().describe('Слайди, які код намалює в зображення (каруселі, фото-режим TikTok)'),
  link:          z.object({ url: httpsUrl, label: z.string().min(1).max(60).optional() }).optional(),
  first_comment: z.string().max(1000).optional().describe('Instagram: перший коментар (напр. джерело/посилання), публікується окремо'),
  source:        z.object({ url: z.string().url(), label: z.string().max(60).optional() }).optional(),
  library_ref:   z.string().regex(CONTENT_REF_RE).optional(),
  idea_id:       z.string().uuid().optional(),
});
export type PlatformPostSpec = z.infer<typeof PlatformPostSpecSchema>;

export interface PlatformLintIssue { code: string; message: string }
export interface PlatformLintResult { ok: boolean; errors: PlatformLintIssue[]; warnings: PlatformLintIssue[]; captionLength: number }

const LINK_RE = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]{1,2000})\)/g;
const RAW_URL_RE = /https?:\/\/\S+/i;

/** Caption as the platform shows it: markup stripped; links "label (url)" where clickable, "label" elsewhere. */
export function captionPlain(spec: PlatformPostSpec, linksClickable: boolean): string {
  const withLinks = spec.caption.replace(LINK_RE, (_m, label: string, url: string) => (linksClickable ? `${label} (${url})` : label));
  return inlineToPlain(withLinks).trim();
}

export interface PlatformLintContext {
  platform:     Exclude<Platform, 'telegram'>;
  bannedTerms?: string[];
  /** Hashtag vocabulary of the playbook (empty = any well-formed). */
  vocabulary?:  string[];
}

/** Deterministic checks against the capability matrix (spec 019 FR-003). */
export function lintPlatformPost(spec: PlatformPostSpec, c: PlatformLintContext): PlatformLintResult {
  const errors: PlatformLintIssue[] = [];
  const warnings: PlatformLintIssue[] = [];
  const caps = CAPABILITIES[c.platform];
  const fp = platformOfFormat(spec.format);
  if (fp !== c.platform) errors.push({ code: 'wrong_platform', message: `формат ${spec.format} — для ${fp}, а ресурс ${c.platform}` });
  const fs = formatSpec(c.platform, spec.format);
  if (!fs) errors.push({ code: 'unknown_format', message: `${spec.format} не підтримується на ${c.platform}` });
  else if (!fs.implemented) errors.push({ code: 'format_not_implemented', message: `${spec.format}: ${fs.note}` });

  const caption = captionPlain(spec, caps.linksClickable);
  const inCaption = new Set((caption.match(/#[\p{L}\p{N}_]+/gu) ?? []).map((t) => normalizeHashtag(t.slice(1))));
  const tagsText = spec.hashtags.map((h) => normalizeHashtag(h)).filter((h) => !inCaption.has(h)).map((h) => `#${h}`).join(' ');
  const allTags = new Set([...inCaption, ...spec.hashtags.map((h) => normalizeHashtag(h))]);
  const full = [caption, tagsText].filter(Boolean).join('\n\n');
  if (full.length > caps.captionMax) errors.push({ code: 'caption_too_long', message: `підпис ${full.length} > ${caps.captionMax} символів (на ${full.length - caps.captionMax} задовгий)` });
  if (!caption && (spec.format === 'th_text' || spec.format === 'fb_text' || spec.format === 'fb_link')) errors.push({ code: 'empty_caption', message: 'текстовий формат без тексту' });

  if (allTags.size > caps.hashtags.max) errors.push({ code: 'too_many_hashtags', message: `хештегів ${allTags.size} > ${caps.hashtags.max}` });
  else if (allTags.size > caps.hashtags.recommended[1]) warnings.push({ code: 'hashtags_above_recommended', message: `рекомендовано ${caps.hashtags.recommended.join('–')}` });
  for (const h of spec.hashtags) {
    const n = normalizeHashtag(h);
    if (!/^[\p{L}\p{N}_]{2,40}$/u.test(n)) errors.push({ code: 'bad_hashtag', message: `хештег «${h}»` });
    if (c.vocabulary?.length && !c.vocabulary.map(normalizeHashtag).includes(n)) warnings.push({ code: 'hashtag_off_vocab', message: `#${n} не зі словника плейбука` });
  }

  if (!caps.linksClickable) {
    if (RAW_URL_RE.test(spec.caption.replace(LINK_RE, ''))) {
      errors.push({ code: 'link_not_clickable', message: `на ${c.platform} посилання в підписі не клікабельні — винеси в first_comment або «посилання в біо»` });
    }
    if (spec.link) warnings.push({ code: 'link_ignored', message: 'link не буде клікабельним — використано «посилання в біо»' });
  }
  if (spec.first_comment && c.platform !== 'instagram') warnings.push({ code: 'first_comment_ignored', message: 'first_comment публікується лише в Instagram' });
  if (spec.format === 'fb_link' && !spec.link) errors.push({ code: 'link_missing', message: 'fb_link потребує link' });

  if (fs) {
    const images = spec.media.filter((m) => m.kind === 'image').length;
    const videos = spec.media.filter((m) => m.kind === 'video').length;
    const slides = spec.slides?.length ?? 0;
    const count = fs.media.kind === 'video' ? videos : Math.max(images, fs.slidesOk ? slides : 0);
    if (fs.media.kind === 'none' && (images || videos || slides)) warnings.push({ code: 'media_ignored', message: `${spec.format} — без медіа; зображення буде проігноровано` });
    if (fs.media.kind !== 'none' && (count < fs.media.min || count > fs.media.max)) {
      errors.push({ code: 'media_count', message: `${spec.format}: потрібно ${fs.media.min}–${fs.media.max} ${fs.media.kind === 'video' ? 'відео' : 'зображень/слайдів'}, є ${count}` });
    }
    if (images && slides) warnings.push({ code: 'media_and_slides', message: 'є і media, і slides — використано slides' });
  }

  const lower = `${spec.title}\n${caption}\n${(spec.slides ?? []).map((s) => `${s.title} ${s.text}`).join('\n')}`.toLowerCase();
  for (const b of [...GLOBAL_BANNED, ...(c.bannedTerms ?? [])]) {
    if (b && lower.includes(b.toLowerCase())) errors.push({ code: 'banned_phrase', message: `заборонена фраза «${b}»` });
  }
  if ((spec.format === 'tt_photo' || spec.format === 'yt_short') && spec.title.length > 90) {
    errors.push({ code: 'title_too_long', message: 'заголовок TikTok/YouTube до 90 символів' });
  }
  return { ok: errors.length === 0, errors, warnings, captionLength: full.length };
}

export interface RenderedPlatformPost {
  caption:      string;
  imageUrls:    string[];
  videoUrl:     string | null;
  carousel:     boolean;
  title:        string;
  firstComment: string | null;
  link:         string | null;
}

export const LINK_IN_BIO = 'Посилання в біо';

/** PlatformPostSpec → what the publisher sends (pure). `slideUrls` are the rendered slides, when the spec has slides. */
export function renderPlatform(spec: PlatformPostSpec, platform: Exclude<Platform, 'telegram'>, slideUrls: string[] = []): RenderedPlatformPost {
  const caps = CAPABILITIES[platform];
  const body = captionPlain(spec, caps.linksClickable);
  // Hashtags the caption already contains are not appended a second time.
  const present = new Set((body.match(/#[\p{L}\p{N}_]+/gu) ?? []).map((t) => normalizeHashtag(t.slice(1))));
  const tags = spec.hashtags.map((h) => normalizeHashtag(h)).filter((h) => !present.has(h)).map((h) => `#${h}`).join(' ');
  const linkLine = spec.link
    ? (caps.linksClickable ? (body.includes(spec.link.url) ? '' : `${spec.link.label ? `${spec.link.label}: ` : ''}${spec.link.url}`) : LINK_IN_BIO)
    : '';
  const caption = [body, linkLine, tags].filter(Boolean).join('\n\n').slice(0, caps.captionMax);
  const images = slideUrls.length ? slideUrls : spec.media.filter((m) => m.kind === 'image').map((m) => m.url);
  const fs = formatSpec(platform, spec.format);
  const imageUrls = fs?.media.kind === 'none' ? [] : images.slice(0, fs?.media.max ?? 10);
  return {
    caption,
    imageUrls,
    videoUrl: spec.media.find((m) => m.kind === 'video')?.url ?? null,
    carousel: imageUrls.length >= 2,
    title: spec.title,
    firstComment: platform === 'instagram' ? spec.first_comment ?? null : null,
    link: spec.link?.url ?? null,
  };
}
