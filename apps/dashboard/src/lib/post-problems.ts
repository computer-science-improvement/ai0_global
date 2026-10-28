// Spec 078 B4: what is wrong with an owner post before it is sent, per form field, and which problems the form shows yet.
// The rules mirror apps/automation/src/scheduled-posts/post-validation.ts (the server's are the last word); the form shows a
// field's problem only after the owner has left that field or tried to submit, never on a blank form. Pure: no React.

import type { ComposedPostInput, ScheduledPost } from '../api/types';

export type PostField = 'channel' | 'bot' | 'text' | 'media' | 'buttons' | 'time';
export interface PostProblem { field: PostField; message: string }

/** Visible length: the text with its HTML tags stripped (how Telegram counts a caption). */
export const visibleLen = (html: string): number => html.replace(/<[^>]+>/g, '').length;

/** Telegram's ceiling for the sender and media: a text message 4096, a bot caption 1024, a premium caption 2048. */
export const limitFor = (sender: ComposedPostInput['sender'], media: ComposedPostInput['mediaType']): number =>
  media === 'none' ? 4096 : sender === 'mtproto_user' ? 2048 : 1024;

const HTTP = /^https?:\/\//i;

/** Every problem of the post, in the order the form lists its fields. `now` is injectable for tests. */
export function postProblems(post: ComposedPostInput, now: number = Date.now()): PostProblem[] {
  const out: PostProblem[] = [];
  const flat = post.buttons.flatMap((r) => r.buttons);
  const hasButtons = flat.length > 0;
  const len = visibleLen(post.text);
  const limit = limitFor(post.sender, post.mediaType);

  if (!post.channelId) out.push({ field: 'channel', message: 'Select a channel' });
  if (post.sender === 'bot' && !post.botId) out.push({ field: 'bot', message: 'Select a bot' });
  if (post.mediaType !== 'none' && !HTTP.test(post.mediaUrl ?? '')) out.push({ field: 'media', message: 'Media URL must be http(s)' });
  if (post.mediaType === 'none' && len === 0 && !hasButtons) out.push({ field: 'text', message: 'Write something to schedule it' });
  if (len > limit) out.push({ field: 'text', message: `Text ${len}/${limit} — limit exceeded` });
  if (hasButtons && post.mediaType !== 'none' && post.mediaPlacement === 'above' && len > 1024) {
    out.push({ field: 'buttons', message: 'Buttons + photo with caption >1024 cannot be in the same post' });
  }
  if (flat.some((b) => !b.label.trim() || !HTTP.test(b.url))) out.push({ field: 'buttons', message: 'Every button needs a label and an http(s) link' });
  if (!post.scheduledAt || Number.isNaN(Date.parse(post.scheduledAt))) out.push({ field: 'time', message: 'Specify a time' });
  else if (Date.parse(post.scheduledAt) <= now) out.push({ field: 'time', message: 'Publish time must be in the future' });
  return out;
}

/** The problems the form shows now: those of a field the owner has left, and all of them after a submit attempt. */
export function shownProblems(problems: readonly PostProblem[], submitted: boolean, touched: ReadonlySet<PostField>): PostProblem[] {
  return problems.filter((p) => submitted || touched.has(p.field));
}

/**
 * Project ONLY the 9 input fields of a post: strips ScheduledPost extras (id, status, ...) so a PATCH or POST body passes the
 * backend's forbidNonWhitelisted ValidationPipe.
 */
export const postInputOf = (p: ComposedPostInput | ScheduledPost): ComposedPostInput => ({
  channelId: p.channelId, sender: p.sender, botId: p.botId, text: p.text,
  mediaType: p.mediaType, mediaUrl: p.mediaUrl, mediaPlacement: p.mediaPlacement,
  buttons: p.buttons, scheduledAt: p.scheduledAt,
});
