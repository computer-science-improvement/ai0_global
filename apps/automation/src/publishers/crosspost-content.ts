// crosspost-content.ts — pure builders for Meta cross-post captions. Mirror
// reuses the TG text (HTML→plain + hashtags); teaser is a short strategy-supplied
// promo. Both optionally append a link to the originating Telegram post.
import { buildCaption, type CaptionOpts } from './meta-content';
import type { MetaPlatform } from '../config/meta-accounts.repository';

export const PLATFORM_CAPS: Record<MetaPlatform, CaptionOpts> = {
  instagram: { maxLen: 2200,  maxTags: 30 },
  facebook:  { maxLen: 60000, maxTags: 0 },
  threads:   { maxLen: 500,   maxTags: 0 },
};

/** Public-channel post link, or null for private channels (no public URL). */
export function tgPostLink(channelUsername: string | null, messageId: string | number): string | null {
  if (!channelUsername) return null;
  return `https://t.me/${channelUsername}/${messageId}`;
}

function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, Math.max(0, maxLen - 1)).trimEnd() + '…' : s;
}

/** Append `link` (reserving room) then cap to maxLen. IG links aren't clickable,
 *  so `link` is dropped for Instagram. */
function withLink(body: string, link: string | null, platform: MetaPlatform, maxLen: number, arrow: boolean): string {
  const useLink = platform !== 'instagram' ? link : null;
  if (!useLink) return truncate(body, maxLen);
  const suffix = `\n\n${arrow ? '↗ ' : ''}${useLink}`;
  return truncate(body, Math.max(1, maxLen - suffix.length)) + suffix;
}

/** Mirror: same content as the TG post, adapted + optional link-back. */
export function buildMirrorCaption(
  platform: MetaPlatform, text: string, tags: string[], link: string | null,
): string {
  const caps = PLATFORM_CAPS[platform];
  const reserve = platform !== 'instagram' && link ? `\n\n↗ ${link}`.length : 0;
  const body = buildCaption(text, tags, { maxLen: Math.max(1, caps.maxLen - reserve), maxTags: caps.maxTags });
  return withLink(body, link, platform, caps.maxLen, true);
}

/** Teaser: short promo lines (e.g. ["🍲 Каша", "БЖВ: 12/8/40"]) + link to the TG post. */
export function buildTeaserCaption(
  platform: MetaPlatform, lines: string[], link: string | null,
): string {
  const caps = PLATFORM_CAPS[platform];
  const body = lines.map(l => l.trim()).filter(Boolean).join('\n');
  return withLink(body, link, platform, caps.maxLen, false);
}
