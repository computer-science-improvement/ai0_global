import axios from 'axios';
import type { TgHtmlMessage, TgMessage, TgRichMessage, UrlButton } from '../post/render-telegram';
import { classifyRichRejection, type RichCapability } from './rich-capability';

export interface TelegramChannelResolver {
  resolveChannel(channelKey: string): { chatId: string; botToken: string };
  isPublishPausedFor(channelKey: string): boolean;
}

export type BotPost = (url: string, body: unknown) => Promise<{ data: any }>;

export interface SendResult {
  messageIds:    number[];
  /** Set when a later message of a multi-message post failed after the first one went out. */
  partialError?: string;
  /** Spec 033 FR-003: a rich message went out as its HTML fallback (Telegram rejected it, or the channel is flagged). */
  fallback?:     'html';
  fallbackReason?: string;
}

export interface EditResult {
  /** 'rich' — edited with rich_message; 'html' — with the HTML fallback text / caption. */
  sent: 'rich' | 'html';
  fallbackReason?: string;
}

export class ChannelPausedForEditorError extends Error {
  constructor(channelKey: string) { super(`channel ${channelKey} has publish_paused=true`); }
}

function keyboard(rows: UrlButton[][]): Record<string, unknown> | undefined {
  return rows.length ? { reply_markup: { inline_keyboard: rows.map((r) => r.map((b) => ({ text: b.text, url: b.url }))) } } : undefined;
}

/** A Bot API `ok: false` answer, kept for classifyRichRejection. */
class TelegramCallError extends Error {
  constructor(readonly telegram: { ok: false; error_code?: number; description?: string }, method: string) {
    super(telegram?.description ?? `${method} returned ok=false`);
  }
}

export interface TelegramEditorPublisherOptions {
  /** Spec 033 FR-003: the per-channel "rich unsupported" flag. Without it a rejection still falls back, nothing is remembered. */
  richCapability?: RichCapability;
  log?: (msg: string) => void;
  now?: () => Date;
}

/**
 * Executes renderer output against the Bot API. No decisions here — all
 * guards live in the publish_post tool. Sends sequentially; if the first
 * message is out and a later one fails, the post is reported as published
 * with `partialError` (never re-sent → no duplicate loops).
 *
 * Spec 033: a `sendRichMessage` goes out with `sendRichMessage`; when Telegram
 * definitely rejects it, the stored HTML fallback is sent once instead and the
 * result says `fallback: 'html'`. A hard "unsupported" answer flags the
 * channel for 7 days; while flagged, the fallback is sent directly.
 */
export class TelegramEditorPublisher {
  constructor(
    private readonly channels: TelegramChannelResolver,
    private readonly post: BotPost = (u, b) => axios.post(u, b, { timeout: 30_000 }),
    private readonly opts: TelegramEditorPublisherOptions = {},
  ) {}

  private get now(): Date { return this.opts.now ? this.opts.now() : new Date(); }

  async send(channelKey: string, messages: TgMessage[]): Promise<SendResult> {
    if (this.channels.isPublishPausedFor(channelKey)) throw new ChannelPausedForEditorError(channelKey);
    const { chatId, botToken } = this.channels.resolveChannel(channelKey);
    const base = `https://api.telegram.org/bot${botToken}`;

    const ids: number[] = [];
    let fallback: Pick<SendResult, 'fallback' | 'fallbackReason'> = {};
    for (const m of messages) {
      try {
        if (m.method === 'sendRichMessage') {
          const r = await this.sendRich(base, chatId, channelKey, m);
          ids.push(r.id);
          if (r.fallbackReason) fallback = { fallback: 'html', fallbackReason: r.fallbackReason };
        } else {
          ids.push(await this.sendOne(base, chatId, m));
        }
      } catch (err: any) {
        const reason = err?.response?.data?.description ?? err?.message ?? String(err);
        if (!ids.length) throw new Error(`Telegram ${m.method} failed: ${reason}`);
        return { messageIds: ids, partialError: `${m.method}: ${reason}`, ...fallback };
      }
    }
    return { messageIds: ids, ...fallback };
  }

  /**
   * Edit a published editor post in place (spec 033 FR-002): a rich message
   * via `editMessageText` + `rich_message`, falling back to the HTML text /
   * caption on a rejection (same rules as send); HTML messages via
   * `editMessageText` / `editMessageCaption`.
   */
  async edit(channelKey: string, messageId: number, m: TgMessage): Promise<EditResult> {
    if (this.channels.isPublishPausedFor(channelKey)) throw new ChannelPausedForEditorError(channelKey);
    const { chatId, botToken } = this.channels.resolveChannel(channelKey);
    const base = `https://api.telegram.org/bot${botToken}`;
    if (m.method !== 'sendRichMessage') {
      await this.editHtml(base, chatId, messageId, m);
      return { sent: 'html' };
    }
    const cap = this.opts.richCapability;
    if (cap && await cap.isUnsupported(channelKey, this.now).catch(() => false)) {
      await this.editHtml(base, chatId, messageId, m.fallback);
      return { sent: 'html', fallbackReason: 'rich messages are flagged unsupported for this channel' };
    }
    try {
      await this.call(base, 'editMessageText', {
        chat_id: chatId, message_id: messageId, rich_message: { blocks: m.blocks }, ...keyboard(m.buttons),
      });
      return { sent: 'rich' };
    } catch (err) {
      const reason = await this.onRichRejected(channelKey, 'editMessageText', err);
      await this.editHtml(base, chatId, messageId, m.fallback);
      return { sent: 'html', fallbackReason: reason };
    }
  }

  private async editHtml(base: string, chatId: string, messageId: number, m: TgMessage): Promise<void> {
    switch (m.method) {
      case 'sendMessage':
        await this.call(base, 'editMessageText', {
          chat_id: chatId, message_id: messageId, text: m.text, parse_mode: 'HTML',
          link_preview_options: m.preview
            ? { url: m.preview.url, prefer_large_media: true, show_above_text: m.preview.showAboveText }
            : { is_disabled: true },
          ...keyboard(m.buttons),
        });
        return;
      case 'sendPhoto':
      case 'sendVideo':
        await this.call(base, 'editMessageCaption', {
          chat_id: chatId, message_id: messageId, caption: m.caption, parse_mode: 'HTML',
          show_caption_above_media: m.captionAboveMedia, ...keyboard(m.buttons),
        });
        return;
      default:
        throw new Error(`${m.method} cannot be edited`);
    }
  }

  /** A rich message, or its fallback when Telegram rejects it / the channel is flagged. */
  private async sendRich(base: string, chatId: string, channelKey: string, m: TgRichMessage): Promise<{ id: number; fallbackReason?: string }> {
    const cap = this.opts.richCapability;
    if (cap && await cap.isUnsupported(channelKey, this.now).catch(() => false)) {
      return { id: await this.sendOne(base, chatId, m.fallback), fallbackReason: 'rich messages are flagged unsupported for this channel' };
    }
    try {
      return { id: await this.sendOne(base, chatId, m) };
    } catch (err) {
      const reason = await this.onRichRejected(channelKey, 'sendRichMessage', err);
      return { id: await this.sendOne(base, chatId, m.fallback), fallbackReason: reason };
    }
  }

  /** Classify a failed rich call: rethrows when it is not a definite rejection (nothing is retried then). */
  private async onRichRejected(channelKey: string, method: string, err: unknown): Promise<string> {
    const r = classifyRichRejection(err);
    if (!r) throw err;
    this.opts.log?.(`${channelKey}: ${method} rejected (${r.kind}: ${r.reason}) — retrying once with the HTML fallback`);
    if (r.kind === 'unsupported' && this.opts.richCapability) {
      await this.opts.richCapability.markUnsupported(channelKey, this.now).catch((e) => this.opts.log?.(`${channelKey}: rich capability flag not saved: ${e?.message ?? e}`));
    }
    return r.reason;
  }

  private async call(base: string, method: string, body: Record<string, unknown>): Promise<any> {
    const { data } = await this.post(`${base}/${method}`, body);
    if (!data?.ok) throw new TelegramCallError(data ?? { ok: false }, method);
    return data.result;
  }

  private async sendOne(base: string, chatId: string, m: TgMessage | TgHtmlMessage): Promise<number> {
    let method: string;
    let body: Record<string, unknown>;
    switch (m.method) {
      case 'sendRichMessage':
        method = 'sendRichMessage';
        body = { chat_id: chatId, rich_message: { blocks: m.blocks }, ...keyboard(m.buttons) };
        break;
      case 'sendMessage':
        method = 'sendMessage';
        body = {
          chat_id: chatId, text: m.text, parse_mode: 'HTML',
          link_preview_options: m.preview
            ? { url: m.preview.url, prefer_large_media: true, show_above_text: m.preview.showAboveText }
            : { is_disabled: true },
          ...keyboard(m.buttons),
        };
        break;
      case 'sendPhoto':
        method = 'sendPhoto';
        body = {
          chat_id: chatId, photo: m.photo, caption: m.caption, parse_mode: 'HTML',
          show_caption_above_media: m.captionAboveMedia, ...keyboard(m.buttons),
        };
        break;
      case 'sendVideo':
        method = 'sendVideo';
        body = {
          chat_id: chatId, video: m.video, caption: m.caption, parse_mode: 'HTML', supports_streaming: true,
          show_caption_above_media: m.captionAboveMedia, ...keyboard(m.buttons),
        };
        break;
      case 'sendMediaGroup':
        // A carousel whose slides were never prepared (hosted) must not go out as an empty group.
        if (m.photos.length < 2) throw new Error(`sendMediaGroup needs 2–10 photos, got ${m.photos.length}`);
        method = 'sendMediaGroup';
        body = {
          chat_id: chatId,
          media: m.photos.map((url, i) => ({ type: 'photo', media: url, ...(i === 0 && m.caption ? { caption: m.caption, parse_mode: 'HTML' } : {}) })),
        };
        break;
      case 'sendPoll':
        method = 'sendPoll';
        body = {
          chat_id: chatId, question: m.question, options: m.options.map((text) => ({ text })),
          type: m.quiz ? 'quiz' : 'regular', is_anonymous: m.anonymous,
          ...(m.quiz && m.correctIndex !== null ? { correct_option_id: m.correctIndex } : {}),
          ...(m.quiz && m.explanation ? { explanation: m.explanation } : {}),
        };
        break;
    }
    const result = await this.call(base, method, body);
    const first = Array.isArray(result) ? result[0] : result;
    return Number(first?.message_id);
  }
}
