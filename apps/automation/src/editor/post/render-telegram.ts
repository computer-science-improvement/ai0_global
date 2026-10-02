import type { EditorCard } from '../card';
import type { Block, PostSpec } from './post-spec';
import { escapeAttr, escapeHtml, inlineToHtml, inlineToPlain, visibleLength } from './inline-markup';

export interface UrlButton { text: string; url: string }

export type TgMessage =
  | { method: 'sendMessage'; text: string; preview: { url: string; showAboveText: boolean } | null; buttons: UrlButton[][] }
  | { method: 'sendPhoto'; photo: string; caption: string; captionAboveMedia: boolean; buttons: UrlButton[][] }
  | { method: 'sendVideo'; video: string; caption: string; captionAboveMedia: boolean; buttons: UrlButton[][] }
  | { method: 'sendMediaGroup'; photos: string[]; caption: string }
  | { method: 'sendPoll'; question: string; options: string[]; quiz: boolean; correctIndex: number | null; explanation: string | null; anonymous: boolean };

export interface RenderResult {
  messages: TgMessage[];
  /** Index in `messages` of the message stats should track. */
  primary:  number;
  /** Human-readable preview (HTML of the text part + poll as text). */
  preview:  string;
}

/**
 * Output of the async "prepare media" step of a LIVE publish (publish/prepare-media.ts):
 * carousel slides rendered and hosted, the longread's Telegraph page created.
 * Absent in shadow mode and in previews, where nothing may be uploaded.
 */
export interface PreparedMedia {
  slideUrls?:   string[];
  longreadUrl?: string;
}

export const READ_BUTTON = 'Читати';
export const CAPTION_LIMIT = 1024;
export const TEXT_LIMIT    = 4096;

function renderBlock(b: Block): string {
  switch (b.type) {
    case 'lead':  return `<b>${inlineToHtml(b.text)}</b>`;
    case 'p':     return inlineToHtml(b.text);
    case 'quote': return `<blockquote>${inlineToHtml(b.text)}</blockquote>`;
    case 'list':  return b.items.map((i) => `• ${inlineToHtml(i)}`).join('\n');
  }
}

function sourceLabel(spec: PostSpec): string {
  if (spec.source?.label) return spec.source.label;
  try { return new URL(spec.source!.url).hostname.replace(/^www\./, ''); } catch { return 'Джерело'; }
}

export function normalizeHashtag(t: string): string {
  return t.trim().replace(/^#+/, '').toLowerCase();
}

/** Body + source + footer + hashtags as one Telegram-HTML string. */
export function composeText(spec: PostSpec, card: Pick<EditorCard, 'footer' | 'linkStyle'>): string {
  const parts: string[] = spec.body.map(renderBlock);
  if (spec.source && card.linkStyle === 'inline') {
    parts.push(`→ <a href="${escapeAttr(spec.source.url)}">${escapeHtml(sourceLabel(spec))}</a>`);
  }
  const tail: string[] = [];
  if (card.footer) tail.push(escapeHtml(card.footer));
  if (spec.source && card.linkStyle === 'footer') {
    tail.push(`Джерело: <a href="${escapeAttr(spec.source.url)}">${escapeHtml(sourceLabel(spec))}</a>`);
  }
  if (spec.hashtags.length) tail.push(spec.hashtags.map((h) => `#${escapeHtml(normalizeHashtag(h))}`).join(' '));
  if (tail.length) parts.push(tail.join('\n'));
  return parts.filter(Boolean).join('\n\n');
}

function composeButtons(spec: PostSpec, card: Pick<EditorCard, 'linkStyle'>): UrlButton[][] {
  const rows: UrlButton[][] = [];
  if (spec.cta) rows.push([{ text: spec.cta.label, url: spec.cta.url }]);
  if (spec.source && card.linkStyle === 'button') rows.push([{ text: `Джерело: ${sourceLabel(spec)}`.slice(0, 40), url: spec.source.url }]);
  return [...rows, ...spec.buttons.map((r) => r.map((b) => ({ text: b.text, url: b.url })))];
}

/** Ukrainian plural: 1 слайд, 2 слайди, 5 слайдів. */
export function pluralUk(n: number, one: string, few: string, many: string): string {
  const d = n % 10;
  const dd = n % 100;
  if (d === 1 && dd !== 11) return one;
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return few;
  return many;
}

/** Text description of carousel slides for previews (nothing is rendered or uploaded). */
function slidesPreview(spec: PostSpec): string {
  const slides = spec.slides ?? [];
  const lines = slides.map((s, i) => `${i + 1}. <b>${escapeHtml(s.title)}</b> — ${escapeHtml(s.text)}${s.image ? `\n   🖼 ${escapeHtml(s.image)}` : ''}`);
  return `🖼 Карусель: ${slides.length} ${pluralUk(slides.length, 'слайд', 'слайди', 'слайдів')}\n${lines.join('\n')}`;
}

/** Text outline of the longread for previews (the Telegraph page is only created on a live publish). */
function longreadPreview(spec: PostSpec, url: string | undefined): string {
  const lr = spec.longread;
  if (!lr) return '📖 Лонгрід: (немає статті)';
  const n = lr.blocks.length;
  const outline = lr.blocks.slice(0, 6).map(renderBlock).join('\n\n');
  const more = n > 6 ? `\n\n… ще ${n - 6} ${pluralUk(n - 6, 'блок', 'блоки', 'блоків')}` : '';
  return `📖 Лонгрід «${escapeHtml(lr.title)}»: ${n} ${pluralUk(n, 'блок', 'блоки', 'блоків')}${url ? ` → ${escapeHtml(url)}` : ''}\n\n${outline}${more}`;
}

/**
 * Pure PostSpec → Telegram Bot API calls. Limits are enforced by lintPost;
 * the renderer only picks the right shape (e.g. a long "photo" post becomes a
 * text message with a large image preview so nothing is truncated).
 */
export function renderTelegram(spec: PostSpec, card: Pick<EditorCard, 'footer' | 'linkStyle'>, prepared: PreparedMedia = {}): RenderResult {
  const text = composeText(spec, card);
  const buttons = composeButtons(spec, card);
  const image = spec.media[0]?.url ?? null;

  switch (spec.format) {
    case 'photo': {
      if (image && visibleLength(text) <= CAPTION_LIMIT) {
        return { messages: [{ method: 'sendPhoto', photo: image, caption: text, captionAboveMedia: spec.placement === 'below', buttons }], primary: 0, preview: text };
      }
      return { messages: [{ method: 'sendMessage', text, preview: image ? { url: image, showAboveText: spec.placement === 'above' } : null, buttons }], primary: 0, preview: text };
    }
    case 'album':
      return { messages: [{ method: 'sendMediaGroup', photos: spec.media.map((m) => m.url), caption: text }], primary: 0, preview: text };
    case 'carousel':
      // Slides become hosted images only in the live publish path; until then the group has no photos.
      return {
        messages: [{ method: 'sendMediaGroup', photos: prepared.slideUrls ?? [], caption: text }],
        primary: 0,
        preview: `${text}\n\n${slidesPreview(spec)}`,
      };
    case 'longread': {
      const url = prepared.longreadUrl;
      return {
        messages: [{
          method: 'sendMessage', text,
          preview: url ? { url, showAboveText: spec.placement === 'above' } : null,
          buttons: url ? [[{ text: READ_BUTTON, url }], ...buttons] : buttons,
        }],
        primary: 0,
        preview: `${text}\n\n${longreadPreview(spec, url)}`,
      };
    }
    case 'video':
      return {
        messages: [{ method: 'sendVideo', video: spec.media[0]?.url ?? '', caption: text, captionAboveMedia: spec.placement === 'below', buttons }],
        primary: 0,
        preview: `${text}\n\n🎬 ${escapeHtml(spec.media[0]?.url ?? '(немає відео)')}`,
      };
    case 'poll':
    case 'quiz': {
      const p = spec.poll;
      if (!p) throw new Error(`${spec.format} requires poll`);
      const poll: TgMessage = {
        method: 'sendPoll',
        question: inlineToPlain(p.question),
        options: p.options.map(inlineToPlain),
        quiz: spec.format === 'quiz',
        correctIndex: spec.format === 'quiz' ? (p.correct_index ?? null) : null,
        explanation: spec.format === 'quiz' && p.explanation ? inlineToPlain(p.explanation) : null,
        anonymous: p.anonymous,
      };
      const pollPreview = `📊 ${poll.question}\n${poll.options.map((o, i) => `${poll.correctIndex === i ? '✅' : '▫️'} ${o}`).join('\n')}`;
      // A Telegram poll cannot carry an image: the picture (e.g. a ПДР situation) is an intro photo right before it.
      if (image && visibleLength(text) <= CAPTION_LIMIT) {
        return {
          messages: [{ method: 'sendPhoto', photo: image, caption: text, captionAboveMedia: spec.placement === 'below', buttons }, poll],
          primary: 1,
          preview: `${text ? `${text}\n\n` : ''}${escapeHtml(pollPreview)}`,
        };
      }
      if (spec.body.length || image) {
        return {
          messages: [{ method: 'sendMessage', text, preview: image ? { url: image, showAboveText: spec.placement === 'above' } : null, buttons }, poll],
          primary: 1,
          preview: `${text}\n\n${escapeHtml(pollPreview)}`,
        };
      }
      return { messages: [poll], primary: 0, preview: escapeHtml(pollPreview) };
    }
    case 'text':
    default:
      return { messages: [{ method: 'sendMessage', text, preview: image ? { url: image, showAboveText: spec.placement === 'above' } : null, buttons }], primary: 0, preview: text };
  }
}
