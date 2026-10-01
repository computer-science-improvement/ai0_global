import { z } from 'zod';
import type { EditorCard } from '../card';
import { BlockSchema, PostSpec, PostSpecSchema } from './post-spec';
import { RenderResult, renderTelegram } from './render-telegram';
import { LintIssue, LintResult, lintPost } from './lint-post';

/** Legal ad marker. Always the last line of a sponsored post; added by code, never by a model or the advertiser. */
export const AD_LABEL = '#реклама';

const httpUrl = z.string().url().refine((u) => /^https?:\/\//i.test(u), 'must be http(s)');

/**
 * Ad creative stored in `ad_orders.creative` (spec 008 T002): a strict subset
 * of PostSpec. No hashtags (the only tag is the code-added #реклама), no source
 * and no library_ref (an ad is the advertiser's own text), at most one image.
 */
export const SponsoredCreativeSchema = z.object({
  format:    z.enum(['text', 'photo']).default('text'),
  body:      z.array(BlockSchema).min(1).max(30),
  media:     z.array(z.object({ url: httpUrl, alt: z.string().max(200).optional() })).max(1).default([]),
  placement: z.enum(['above', 'below']).default('above'),
  cta:       z.object({ url: httpUrl, label: z.string().min(1).max(40) }).optional(),
  buttons:   z.array(z.array(z.object({ text: z.string().min(1).max(40), url: httpUrl })).min(1).max(3)).max(3).default([]),
}).strict();

export type SponsoredCreative = z.infer<typeof SponsoredCreativeSchema>;

export interface SponsoredOrderInfo {
  advertiser?:   string | null;
  /** Optional "Реклама. Замовник: …" name (ad_orders.sponsor_label). */
  sponsorLabel?: string | null;
}

/** The tail of every sponsored post: optional customer line, then #реклама as the very last line. */
export function sponsoredFooter(order: SponsoredOrderInfo): string {
  const name = order.sponsorLabel?.trim();
  return name ? `Реклама. Замовник: ${name}\n${AD_LABEL}` : AD_LABEL;
}

/** Internal analytics title of the ad post (published_posts.title). */
export function sponsoredTitle(order: SponsoredOrderInfo): string {
  const who = (order.advertiser ?? '').trim() || 'партнер';
  return `Реклама: ${who}`.slice(0, 120);
}

/** Creative → full PostSpec (origin 'original', no hashtags, no source). */
export function creativeToSpec(creative: SponsoredCreative, order: SponsoredOrderInfo): PostSpec {
  return PostSpecSchema.parse({
    format: creative.format, title: sponsoredTitle(order), origin: 'original',
    body: creative.body, media: creative.media, placement: creative.placement,
    cta: creative.cta, buttons: creative.buttons, hashtags: [],
  });
}

/**
 * The sponsored card variant: the channel footer is replaced by the ad label,
 * so renderTelegram escapes it and puts it last (no hashtags, no source).
 * Rendering decisions (photo caption vs. text) already account for the label.
 */
function sponsoredCard(card: Pick<EditorCard, 'linkStyle'>, order: SponsoredOrderInfo): Pick<EditorCard, 'footer' | 'linkStyle'> {
  return { footer: sponsoredFooter(order), linkStyle: card.linkStyle };
}

/** Pure: creative + channel card + order → Telegram messages whose text ends with #реклама. */
export function renderSponsored(creative: SponsoredCreative, card: Pick<EditorCard, 'linkStyle'>, order: SponsoredOrderInfo): RenderResult {
  return renderTelegram(creativeToSpec(creative, order), sponsoredCard(card, order));
}

/** Legacy SP2 flow (plain `text` on a schedule_post action) → a text creative. */
export function creativeFromText(text: string): SponsoredCreative {
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).slice(0, 30);
  return SponsoredCreativeSchema.parse({ format: 'text', body: paras.map((p) => ({ type: 'p', text: p.slice(0, 1500) })) });
}

/** Advertiser wording is the advertiser's responsibility: these become warnings. */
const RELAXED = new Set(['banned_term', 'not_ukrainian', 'emoji_policy']);

/**
 * Relaxed lint for sponsored creatives: no hashtag vocabulary/count rules and
 * no channel format weights, but media count, body, lengths (with the ad label
 * included) and URL schemes are still enforced.
 */
export function lintSponsored(raw: unknown, card: Pick<EditorCard, 'linkStyle' | 'language'>, order: SponsoredOrderInfo = {}): LintResult {
  const parsed = SponsoredCreativeSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => ({ code: 'invalid_creative', message: `${i.path.join('.') || 'creative'}: ${i.message}` })), warnings: [] };
  }
  const spec = creativeToSpec(parsed.data, order);
  const res = lintPost(spec, {
    formats: {}, hashtags: [], hashtagMin: 0, hashtagMax: 0, footer: sponsoredFooter(order), linkStyle: card.linkStyle,
    emojiPolicy: 'free', bannedTerms: [], language: card.language,
  });
  const errors: LintIssue[] = [];
  const warnings: LintIssue[] = [...res.warnings];
  for (const e of res.errors) (RELAXED.has(e.code) ? warnings : errors).push(e);
  return { ok: errors.length === 0, errors, warnings };
}
