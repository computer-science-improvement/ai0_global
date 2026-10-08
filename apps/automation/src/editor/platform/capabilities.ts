import type { Platform } from '../agents/agent.types';

/**
 * What each platform can take natively (spec 019 FR-001). Pure data: the
 * planner and lint read it, so an agent can never plan a format a publisher
 * cannot send. Limits were set from the platforms' public docs on VERIFIED_ON;
 * re-check them before relying on an edge (they change).
 */
export const VERIFIED_ON = '2026-10-02';

export const NATIVE_FORMATS = [
  'ig_photo', 'ig_carousel', 'ig_reel',
  'fb_text', 'fb_photo', 'fb_album', 'fb_link', 'fb_reel',
  'th_text', 'th_image', 'th_carousel',
  'tt_photo', 'tt_video',
  'yt_short',
] as const;
export type NativeFormat = typeof NATIVE_FORMATS[number];

export interface FormatSpec {
  /** Implemented by a publisher in this codebase (019b adds video). */
  implemented: boolean;
  media:       { min: number; max: number; kind: 'image' | 'video' | 'none' | 'image_or_none' };
  /** Rendered slides (the 009 carousel renderer) may stand in for images. */
  slidesOk?:   boolean;
  note:        string;
}

export interface PlatformCaps {
  captionMax:      number;
  /** Hard platform limit and the range we recommend. */
  hashtags:        { max: number; recommended: [number, number] };
  linksClickable:  boolean;
  /** API publish cap per 24 h per account (approximate; our own cap stays below it). */
  dailyApiCap:     number;
  formats:         Partial<Record<NativeFormat, FormatSpec>>;
  /** Uploads land private until an API audit is passed (TikTok, YouTube). */
  privateUntilAudit?: boolean;
}

export const CAPABILITIES: Record<Exclude<Platform, 'telegram'>, PlatformCaps> = {
  instagram: {
    captionMax: 2200, hashtags: { max: 30, recommended: [3, 5] }, linksClickable: false, dailyApiCap: 50,
    formats: {
      ig_photo:    { implemented: true,  media: { min: 1, max: 1, kind: 'image' }, slidesOk: true, note: 'одне фото 4:5 або 1:1 + підпис' },
      ig_carousel: { implemented: true,  media: { min: 2, max: 10, kind: 'image' }, slidesOk: true, note: 'карусель 2–10 слайдів; перший слайд — гачок' },
      ig_reel:     { implemented: false, media: { min: 1, max: 1, kind: 'video' }, note: 'Reels — ще ні: потрібен відеоконвеєр (спека 016)' },
    },
  },
  facebook: {
    captionMax: 60_000, hashtags: { max: 10, recommended: [0, 3] }, linksClickable: true, dailyApiCap: 50,
    formats: {
      fb_text:  { implemented: true,  media: { min: 0, max: 0, kind: 'none' }, note: 'текстовий пост сторінки' },
      fb_photo: { implemented: true,  media: { min: 1, max: 1, kind: 'image' }, slidesOk: true, note: 'фото + текст' },
      fb_album: { implemented: true,  media: { min: 2, max: 10, kind: 'image' }, slidesOk: true, note: 'альбом' },
      fb_link:  { implemented: true,  media: { min: 0, max: 0, kind: 'none' }, note: 'текст із посиланням (превʼю робить Facebook)' },
      fb_reel:  { implemented: false, media: { min: 1, max: 1, kind: 'video' }, note: 'Reels сторінки — ще ні: потрібен відеоконвеєр (спека 016)' },
    },
  },
  threads: {
    captionMax: 500, hashtags: { max: 1, recommended: [0, 1] }, linksClickable: true, dailyApiCap: 250,
    formats: {
      th_text:     { implemented: true, media: { min: 0, max: 0, kind: 'none' }, note: 'до 500 символів, одне посилання' },
      th_image:    { implemented: true, media: { min: 1, max: 1, kind: 'image' }, slidesOk: true, note: 'зображення + текст' },
      th_carousel: { implemented: true, media: { min: 2, max: 10, kind: 'image' }, slidesOk: true, note: 'карусель' },
    },
  },
  tiktok: {
    captionMax: 2200, hashtags: { max: 10, recommended: [3, 5] }, linksClickable: false, dailyApiCap: 15, privateUntilAudit: true,
    formats: {
      tt_photo: { implemented: true,  media: { min: 1, max: 35, kind: 'image' }, slidesOk: true, note: 'фото-режим 1–35 зображень; заголовок до 90 символів' },
      tt_video: { implemented: false, media: { min: 1, max: 1, kind: 'video' }, note: 'відео — ще ні: потрібен відеоконвеєр (спека 016)' },
    },
  },
  youtube: {
    captionMax: 5000, hashtags: { max: 15, recommended: [2, 3] }, linksClickable: true, dailyApiCap: 6, privateUntilAudit: true,
    formats: {
      yt_short: { implemented: false, media: { min: 1, max: 1, kind: 'video' }, note: 'Shorts ≤ 3 хв, вертикальне — ще ні: спеки 016 і 030' },
    },
  },
};

export function platformOfFormat(f: NativeFormat): Exclude<Platform, 'telegram'> {
  const p = f.split('_')[0];
  return ({ ig: 'instagram', fb: 'facebook', th: 'threads', tt: 'tiktok', yt: 'youtube' } as const)[p as 'ig']!;
}

export function formatSpec(platform: Platform, format: string): FormatSpec | null {
  if (platform === 'telegram') return null;
  return (CAPABILITIES[platform].formats as Record<string, FormatSpec | undefined>)[format] ?? null;
}

/** Formats an agent may plan for a platform right now. */
export function implementedFormats(platform: Platform): string[] {
  if (platform === 'telegram') return ['text', 'photo', 'album', 'carousel', 'poll', 'quiz', 'longread', 'video'];
  return Object.entries(CAPABILITIES[platform].formats).filter(([, s]) => s!.implemented).map(([f]) => f);
}

/** Compact table for prompts. */
export function capabilitiesSummary(platforms: Platform[]): string {
  return platforms.filter((p) => p !== 'telegram').map((p) => {
    const c = CAPABILITIES[p as Exclude<Platform, 'telegram'>];
    const fmts = Object.entries(c.formats).map(([f, s]) => `${f}${s!.implemented ? '' : ' (ще ні)'}: ${s!.note}`).join('; ');
    return `- ${p}: підпис ≤ ${c.captionMax}, хештеги ${c.hashtags.recommended.join('–')} (макс ${c.hashtags.max}), посилання ${c.linksClickable ? 'клікабельні' : 'НЕ клікабельні'}${c.privateUntilAudit ? ', до аудиту API — приватні' : ''}. Формати: ${fmts}`;
  }).join('\n');
}
