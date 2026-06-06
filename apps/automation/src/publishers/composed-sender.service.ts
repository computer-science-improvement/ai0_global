import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { TelegramStatsClient } from '../stats/telegram-stats.client';
import type { ButtonRow, MediaType, Placement, Sender } from '../scheduled-posts/scheduled-posts.types';

export interface ComposedSend {
  chatId:    string;
  botToken:  string | null;   // required for sender='bot'
  sender:    Sender;
  text:      string;
  mediaType: MediaType;
  mediaUrl:  string | null;
  placement: Placement;
  buttons:   ButtonRow[];
}

@Injectable()
export class ComposedSenderService {
  private readonly logger = new Logger(ComposedSenderService.name);
  constructor(private readonly userClient: TelegramStatsClient) {}

  /** Publish a composed post. Does NOT touch cooldown/throttle. Returns message id. */
  async send(i: ComposedSend): Promise<number> {
    return i.sender === 'mtproto_user' ? this.sendViaUser(i) : this.sendViaBot(i);
  }

  // ── Bot API ────────────────────────────────────────────────────────────────
  private async sendViaBot(i: ComposedSend): Promise<number> {
    if (!i.botToken) throw new Error('bot token missing for composed bot send');
    const base = `https://api.telegram.org/bot${i.botToken}`;
    const replyMarkup = this.botReplyMarkup(i.buttons);

    // Native media + caption (media ABOVE text). Caption ≤1024 enforced upstream.
    if (i.mediaType !== 'none' && i.placement === 'above') {
      const method = i.mediaType === 'photo' ? 'sendPhoto' : 'sendVideo';
      const field  = i.mediaType === 'photo' ? 'photo' : 'video';
      const { data } = await axios.post(`${base}/${method}`, {
        chat_id: i.chatId, [field]: i.mediaUrl, caption: i.text, parse_mode: 'HTML',
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
      return this.botMessageId(data);
    }

    // Text message; media (if any) rendered as a link-preview ABOVE/BELOW text.
    const linkPreview = i.mediaType !== 'none' && i.mediaUrl
      ? { url: i.mediaUrl, show_above_text: i.placement === 'above', prefer_large_media: true }
      : { is_disabled: true };
    const { data } = await axios.post(`${base}/sendMessage`, {
      chat_id: i.chatId, text: i.text, parse_mode: 'HTML',
      link_preview_options: linkPreview,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
    return this.botMessageId(data);
  }

  private botReplyMarkup(rows: ButtonRow[]): { inline_keyboard: { text: string; url: string }[][] } | null {
    const kb = rows.map(r => r.buttons.map(b => ({ text: b.label, url: b.url }))).filter(r => r.length);
    return kb.length ? { inline_keyboard: kb } : null;
  }

  private botMessageId(data: any): number {
    if (!data?.ok) throw new Error(`Telegram API: ${data?.description ?? 'unknown error'}`);
    return data.result.message_id as number;
  }

  // ── MTProto user ─────────────────────────────────────────────────────────────
  private async sendViaUser(i: ComposedSend): Promise<number> {
    if (!this.userClient.isEnabled()) throw new Error('MTProto-user session not configured/ready');
    if (i.mediaType === 'photo' && i.mediaUrl) {
      // gramjs sendFile accepts a URL string for photo/video alike.
      return this.userClient.sendVideoWithCaption(i.chatId, i.mediaUrl, i.text); // sendFile handles photo URLs too
    }
    if (i.mediaType === 'video' && i.mediaUrl) {
      return this.userClient.sendVideoWithCaption(i.chatId, i.mediaUrl, i.text);
    }
    return this.userClient.sendMessage(i.chatId, i.text);
  }
}
