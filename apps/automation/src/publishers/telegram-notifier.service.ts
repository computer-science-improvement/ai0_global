import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

/**
 * Sends admin notifications to the bot owner via Telegram.
 * Requires TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_ID env vars.
 * Silently skips if either is missing.
 */
@Injectable()
export class TelegramNotifier implements OnModuleInit {
  private readonly logger = new Logger(TelegramNotifier.name);
  private botToken: string | null = null;
  private ownerId:  string | null = null;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.botToken = this.config.get<string>('TELEGRAM_BOT_TOKEN') ?? null;
    this.ownerId  = this.config.get<string>('TELEGRAM_OWNER_ID') ?? null;

    if (!this.botToken || !this.ownerId) {
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
    const text = `✅ ${channelId}\n${postUrl}`;
    await this.send(text);
  }

  /**
   * Notify about a failed / skipped publication.
   * @param channelId  e.g. "@ai0_global"
   * @param reason     SKIP_POST, error message, etc.
   * @param sourceUrl  original article/item URL for context
   */
  async notifyFailed(channelId: string, reason: string, sourceUrl: string): Promise<void> {
    const text = `❌ ${channelId} [${reason}]\n${sourceUrl}`;
    await this.send(text);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private buildPostUrl(channelId: string, messageId: string): string {
    // "@ai0_global" → "https://t.me/ai0_global/517"
    const username = channelId.replace(/^@/, '');
    return `https://t.me/${username}/${messageId}`;
  }

  private async send(text: string): Promise<void> {
    if (!this.botToken || !this.ownerId) return;

    try {
      await axios.post(
        `https://api.telegram.org/bot${this.botToken}/sendMessage`,
        {
          chat_id:              this.ownerId,
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
