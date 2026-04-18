import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { LogAnalyzerAgent } from '../common/logging/log-analyzer.agent';
import { ChannelConfigService } from '../config/channel-config.service';
import { ContentStrategyRunner } from '../common/content-strategy/content-strategy.runner';
import { ContentStrategyRegistry } from '../common/content-strategy/content-strategy.registry';

interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
}

interface TgMessage {
  message_id: number;
  from?: { id: number; username?: string };
  chat:  { id: number; type: string };
  text?: string;
}

interface TgCallbackQuery {
  id: string;
  from: { id: number };
  message?: TgMessage;
  data?: string;
}

interface TgUpdate {
  update_id:      number;
  message?:       TgMessage;
  callback_query?: TgCallbackQuery;
}

/**
 * Long-poll Telegram getUpdates on the same bot that publishes.
 * Owner-only commands: /analyze, /run (inline keyboard), /list, /help.
 * Silently disabled if TELEGRAM_BOT_TOKEN / TELEGRAM_OWNER_ID are missing.
 */
@Injectable()
export class AdminBotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AdminBotService.name);
  private botToken: string | null = null;
  private ownerId:  string | null = null;
  private offset   = 0;
  private stopped  = false;

  /** Short index → strategyId map to keep callback_data under 64 bytes */
  private strategyIndex: string[] = [];
  /** Short index → channelId map (same reason) */
  private channelIndex:  string[] = [];

  constructor(
    private readonly config:           ConfigService,
    private readonly analyzer:         LogAnalyzerAgent,
    private readonly channelConfig:    ChannelConfigService,
    private readonly strategyRunner:   ContentStrategyRunner,
    private readonly strategyRegistry: ContentStrategyRegistry,
  ) {}

  onModuleInit() {
    this.botToken = this.config.get<string>('TELEGRAM_BOT_TOKEN') ?? null;
    this.ownerId  = this.config.get<string>('TELEGRAM_OWNER_ID')  ?? null;

    if (!this.botToken || !this.ownerId) {
      this.logger.warn('AdminBotService disabled: TELEGRAM_BOT_TOKEN / TELEGRAM_OWNER_ID missing');
      return;
    }
    this.logger.log('AdminBotService started');
    this.poll().catch((err) => this.logger.error(`poll loop crashed: ${err.message}`));
  }

  onModuleDestroy() { this.stopped = true; }

  // ─── Polling ────────────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    while (!this.stopped) {
      try {
        const res = await axios.get(
          `https://api.telegram.org/bot${this.botToken}/getUpdates`,
          {
            params:  { offset: this.offset, timeout: 25, allowed_updates: ['message', 'callback_query'] },
            timeout: 30_000,
          },
        );
        const updates: TgUpdate[] = res.data?.result ?? [];
        for (const u of updates) {
          this.offset = u.update_id + 1;
          try {
            if (u.message)        await this.handleMessage(u.message);
            if (u.callback_query) await this.handleCallback(u.callback_query);
          } catch (err: any) {
            this.logger.warn(`update handler failed: ${err.message}`);
          }
        }
      } catch (err: any) {
        this.logger.debug(`getUpdates error: ${err.message}`);
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
  }

  private isOwner(userId: number | undefined): boolean {
    return !!this.ownerId && String(userId ?? '') === this.ownerId;
  }

  // ─── Messages ───────────────────────────────────────────────────────────────

  private async handleMessage(msg: TgMessage): Promise<void> {
    if (!msg.text || !this.isOwner(msg.from?.id)) return;

    const text = msg.text.trim();
    const [cmd, ...args] = text.split(/\s+/);

    switch (cmd) {
      case '/analyze': return this.cmdAnalyze(msg.chat.id, args);
      case '/run':     return this.cmdRun(msg.chat.id);
      case '/list':    return this.cmdList(msg.chat.id);
      case '/help':
      case '/start':   return this.cmdHelp(msg.chat.id);
    }
  }

  private async cmdAnalyze(chatId: number, args: string[]): Promise<void> {
    const hours = parseInt(args[0] ?? '24', 10) || 24;
    await this.sendText(chatId, `🔍 Аналізую логи за ${hours}г…`);
    try {
      const report = await this.analyzer.analyze({ hours });
      await this.sendText(chatId, report, 'HTML');
    } catch (err: any) {
      await this.sendText(chatId, `❌ Analyzer failed: ${err.message}`);
    }
  }

  private async cmdHelp(chatId: number): Promise<void> {
    await this.sendText(
      chatId,
      'Admin commands:\n' +
      '/run — запустити стратегію (з кнопками)\n' +
      '/analyze [hours=24] — AI-аналіз логів\n' +
      '/list — список усіх стратегій\n' +
      '/help — ця довідка',
    );
  }

  private async cmdList(chatId: number): Promise<void> {
    const bindings = this.channelConfig.resolveStrategyBindings();
    const lines = bindings
      .map((b) => `• <code>${b.id}</code> → ${b.channelId}`)
      .join('\n');
    await this.sendText(chatId, `<b>Стратегії (${bindings.length}):</b>\n${lines}`, 'HTML');
  }

  /** /run — show channel chooser */
  private async cmdRun(chatId: number): Promise<void> {
    const bindings = this.channelConfig.resolveStrategyBindings();
    const channels = [...new Set(bindings.map((b) => b.channelId))].sort();

    // Rebuild index so callback_data references are stable per run cycle
    this.channelIndex = channels;

    const rows: InlineKeyboardButton[][] = channels.map((ch, i) => [
      { text: ch, callback_data: `r:c:${i}` },
    ]);

    await this.sendWithKeyboard(chatId, '📡 <b>Виберіть канал:</b>', rows, 'HTML');
  }

  // ─── Callback queries ───────────────────────────────────────────────────────

  private async handleCallback(cb: TgCallbackQuery): Promise<void> {
    if (!this.isOwner(cb.from.id) || !cb.data || !cb.message) {
      await this.answerCb(cb.id);
      return;
    }

    const [ns, action, arg] = cb.data.split(':');
    if (ns !== 'r') { await this.answerCb(cb.id); return; }

    const chatId    = cb.message.chat.id;
    const messageId = cb.message.message_id;

    if (action === 'c') {
      const channelId = this.channelIndex[parseInt(arg, 10)];
      if (!channelId) { await this.answerCb(cb.id, 'Вибір застарів. /run ще раз.'); return; }
      await this.answerCb(cb.id);
      await this.showStrategiesForChannel(chatId, messageId, channelId);
      return;
    }

    if (action === 's') {
      const strategyId = this.strategyIndex[parseInt(arg, 10)];
      if (!strategyId) { await this.answerCb(cb.id, 'Вибір застарів. /run ще раз.'); return; }
      await this.answerCb(cb.id, '▶️ Запускаю…');
      await this.runStrategyById(chatId, messageId, strategyId);
      return;
    }

    if (action === 'back') {
      await this.answerCb(cb.id);
      const bindings = this.channelConfig.resolveStrategyBindings();
      const channels = [...new Set(bindings.map((b) => b.channelId))].sort();
      this.channelIndex = channels;
      const rows: InlineKeyboardButton[][] = channels.map((ch, i) => [
        { text: ch, callback_data: `r:c:${i}` },
      ]);
      await this.editMessage(chatId, messageId, '📡 <b>Виберіть канал:</b>', rows, 'HTML');
      return;
    }

    await this.answerCb(cb.id);
  }

  private async showStrategiesForChannel(
    chatId: number, messageId: number, channelId: string,
  ): Promise<void> {
    const forChannel = this.channelConfig
      .resolveStrategyBindings()
      .filter((b) => b.channelId === channelId);

    // Reset index on each drill-down to keep mapping fresh
    this.strategyIndex = forChannel.map((b) => b.id);

    if (!forChannel.length) {
      await this.editMessage(
        chatId, messageId,
        `Для <b>${channelId}</b> немає стратегій.`,
        [[{ text: '⬅️ Назад', callback_data: 'r:back:' }]],
        'HTML',
      );
      return;
    }

    const rows: InlineKeyboardButton[][] = forChannel.map((b, i) => [
      { text: `${b.type}  ·  ${b.id}`, callback_data: `r:s:${i}` },
    ]);
    rows.push([{ text: '⬅️ Назад', callback_data: 'r:back:' }]);

    await this.editMessage(
      chatId, messageId,
      `📡 <b>${channelId}</b>\nВиберіть стратегію:`,
      rows, 'HTML',
    );
  }

  private async runStrategyById(
    chatId: number, messageId: number, strategyId: string,
  ): Promise<void> {
    const binding = this.channelConfig
      .resolveStrategyBindings()
      .find((b) => b.id === strategyId);

    if (!binding) {
      await this.editMessage(chatId, messageId, `❌ Стратегію <code>${strategyId}</code> не знайдено`, [], 'HTML');
      return;
    }
    const strategy = this.strategyRegistry.get(binding.type);
    if (!strategy) {
      await this.editMessage(chatId, messageId, `❌ Type "${binding.type}" не зареєстровано`, [], 'HTML');
      return;
    }

    await this.editMessage(
      chatId, messageId,
      `▶️ Запускаю <code>${binding.id}</code>\n→ ${binding.channelId}`,
      [], 'HTML',
    );
    try {
      await this.strategyRunner.run(strategy, binding.channelId, binding.params, binding.id);
      await this.sendText(chatId, `✅ <code>${binding.id}</code> завершено`, 'HTML');
    } catch (err: any) {
      await this.sendText(chatId, `❌ <code>${binding.id}</code>: ${err.message}`, 'HTML');
    }
  }

  // ─── Telegram API helpers ───────────────────────────────────────────────────

  private async sendText(
    chatId: number, text: string, parseMode?: 'HTML' | 'Markdown',
  ): Promise<void> {
    for (const chunk of this.chunk(text)) {
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

  private async sendWithKeyboard(
    chatId: number, text: string, keyboard: InlineKeyboardButton[][], parseMode?: 'HTML',
  ): Promise<void> {
    await axios.post(
      `https://api.telegram.org/bot${this.botToken}/sendMessage`,
      {
        chat_id:      chatId,
        text,
        ...(parseMode ? { parse_mode: parseMode } : {}),
        reply_markup: { inline_keyboard: keyboard },
      },
      { timeout: 15_000 },
    );
  }

  private async editMessage(
    chatId: number, messageId: number, text: string,
    keyboard: InlineKeyboardButton[][], parseMode?: 'HTML',
  ): Promise<void> {
    try {
      await axios.post(
        `https://api.telegram.org/bot${this.botToken}/editMessageText`,
        {
          chat_id:      chatId,
          message_id:   messageId,
          text,
          ...(parseMode ? { parse_mode: parseMode } : {}),
          reply_markup: keyboard.length ? { inline_keyboard: keyboard } : undefined,
        },
        { timeout: 15_000 },
      );
    } catch (err: any) {
      // Edits fail if content is unchanged — ignore those
      if (!err.response?.data?.description?.includes('not modified')) {
        this.logger.debug(`editMessage failed: ${err.message}`);
      }
    }
  }

  private async answerCb(cbId: string, text?: string): Promise<void> {
    try {
      await axios.post(
        `https://api.telegram.org/bot${this.botToken}/answerCallbackQuery`,
        { callback_query_id: cbId, ...(text ? { text } : {}) },
        { timeout: 10_000 },
      );
    } catch { /* answer is best-effort */ }
  }

  private chunk(text: string): string[] {
    const out: string[] = [];
    let rem = text;
    while (rem.length > 4000) { out.push(rem.slice(0, 4000)); rem = rem.slice(4000); }
    out.push(rem);
    return out;
  }
}
