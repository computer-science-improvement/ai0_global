import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import FormData from 'form-data';
import { PostPayload } from '../common/types';
import { BasePublisher, PublishTarget } from './base.publisher';
import { ChannelConfigService } from '../config/channel-config.service';
import { PostingThrottleService } from './posting-throttle.service';
import { StructuredLoggerService } from '../common/logging/structured-logger.service';

export interface PromptPayload {
  imageBuffer: Buffer;
  caption:     string;
  replyText?:  string;
}

@Injectable()
export class TelegramPublisher extends BasePublisher {
  readonly platform = 'telegram';
  private readonly logger = new Logger(TelegramPublisher.name);

  private static readonly BLOCKED_PATTERNS = [
    'SKIP_POST',
    'insufficient_quota',
    'rate limit',
    'as an ai',
    'as a language model',
    'i cannot',
    'i am unable',
    '"error":',
  ];

  constructor(
    private readonly channelConfig: ChannelConfigService,
    private readonly throttle:      PostingThrottleService,
    private readonly structured:    StructuredLoggerService,
  ) {
    super();
  }

  /** Final guard — refuse to publish garbage regardless of what the workflow sends */
  private guardText(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length < 20) {
      throw new Error(`Publish blocked: text too short (${trimmed.length} chars)`);
    }
    const lower = trimmed.toLowerCase();
    for (const pattern of TelegramPublisher.BLOCKED_PATTERNS) {
      if (lower.includes(pattern.toLowerCase())) {
        throw new Error(`Publish blocked: text contains "${pattern}"`);
      }
    }
  }

  async publish(payload: PostPayload, target: PublishTarget): Promise<string> {
    try {
      this.guardText(payload.text);
    } catch (err: any) {
      this.structured.publication({
        channelId: target.id, source: payload.source, title: payload.title,
        text: payload.text, imageUrl: payload.imageUrl ?? null,
        status: 'blocked', error: err.message,
      });
      throw err;
    }
    const { chatId, botToken } = this.channelConfig.resolveChannel(target.id);
    const base = `https://api.telegram.org/bot${botToken}`;

    const photo: Buffer | string | undefined = payload.imageBuffer ?? payload.imageUrl;
    const visibleLength = payload.text.replace(/<[^>]*>/g, '').length;

    let messageId: string;
    try {
      if (photo && visibleLength <= 1024) {
        messageId = await this.sendPhotoWithCaption(base, chatId, photo, payload.text);
      } else if (photo) {
        await this.sendPhoto(base, chatId, photo);
        messageId = await this.sendMessage(base, chatId, payload.text);
      } else {
        messageId = await this.sendMessage(base, chatId, payload.text);
      }
    } catch (err: any) {
      this.structured.publication({
        channelId: target.id, source: payload.source, title: payload.title,
        text: payload.text, imageUrl: payload.imageUrl ?? null,
        status: 'failure', error: err.response?.data?.description ?? err.message,
      });
      throw err;
    }
    this.throttle.recordPublish(target.id);
    this.structured.publication({
      channelId: target.id, source: payload.source, title: payload.title,
      text: payload.text, imageUrl: payload.imageUrl ?? null,
      messageId, status: 'success',
    });
    return messageId;
  }

  private async sendPhotoWithCaption(
    base: string,
    chatId: string,
    image: Buffer | string,
    caption: string,
  ): Promise<string> {
    const form = new FormData();
    form.append('chat_id',    chatId);
    form.append('caption',    caption);
    form.append('parse_mode', 'HTML');
    if (typeof image === 'string') {
      form.append('photo', image);
    } else {
      form.append('photo', image, { filename: 'image.jpg', contentType: 'image/jpeg' });
    }

    const res = await axios.post(`${base}/sendPhoto`, form, {
      headers: form.getHeaders(),
      timeout: 30000,
    });
    this.logger.log(`Photo+caption sent to ${chatId}, message_id: ${res.data.result.message_id}`);
    return String(res.data.result.message_id);
  }

  private async sendPhoto(base: string, chatId: string, image: Buffer | string): Promise<void> {
    const form = new FormData();
    form.append('chat_id', chatId);
    if (typeof image === 'string') {
      form.append('photo', image);
    } else {
      form.append('photo', image, { filename: 'image.jpg', contentType: 'image/jpeg' });
    }

    const res = await axios.post(`${base}/sendPhoto`, form, {
      headers: form.getHeaders(),
      timeout: 30000,
    });
    this.logger.log(`Photo sent to ${chatId}, message_id: ${res.data.result.message_id}`);
  }

  async publishPrompt(payload: PromptPayload, target: PublishTarget): Promise<string> {
    this.guardText(payload.caption);
    const { chatId, botToken } = this.channelConfig.resolveChannel(target.id);
    const base = `https://api.telegram.org/bot${botToken}`;

    // Caption below image (no show_caption_above_media)
    const form = new FormData();
    form.append('chat_id',    chatId);
    form.append('caption',    payload.caption);
    form.append('parse_mode', 'HTML');
    form.append('photo', payload.imageBuffer, { filename: 'image.jpg', contentType: 'image/jpeg' });

    const res = await axios.post(`${base}/sendPhoto`, form, {
      headers: form.getHeaders(),
      timeout: 30000,
    });
    const messageId = String(res.data.result.message_id);
    this.throttle.recordPublish(target.id);
    this.logger.log(`Prompt photo sent to ${chatId}, message_id: ${messageId}`);

    if (payload.replyText) {
      await this.sendReply(base, chatId, payload.replyText, messageId);
    }

    return messageId;
  }

  private async sendReply(base: string, chatId: string, text: string, replyToMessageId: string): Promise<void> {
    await axios.post(
      `${base}/sendMessage`,
      {
        chat_id:              chatId,
        text,
        parse_mode:           'HTML',
        reply_to_message_id:  Number(replyToMessageId),
        link_preview_options: { is_disabled: true },
      },
      { timeout: 15000 },
    );
    this.logger.log(`Reply sent to ${chatId} (reply_to: ${replyToMessageId})`);
  }

  private async sendMessage(base: string, chatId: string, text: string): Promise<string> {
    const res = await axios.post(
      `${base}/sendMessage`,
      {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_notification: true,
        link_preview_options: { is_disabled: true },
      },
      { timeout: 15000 },
    );
    this.logger.log(`Message sent to ${chatId}, message_id: ${res.data.result.message_id}`);
    return String(res.data.result.message_id);
  }
}
