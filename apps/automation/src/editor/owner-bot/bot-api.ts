import axios from 'axios';

/**
 * The Bot API calls the owner bot needs (spec 012 FR-001): send a card, edit it after a tap, answer the tap.
 * HTML parse mode; every dynamic text is escaped by the caller (owner-text.ts).
 */
export interface InlineButton { text: string; data?: string; url?: string }
export type Keyboard = InlineButton[][];

export interface BotApi {
  /** Sends a message; returns its message_id. */
  send(chatId: string, text: string, keyboard?: Keyboard | null): Promise<number>;
  /** Replaces a message's text and keyboard (null removes the buttons). */
  edit(chatId: string, messageId: number, text: string, keyboard?: Keyboard | null): Promise<void>;
  answer(callbackId: string, text?: string): Promise<void>;
}

/** A Bot API refusal with Telegram's description (e.g. "message to edit not found", "bot was blocked by the user"). */
export class BotApiError extends Error {
  constructor(readonly description: string, readonly code: number | null) { super(description); }
  /** The message is gone or can no longer be edited: the card is closed quietly. */
  get gone(): boolean { return /message to edit not found|message can't be edited|chat not found|bot was blocked/i.test(this.description); }
  get notModified(): boolean { return /message is not modified/i.test(this.description); }
}

const markup = (kb?: Keyboard | null) => ({
  inline_keyboard: (kb ?? []).map((row) => row.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data ?? 'noop' }))),
});

type Post = (url: string, body: unknown, opts: { timeout: number }) => Promise<{ data: any }>;

export function telegramBotApi(token: string, post: Post = (u, b, o) => axios.post(u, b, o)): BotApi {
  const call = async (method: string, body: Record<string, unknown>) => {
    try {
      const res = await post(`https://api.telegram.org/bot${token}/${method}`, body, { timeout: 15_000 });
      return res.data?.result;
    } catch (err: any) {
      const d = err?.response?.data;
      if (d && typeof d.description === 'string') throw new BotApiError(d.description, typeof d.error_code === 'number' ? d.error_code : null);
      throw err;
    }
  };
  return {
    async send(chatId, text, keyboard) {
      const r = await call('sendMessage', {
        chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
        ...(keyboard?.length ? { reply_markup: markup(keyboard) } : {}),
      });
      return Number(r?.message_id);
    },
    async edit(chatId, messageId, text, keyboard) {
      await call('editMessageText', {
        chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
        reply_markup: markup(keyboard),
      });
    },
    async answer(callbackId, text) {
      try {
        await call('answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text: text.slice(0, 190) } : {}) });
      } catch { /* the toast is best-effort */ }
    },
  };
}
