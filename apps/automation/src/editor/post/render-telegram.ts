import type { EditorCard } from '../card';
import type { Block, InnerBlock, PostSpec } from './post-spec';
import { tableRow, usesRichBlocks } from './blocks';
import { blockToRich, type RichBlock } from './render-rich';
import { escapeAttr, escapeHtml, inlineToHtml, inlineToPlain, visibleLength } from './inline-markup';

export interface UrlButton { text: string; url: string }

/** The Telegram-HTML calls (today's render and the fallback of a rich message). */
export type TgHtmlMessage =
  | { method: 'sendMessage'; text: string; preview: { url: string; showAboveText: boolean } | null; buttons: UrlButton[][] }
  | { method: 'sendPhoto'; photo: string; caption: string; captionAboveMedia: boolean; buttons: UrlButton[][] }
  | { method: 'sendVideo'; video: string; caption: string; captionAboveMedia: boolean; buttons: UrlButton[][] };

/**
 * Spec 033: a Bot API 10.1 rich message (`sendRichMessage`, `InputRichMessage.blocks`).
 * `fallback` is the HTML render of the same post: the publisher sends it when
 * Telegram rejects the rich message, so an approved post (031) carries both.
 */
export interface TgRichMessage { method: 'sendRichMessage'; blocks: RichBlock[]; buttons: UrlButton[][]; fallback: TgHtmlMessage }

export type TgMessage =
  | TgHtmlMessage
  | TgRichMessage
  | { method: 'sendMediaGroup'; photos: string[]; caption: string }
  | { method: 'sendPoll'; question: string; options: string[]; quiz: boolean; correctIndex: number | null; explanation: string | null; anonymous: boolean };

/** Spec 033 FR-005: format_prefs.rich of the resource — auto (rich when rich blocks are used), prefer, never. */
export type RichPref = 'auto' | 'prefer' | 'never';

/**
 * What the renderer reads from the channel card. `richPref` comes from the
 * resource's format_prefs and `richUnsupported` from the per-channel
 * capability flag (FR-003); both are joined in by EditorChannelsRepository.
 */
export type RenderCard = Pick<EditorCard, 'footer' | 'linkStyle'> & Partial<Pick<EditorCard, 'richPref' | 'richUnsupported'>>;

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

/** Widest monospace table that still reads on a phone (≈ 375 px) without wrapping. */
export const PRE_GRID_MAX_WIDTH = 34;

/**
 * Spec 033 FR-003: a table in Telegram HTML. Narrow tables become a monospace
 * `<pre>` grid; wider ones become bullet rows ("• **key** — col: value; …").
 */
export function tableToHtml(header: string[], rows: string[][]): string {
  const w = header.length;
  const plain = [header, ...rows].map((r) => tableRow(r, w).map((c) => inlineToPlain(c).replace(/\s+/g, ' ').trim()));
  const widths = Array.from({ length: w }, (_, i) => Math.max(...plain.map((r) => [...r[i]].length), 1));
  const total = widths.reduce((a, b) => a + b, 0) + 3 * (w - 1);
  if (total <= PRE_GRID_MAX_WIDTH) {
    const line = (r: string[]) => r.map((c, i) => c + ' '.repeat(widths[i] - [...c].length)).join(' | ').trimEnd();
    const sep = widths.map((n) => '-'.repeat(n)).join('-+-');
    return `<pre>${escapeHtml([line(plain[0]), sep, ...plain.slice(1).map(line)].join('\n'))}</pre>`;
  }
  const head = tableRow(header, w).map(inlineToHtml);
  return rows.map((raw) => {
    const r = tableRow(raw, w).map(inlineToHtml);
    if (w === 1) return `• ${r[0]}`;
    const rest = w === 2 ? r[1] : r.slice(1).map((c, i) => `${head[i + 1]}: ${c || '—'}`).join('; ');
    return `• <b>${r[0] || '—'}</b> — ${rest}`;
  }).join('\n');
}

/**
 * One block as Telegram HTML. Rich-only blocks (spec 033) degrade here — this
 * is both the non-rich render and the HTML fallback of a rich message:
 * headings → bold lines, olist → "1." lines, table → `<pre>` grid or bullet
 * rows, math → `<code>`, details → bold title + expandable quote.
 */
export function renderBlock(b: Block | InnerBlock): string {
  switch (b.type) {
    case 'lead':    return `<b>${inlineToHtml(b.text)}</b>`;
    case 'p':       return inlineToHtml(b.text);
    case 'quote':   return `<blockquote>${inlineToHtml(b.text)}</blockquote>`;
    case 'list':    return b.items.map((i) => `• ${inlineToHtml(i)}`).join('\n');
    case 'heading': return `<b>${inlineToHtml(b.text)}</b>`;
    case 'olist':   return b.items.map((i, n) => `${n + 1}. ${inlineToHtml(i)}`).join('\n');
    case 'table':   return tableToHtml(b.header, b.rows);
    case 'math':    return `<code>${escapeHtml(b.expression)}</code>`;
    case 'divider': return '';
    case 'footer':  return `<i>${inlineToHtml(b.text)}</i>`;
    case 'code':    return b.language
      ? `<pre><code class="language-${escapeAttr(b.language)}">${escapeHtml(b.text)}</code></pre>`
      : `<pre>${escapeHtml(b.text)}</pre>`;
    case 'details': return `<b>${inlineToHtml(b.title)}</b>\n<blockquote expandable>${b.body.map((x) => (x.type === 'quote' ? `«${inlineToHtml(x.text)}»` : renderBlock(x))).filter(Boolean).join('\n\n')}</blockquote>`;
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
export function composeText(spec: PostSpec, card: RenderCard): string {
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

function composeButtons(spec: PostSpec, card: RenderCard): UrlButton[][] {
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

/** Telegram-HTML render: a long "photo" post becomes a text message with a large image preview so nothing is truncated. */
function renderHtml(spec: PostSpec, card: RenderCard, prepared: PreparedMedia): RenderResult {
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

/** Formats whose text message can become a rich message (album / carousel captions stay HTML). */
export const RICH_FORMATS: ReadonlySet<PostSpec['format']> = new Set(['text', 'photo', 'video', 'longread', 'poll', 'quiz']);

/**
 * Spec 033 FR-002: does this post go out as a rich message? Yes when it uses a
 * rich-only block or the resource prefers rich — unless the resource says
 * never, the channel is flagged as not supporting rich messages, or the
 * format has no text message to carry it.
 */
export function wantsRich(spec: PostSpec, card: RenderCard): boolean {
  const pref = card.richPref ?? 'auto';
  if (pref === 'never' || card.richUnsupported || !RICH_FORMATS.has(spec.format) || !spec.body.length) return false;
  return pref === 'prefer' || usesRichBlocks(spec.body);
}

/** Source / footer / hashtags of a rich message: one paragraph per line (HTML puts them on one paragraph). */
function richTail(spec: PostSpec, card: RenderCard): RichBlock[] {
  const out: RichBlock[] = [];
  const link = (label: string) => ({ type: 'url' as const, text: label, url: spec.source!.url });
  if (spec.source && card.linkStyle === 'inline') out.push({ type: 'paragraph', text: ['→ ', link(sourceLabel(spec))] });
  if (card.footer) out.push({ type: 'paragraph', text: card.footer });
  if (spec.source && card.linkStyle === 'footer') out.push({ type: 'paragraph', text: ['Джерело: ', link(sourceLabel(spec))] });
  if (spec.hashtags.length) out.push({ type: 'paragraph', text: spec.hashtags.map((h) => `#${normalizeHashtag(h)}`).join(' ') });
  return out;
}

/** The rich message for a post; `fallback` is the HTML message it replaces. */
export function toRichMessage(spec: PostSpec, card: RenderCard, fallback: TgHtmlMessage): TgRichMessage {
  const blocks: RichBlock[] = [...spec.body.flatMap(blockToRich), ...richTail(spec, card)];
  const first = spec.media[0];
  let media: RichBlock | null = null;
  if (spec.format === 'video') {
    if (first) media = { type: 'video', video: { type: 'video', media: first.url, supports_streaming: true } };
  } else if (first && first.kind !== 'video') {
    media = { type: 'photo', photo: { type: 'photo', media: first.url } };
  }
  if (media) {
    if (spec.placement === 'below') blocks.push(media);
    else blocks.unshift(media);
  }
  return { method: 'sendRichMessage', blocks, buttons: fallback.buttons, fallback };
}

/**
 * Pure PostSpec → Telegram Bot API calls. Limits are enforced by lintPost.
 * Spec 033: when wantsRich(), the post's text message becomes a
 * `sendRichMessage` carrying the HTML render as its fallback; polls, albums
 * and carousels keep their own calls. The preview stays the HTML text.
 */
export function renderTelegram(spec: PostSpec, card: RenderCard, prepared: PreparedMedia = {}): RenderResult {
  const html = renderHtml(spec, card, prepared);
  if (!wantsRich(spec, card)) return html;
  const i = html.messages.findIndex((m) => m.method === 'sendMessage' || m.method === 'sendPhoto' || m.method === 'sendVideo');
  if (i < 0) return html;
  const messages = [...html.messages];
  messages[i] = toRichMessage(spec, card, messages[i] as TgHtmlMessage);
  return { ...html, messages };
}
