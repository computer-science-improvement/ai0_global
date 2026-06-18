// meta-caption.util.ts — compose per-platform Meta captions: base text + English
// hashtags (all Meta platforms) + an optional Telegram channel link appended
// ONLY on Facebook and Threads. Instagram is intentionally excluded from the
// link: IG feed captions don't render clickable links, so a bare URL there is
// noise. Pure + dependency-free → unit-tested directly.
import type { DestinationPlatform } from './publish-destination';

/** Curated broad English food hashtags for recipe posts (+ the recipe category). */
export function recipeHashtags(category?: string | null): string[] {
  const base = [
    'recipe', 'recipes', 'cooking', 'homecooking', 'food', 'foodie', 'tasty',
    'delicious', 'yummy', 'homemade', 'healthyfood', 'diet', 'mealprep',
    'cuisine', 'dinner', 'foodlover',
  ];
  return withCategory(base, category);
}

/** Curated AI + fashion English hashtags for prompt posts (+ the category). */
export function promptHashtags(category?: string | null): string[] {
  const base = [
    'aiart', 'aifashion', 'fashion', 'aigenerated', 'midjourney', 'styleinspo',
    'digitalart', 'fashiondesign', 'aimodel', 'generativeart', 'promptengineering',
  ];
  return withCategory(base, category);
}

/** Append the slugified category as a hashtag (deduped, lowercased). */
function withCategory(base: string[], category?: string | null): string[] {
  const tag = (category ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const all = tag ? [...base, tag] : base;
  return [...new Set(all)];
}

/** A public Telegram channel link from its @username, or null when private/empty. */
export function telegramLink(username?: string | null): string | null {
  if (!username) return null;
  const u = username.replace(/^@/, '').trim();
  return u ? `https://t.me/${u}` : null;
}

/**
 * Compose the caption for one Meta platform:
 *   base
 *   #tag1 #tag2 …              (all platforms, when hashtags present)
 *   <linkLabel> <telegramLink> (Facebook & Threads only, when a link is present)
 */
export function composeMetaCaption(
  platform: DestinationPlatform,
  opts: { base: string; hashtags?: string[]; telegramLink?: string | null; linkLabel?: string },
): string {
  const parts: string[] = [opts.base.trim()];
  if (opts.hashtags?.length) {
    parts.push(opts.hashtags.map((h) => `#${h}`).join(' '));
  }
  if (opts.telegramLink && (platform === 'facebook' || platform === 'threads')) {
    parts.push(opts.linkLabel ? `${opts.linkLabel} ${opts.telegramLink}` : opts.telegramLink);
  }
  return parts.filter(Boolean).join('\n\n');
}
