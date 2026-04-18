import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramClient, Api } from 'telegram';
import { StringSession }       from 'telegram/sessions';

export interface ChannelInfo {
  subscribers: number | null;
  title:       string | null;
  description: string | null;
  onlineCount: number | null;
}

export interface PostMetrics {
  views:           number | null;
  forwards:        number | null;
  replies:         number | null;
  reactions:       Record<string, number> | null;
  reactionsTotal:  number;
}

/**
 * Thin MTProto wrapper around gramjs. Requires a user-account session because
 * per-post views/reactions are not exposed to Bot API tokens.
 *
 * Single connection, lazily initialised. Callers should guard with
 * `isEnabled()` — if creds are missing, the client no-ops (returns nulls)
 * rather than throwing, so the rest of the app keeps working.
 */
@Injectable()
export class TelegramStatsClient implements OnModuleInit {
  private readonly logger = new Logger(TelegramStatsClient.name);
  private client: TelegramClient | null = null;
  private ready = false;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const apiId   = parseInt(this.config.get<string>('TELEGRAM_API_ID') ?? '', 10);
    const apiHash = this.config.get<string>('TELEGRAM_API_HASH') ?? '';
    const session = this.config.get<string>('TELEGRAM_SESSION_STRING') ?? '';

    if (!apiId || !apiHash || !session) {
      this.logger.warn(
        'TelegramStatsClient disabled: TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION_STRING missing',
      );
      return;
    }

    try {
      this.client = new TelegramClient(new StringSession(session), apiId, apiHash, {
        connectionRetries: 3,
        baseLogger: undefined,
      });
      // Suppress gramjs internal noisy logs
      (this.client as any).setLogLevel?.('error');
      await this.client.connect();
      this.ready = true;
      this.logger.log('TelegramStatsClient connected via MTProto');
    } catch (err: any) {
      this.logger.error(`TelegramStatsClient connect failed: ${err.message}`);
      this.client = null;
    }
  }

  isEnabled(): boolean {
    return this.ready && this.client !== null;
  }

  async getChannelInfo(channelId: string): Promise<ChannelInfo | null> {
    if (!this.client || !this.ready) return null;
    try {
      const entity = await this.client.getEntity(channelId);
      const full = await this.client.invoke(
        new Api.channels.GetFullChannel({ channel: entity as any }),
      );
      const fullChat: any = (full as any).fullChat ?? {};
      const chat: any     = (full as any).chats?.[0] ?? {};
      return {
        subscribers: typeof fullChat.participantsCount === 'number'
          ? fullChat.participantsCount
          : null,
        title:       chat.title ?? null,
        description: fullChat.about ?? null,
        onlineCount: typeof fullChat.onlineCount === 'number'
          ? fullChat.onlineCount
          : null,
      };
    } catch (err: any) {
      this.logger.warn(`getChannelInfo(${channelId}) failed: ${err.message}`);
      return null;
    }
  }

  async getPostMetrics(channelId: string, messageId: number): Promise<PostMetrics | null> {
    if (!this.client || !this.ready) return null;
    try {
      const entity = await this.client.getEntity(channelId);
      const result: any = await this.client.invoke(
        new Api.channels.GetMessages({
          channel: entity as any,
          id: [new Api.InputMessageID({ id: messageId })],
        }),
      );
      const msg: any = result?.messages?.[0];
      if (!msg || msg.className === 'MessageEmpty') return null;

      const reactions: Record<string, number> = {};
      let reactionsTotal = 0;
      const raw = msg.reactions?.results ?? [];
      for (const r of raw) {
        const key = r.reaction?.emoticon ?? r.reaction?.documentId ?? 'unknown';
        const count = typeof r.count === 'number' ? r.count : 0;
        reactions[String(key)] = count;
        reactionsTotal += count;
      }

      return {
        views:          typeof msg.views     === 'number' ? msg.views     : null,
        forwards:       typeof msg.forwards  === 'number' ? msg.forwards  : null,
        replies:        typeof msg.replies?.replies === 'number' ? msg.replies.replies : null,
        reactions:      Object.keys(reactions).length ? reactions : null,
        reactionsTotal,
      };
    } catch (err: any) {
      this.logger.warn(`getPostMetrics(${channelId}#${messageId}) failed: ${err.message}`);
      return null;
    }
  }
}
