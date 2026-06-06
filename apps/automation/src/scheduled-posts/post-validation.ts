// post-validation.ts — pure, dependency-free; safe to unit-test.
import type { ComposedPost, Sender, MediaType } from './scheduled-posts.types';

/** Visible length = text with HTML tags stripped (matches Telegram caption counting). */
export function visibleLength(html: string): number {
  return html.replace(/<[^>]+>/g, '').length;
}

/** Telegram length ceiling for the active (sender, media) combination. */
export function captionLimitFor(sender: Sender, mediaType: MediaType): number {
  if (mediaType === 'none') return 4096;          // text message
  return sender === 'mtproto_user' ? 2048 : 1024; // premium caption vs bot caption
}

const hasButtons = (p: ComposedPost) => p.buttons.some(r => r.buttons.length > 0);

/** Returns `{ errors }`; empty array = valid. Encodes the spec's hard guardrails. */
export function validateComposedPost(p: ComposedPost): { errors: string[] } {
  const errors: string[] = [];

  if (!p.channelId) errors.push('channel is required');
  if (!p.scheduledAt || Number.isNaN(Date.parse(p.scheduledAt))) errors.push('valid scheduled time is required');
  else if (Date.parse(p.scheduledAt) <= Date.now()) errors.push('scheduled time must be in the future');

  const buttons = hasButtons(p);
  const len = visibleLength(p.text);

  if ((p.mediaType === 'photo' || p.mediaType === 'video')) {
    if (!p.mediaUrl || !/^https?:\/\//i.test(p.mediaUrl)) errors.push('media URL must be http(s)');
  }
  if (p.mediaType === 'none' && len === 0 && !buttons) errors.push('post is empty');

  if (buttons) {
    if (p.sender !== 'bot') errors.push('inline buttons require the bot sender (MTProto-user cannot send buttons)');
    for (const row of p.buttons) for (const b of row.buttons) {
      if (!b.label?.trim()) errors.push('button label is required');
      if (!/^https?:\/\//i.test(b.url ?? '')) errors.push('button url must be http(s)');
    }
  }
  if (p.sender === 'bot') {
    if (p.botId == null) errors.push('bot must be selected for the bot sender');
  }
  if (p.sender === 'mtproto_user' && p.mediaType !== 'none' && p.mediaPlacement === 'below') {
    errors.push('MTProto-user не підтримує медіа під текстом — оберіть «над текстом» або бота');
  }

  const limit = captionLimitFor(p.sender, p.mediaType);
  if (len > limit) {
    if (p.mediaType !== 'none' && p.mediaPlacement === 'above' && p.sender === 'bot' && len <= 2048 && !buttons) {
      errors.push(`caption ${len} > 1024 with a photo/video needs the MTProto-user sender`);
    } else {
      errors.push(`text ${len} exceeds the ${limit}-char limit for this sender/media`);
    }
  }
  return { errors };
}
