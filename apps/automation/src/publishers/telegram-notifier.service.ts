import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { ChannelConfigService } from '../config/channel-config.service';
import { ConfigCacheService } from '../config/config-cache.service';
import { SettingsService } from '../settings/settings.service';

/**
 * Sends admin notifications to the bot owner via Telegram.
 * Requires TELEGRAM_BOT_TOKEN (env) and an owner chat id. The owner id is read
 * live from SettingsService (DB override ?? env TELEGRAM_OWNER_ID), so it can be
 * set from the dashboard without a restart. Silently skips if either is missing.
 */
@Injectable()
export class TelegramNotifier implements OnModuleInit {
  private readonly logger = new Logger(TelegramNotifier.name);
  private botToken: string | null = null;

  constructor(
    private readonly config:        ConfigService,
    private readonly channelConfig: ChannelConfigService,
    private readonly cache:         ConfigCacheService,
    private readonly settings:      SettingsService,
  ) {}

  /** The owner chat id (DB override ?? env), or null when unset. */
  private ownerId(): string | null {
    return this.settings.telegramOwnerId() || null;
  }

  onModuleInit() {
    this.botToken = this.config.get<string>('TELEGRAM_BOT_TOKEN') ?? null;

    if (!this.botToken || !this.ownerId()) {
      this.logger.warn('TelegramNotifier disabled: TELEGRAM_BOT_TOKEN or TELEGRAM_OWNER_ID not set');
    }
  }

  /**
   * Notify about a successful publication.
   * @param channelId  e.g. "@ai0_global"
   * @param messageId  Telegram message_id returned after publish
   */
  async notifyPublished(channelId: string, messageId: string): Promise<void> {
    const postUrl = this.buildPostUrl(channelId, messageId);
    const text = `✅ ${this.resolveName(channelId)}\n${postUrl}`;
    await this.send(text);
  }

  /**
   * Notify about a failed / skipped publication.
   * @param channelId  e.g. "@ai0_global"
   * @param reason     SKIP_POST, error message, etc.
   * @param sourceUrl  original article/item URL for context
   */
  async notifyFailed(channelId: string, reason: string, sourceUrl: string): Promise<void> {
    const text = `❌ ${this.resolveName(channelId)} [${reason}]\n${sourceUrl}`;
    await this.send(text);
  }

  /**
   * Notify that the strategy ran but intentionally produced no post
   * (e.g. all candidates already posted, semantic dedup, empty feed).
   * @param channelId  e.g. "@ai_news_local"
   * @param reason     short human-readable reason
   */
  async notifySkipped(channelId: string, reason: string): Promise<void> {
    const text = `ℹ️ ${this.resolveName(channelId)} skipped: ${reason}`;
    await this.send(text);
  }

  /**
   * Operational alert to the owner (broken tokens, repeated strategy failures,
   * stuck runs, platform bans). Free-form text; no channel context required.
   */
  async notifyAlert(text: string): Promise<void> {
    await this.send(text);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Human-readable channel name for notifications. The strategy passes either a
   * channel_key (@username) or the internal UUID. Prefer the title (esp. for
   * private channels, which have no @username), then @username, channel_key,
   * and only fall back to the raw id if nothing else is known.
   */
  private resolveName(channelId: string): string {
    const ch = this.cache.getChannelByKey(channelId) ?? this.cache.getChannelById(channelId);
    if (!ch) return channelId;
    const title = ch.title?.trim();
    if (title) return title;
    if (ch.username) return `@${ch.username}`;
    return ch.channel_key ?? channelId;
  }

  private buildPostUrl(channelId: string, messageId: string): string {
    // Resolve the channel key to its actual chatId.
    // Public channels (chatId is `@username`) → https://t.me/<username>/<msgId>
    // Private channels (chatId is `-100…` numeric) → https://t.me/c/<id-without-100>/<msgId>
    let chatId: string;
    try {
      chatId = this.channelConfig.resolveChannel(channelId).chatId;
    } catch {
      chatId = channelId;
    }
    if (chatId.startsWith('@')) {
      return `https://t.me/${chatId.slice(1)}/${messageId}`;
    }
    const m = chatId.match(/^-100(\d+)$/);
    if (m) return `https://t.me/c/${m[1]}/${messageId}`;
    return `https://t.me/${chatId.replace(/^-/, '')}/${messageId}`;
  }

  private async send(text: string): Promise<void> {
    const ownerId = this.ownerId();
    if (!this.botToken || !ownerId) return;

    try {
      await axios.post(
        `https://api.telegram.org/bot${this.botToken}/sendMessage`,
        {
          chat_id:              ownerId,
          text,
          link_preview_options: { is_disabled: true },
        },
        { timeout: 10_000 },
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to send owner notification: ${msg}`);
    }
  }
}
