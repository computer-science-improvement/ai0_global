import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { LogAnalyzerAgent } from '../common/logging/log-analyzer.agent';

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; username?: string };
    chat:  { id: number; type: string };
    text?: string;
  };
}

/**
 * Long-poll Telegram getUpdates on the same bot that publishes.
 * Listens for `/analyze` from the owner and replies with an AI-analyzed
 * log report. Silently disabled if TELEGRAM_BOT_TOKEN / TELEGRAM_OWNER_ID
 * are missing.
 */
@Injectable()
export class AdminBotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AdminBotService.name);
  private botToken: string | null = null;
  private ownerId:  string | null = null;
  private offset   = 0;
  private stopped  = false;

  constructor(
    private readonly config:   ConfigService,
    private readonly analyzer: LogAnalyzerAgent,
  ) {}

  onModuleInit() {
    this.botToken = this.config.get<string>('TELEGRAM_BOT_TOKEN') ?? null;
    this.ownerId  = this.config.get<string>('TELEGRAM_OWNER_ID')  ?? null;

    if (!this.botToken || !this.ownerId) {
      this.logger.warn('AdminBotService disabled: TELEGRAM_BOT_TOKEN / TELEGRAM_OWNER_ID missing');
      return;
    }
    this.logger.log('AdminBotService started — listening for /analyze');
    this.poll().catch((err) => this.logger.error(`poll loop crashed: ${err.message}`));
  }

  onModuleDestroy() {
    this.stopped = true;
  }

  private async poll(): Promise<void> {
    while (!this.stopped) {
      try {
        const res = await axios.get(
          `https://api.telegram.org/bot${this.botToken}/getUpdates`,
          {
            params:  { offset: this.offset, timeout: 25, allowed_updates: ['message'] },
            timeout: 30_000,
          },
        );
        const updates: TgUpdate[] = res.data?.result ?? [];
        for (const u of updates) {
          this.offset = u.update_id + 1;
          await this.handleUpdate(u).catch((err) =>
            this.logger.warn(`handleUpdate failed: ${err.message}`),
          );
        }
      } catch (err: any) {
        // transient network issue — back off briefly
        this.logger.debug(`getUpdates error: ${err.message}`);
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
  }

  private async handleUpdate(u: TgUpdate): Promise<void> {
    const msg = u.message;
    if (!msg?.text) return;
    const fromId = String(msg.from?.id ?? '');
    // Only the owner may run admin commands
    if (!this.ownerId || fromId !== this.ownerId) return;

    const text = msg.text.trim();
    const [cmd, ...args] = text.split(/\s+/);

    if (cmd === '/analyze') {
      const hours = parseInt(args[0] ?? '24', 10) || 24;
      await this.reply(msg.chat.id, `🔍 Аналізую логи за ${hours}г…`);
      try {
        const report = await this.analyzer.analyze({ hours });
        await this.reply(msg.chat.id, report, 'HTML');
      } catch (err: any) {
        await this.reply(msg.chat.id, `❌ Analyzer failed: ${err.message}`);
      }
      return;
    }

    if (cmd === '/help' || cmd === '/start') {
      await this.reply(
        msg.chat.id,
        'Admin commands:\n/analyze [hours=24] — AI-аналіз логів\n/help — ця довідка',
      );
    }
  }

  private async reply(chatId: number, text: string, parseMode?: 'HTML' | 'Markdown'): Promise<void> {
    // Telegram hard limit 4096 chars per message
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 4000) {
      chunks.push(remaining.slice(0, 4000));
      remaining = remaining.slice(4000);
    }
    chunks.push(remaining);

    for (const chunk of chunks) {
      try {
        await axios.post(
          `https://api.telegram.org/bot${this.botToken}/sendMessage`,
          {
            chat_id:              chatId,
            text:                 chunk,
            ...(parseMode ? { parse_mode: parseMode } : {}),
            link_preview_options: { is_disabled: true },
          },
          { timeout: 15_000 },
        );
      } catch (err: any) {
        // If HTML parse failed, retry without parse_mode
        if (parseMode && err.response?.data?.description?.includes('parse')) {
          await axios.post(
            `https://api.telegram.org/bot${this.botToken}/sendMessage`,
            { chat_id: chatId, text: chunk },
            { timeout: 15_000 },
          );
        } else {
          throw err;
        }
      }
    }
  }
}
