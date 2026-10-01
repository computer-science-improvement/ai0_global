import axios from 'axios';
import type { TgMessage, UrlButton } from '../post/render-telegram';

export interface TelegramChannelResolver {
  resolveChannel(channelKey: string): { chatId: string; botToken: string };
  isPublishPausedFor(channelKey: string): boolean;
}

export type BotPost = (url: string, body: unknown) => Promise<{ data: any }>;

export interface SendResult {
  messageIds:    number[];
  /** Set when a later message of a multi-message post failed after the first one went out. */
  partialError?: string;
}

export class ChannelPausedForEditorError extends Error {
  constructor(channelKey: string) { super(`channel ${channelKey} has publish_paused=true`); }
}

function keyboard(rows: UrlButton[][]): Record<string, unknown> | undefined {
  return rows.length ? { reply_markup: { inline_keyboard: rows.map((r) => r.map((b) => ({ text: b.text, url: b.url }))) } } : undefined;
}

/**
 * Executes renderer output against the Bot API. No decisions here — all
 * guards live in the publish_post tool. Sends sequentially; if the first
 * message is out and a later one fails, the post is reported as published
 * with `partialError` (never re-sent → no duplicate loops).
 */
export class TelegramEditorPublisher {
  constructor(
    private readonly channels: TelegramChannelResolver,
    private readonly post: BotPost = (u, b) => axios.post(u, b, { timeout: 30_000 }),
  ) {}

  async send(channelKey: string, messages: TgMessage[]): Promise<SendResult> {
    if (this.channels.isPublishPausedFor(channelKey)) throw new ChannelPausedForEditorError(channelKey);
    const { chatId, botToken } = this.channels.resolveChannel(channelKey);
    const base = `https://api.telegram.org/bot${botToken}`;

    const ids: number[] = [];
    for (const m of messages) {
      try {
        ids.push(await this.sendOne(base, chatId, m));
      } catch (err: any) {
        const reason = err?.response?.data?.description ?? err?.message ?? String(err);
        if (!ids.length) throw new Error(`Telegram ${m.method} failed: ${reason}`);
        return { messageIds: ids, partialError: `${m.method}: ${reason}` };
      }
    }
    return { messageIds: ids };
  }

  private async sendOne(base: string, chatId: string, m: TgMessage): Promise<number> {
    let method: string;
    let body: Record<string, unknown>;
    switch (m.method) {
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
      case 'sendMediaGroup':
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
    const { data } = await this.post(`${base}/${method}`, body);
    if (!data?.ok) throw new Error(data?.description ?? `${method} returned ok=false`);
    const result = Array.isArray(data.result) ? data.result[0] : data.result;
    return Number(result?.message_id);
  }
}
