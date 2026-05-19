import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { LogAnalyzerAgent } from '../common/logging/log-analyzer.agent';
import { ChannelConfigService } from '../config/channel-config.service';
import { ContentStrategyRunner } from '../common/content-strategy/content-strategy.runner';
import { ContentStrategyRegistry } from '../common/content-strategy/content-strategy.registry';
import { StructuredLoggerService } from '../common/logging/structured-logger.service';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { PostingThrottleService } from './posting-throttle.service';

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
    private readonly structured:       StructuredLoggerService,
    private readonly throttle:         PostingThrottleService,
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
    const parsed = this.parseAnalyzeArgs(args);
    if ('error' in parsed) {
      await this.sendText(
        chatId,
        `❌ ${parsed.error}\n\n` +
        `Приклади:\n` +
        `• <code>/analyze</code> — за 24 години\n` +
        `• <code>/analyze 2</code> — за 2 години\n` +
        `• <code>/analyze 14:15</code> — з 14:15 дотепер\n` +
        `• <code>/analyze 14:15 15:30</code> — діапазон`,
        'HTML',
      );
      return;
    }
    await this.sendText(chatId, `🔍 Аналізую логи: ${parsed.label}…`);
    try {
      const report = await this.analyzer.analyze(parsed.opts);
      await this.sendText(chatId, report, 'HTML');
    } catch (err: any) {
      await this.sendText(chatId, `❌ Analyzer failed: ${err.message}`);
    }
  }

  /**
   * Parse /analyze args into analyzer opts:
   *   (no args)        → last 24h
   *   "N"              → last N hours
   *   "HH:MM"          → from today HH:MM until now (yesterday's if in future)
   *   "HH:MM HH:MM"    → explicit range, today (swapped if second is tomorrow-ish)
   */
  private parseAnalyzeArgs(args: string[]):
    | { opts: { hours?: number; sinceMs?: number; untilMs?: number }; label: string }
    | { error: string }
  {
    const TIME_RE = /^(\d{1,2}):(\d{2})$/;

    if (args.length === 0) {
      return { opts: { hours: 24 }, label: 'за 24 години' };
    }

    // Single numeric arg → hours
    if (args.length === 1 && /^\d+$/.test(args[0])) {
      const hours = parseInt(args[0], 10);
      if (hours < 1 || hours > 720) return { error: 'Години мають бути в діапазоні 1..720' };
      return { opts: { hours }, label: `за ${hours}г` };
    }

    // Time-based args. `rollbackIfFuture` controls per-arg "treat as yesterday"
    // behaviour — disabled for 2-arg form so a range like 18:00 23:56 at 23:36
    // doesn't get the second bound flipped to yesterday.
    const toEpoch = (hhmm: string, rollbackIfFuture: boolean): number | null => {
      const m = hhmm.match(TIME_RE);
      if (!m) return null;
      const h = parseInt(m[1], 10);
      const min = parseInt(m[2], 10);
      if (h > 23 || min > 59) return null;
      const d = new Date();
      d.setHours(h, min, 0, 0);
      if (rollbackIfFuture && d.getTime() > Date.now() + 60_000) {
        d.setDate(d.getDate() - 1);
      }
      return d.getTime();
    };

    if (args.length === 1) {
      const since = toEpoch(args[0], true);
      if (since == null) return { error: `Невірний час: "${args[0]}". Формат HH:MM.` };
      return { opts: { sinceMs: since }, label: `з ${args[0]} дотепер` };
    }

    if (args.length === 2) {
      let since = toEpoch(args[0], false);
      let until = toEpoch(args[1], false);
      if (since == null || until == null) {
        return { error: `Невірний час: "${args.join(' ')}". Формат HH:MM HH:MM.` };
      }
      // If the whole range is in the future → user meant the previous day.
      const now = Date.now();
      if (since > now + 60_000 && until > now + 60_000) {
        since -= 86_400_000;
        until -= 86_400_000;
      }
      // Range crosses midnight (e.g. 23:00 01:00) — advance `until` by 1 day.
      if (until <= since) until += 86_400_000;
      // Clamp upper bound to "now" so we never request future rows.
      if (until > now) until = now;
      if (until <= since) return { error: 'Кінцевий час має бути пізніше початкового.' };
      return { opts: { sinceMs: since, untilMs: until }, label: `${args[0]}–${args[1]}` };
    }

    return { error: 'Забагато аргументів.' };
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

    // Pre-check throttle so we can warn the user explicitly (strategyRunner
    // silently returns on cooldown which confused the admin).
    const cooldownMs = this.throttle.remainingMs(binding.channelId);
    const onCooldown = !this.throttle.canPublish(binding.channelId);

    const startedAt = Date.now();
    try {
      await this.strategyRunner.run(strategy, binding.channelId, binding.params, binding.id);
    } catch (err: any) {
      await this.sendText(chatId, `❌ <code>${binding.id}</code>: ${err.message}`, 'HTML');
      return;
    }

    // Inspect what actually happened during this run by reading the structured log
    const events = this.readLogEventsSince(startedAt - 500, binding.channelId);
    const summary = this.summarizeRun(events, { onCooldown, cooldownMs });

    await this.sendText(
      chatId,
      `<b>${summary.icon} <code>${binding.id}</code></b>\n` +
      `→ ${binding.channelId}\n` +
      summary.text,
      'HTML',
    );
  }

  /** Read log lines written since `sinceMs` that relate to a given channel/run. */
  private readLogEventsSince(sinceMs: number, channelId: string): Array<Record<string, any>> {
    const dir = this.structured.logsDirectory;
    let files: string[];
    try {
      files = readdirSync(dir)
        .filter((f) => f.startsWith('combined-') && f.endsWith('.log'))
        .map((f) => join(dir, f))
        .sort()
        .slice(-2); // today + yesterday is enough
    } catch { return []; }

    const out: Array<Record<string, any>> = [];
    for (const file of files) {
      let raw: string;
      try { raw = readFileSync(file, 'utf-8'); } catch { continue; }
      for (const line of raw.split('\n')) {
        if (!line) continue;
        let obj: Record<string, any>;
        try { obj = JSON.parse(line); } catch { continue; }
        const ts = obj.timestamp ? Date.parse(obj.timestamp) : 0;
        if (ts < sinceMs) continue;
        const ch = obj.channelId ?? obj.data?.channelId;
        if (ch && ch !== channelId) continue;
        out.push(obj);
      }
    }
    return out;
  }

  private summarizeRun(
    events: Array<Record<string, any>>,
    ctx: { onCooldown: boolean; cooldownMs: number },
  ): { icon: string; text: string } {
    const publications = events.filter((e) => e.category === 'publication');
    const success = publications.find((e) => e.data?.status === 'success');
    const failure = publications.find((e) => e.data?.status === 'failure' || e.data?.status === 'blocked');
    const errors  = events.filter((e) => e.category === 'error');
    const rss     = events.filter((e) => e.category === 'rss').length;
    const dbOps   = events.filter((e) => e.category === 'db');

    if (success) {
      const msgId = success.data?.messageId;
      const title = success.data?.title ?? '';
      const link = msgId ? `\n🔗 ${this.buildPostLink(success.channelId, msgId)}` : '';
      return { icon: '✅', text: `опубліковано: ${this.escape(title)}${link}` };
    }
    if (failure) {
      const err = failure.data?.error ?? 'unknown';
      return { icon: '❌', text: `публікація заблокована/впала: <code>${this.escape(String(err))}</code>` };
    }
    if (ctx.onCooldown) {
      const min = Math.ceil(ctx.cooldownMs / 60_000);
      return { icon: '⏸', text: `канал на cooldown (~${min}хв). Публікація пропущена.` };
    }
    if (errors.length) {
      const first = errors[0];
      return { icon: '⚠️', text: `помилка: <code>${this.escape(first.message ?? 'unknown')}</code>` };
    }
    // Nothing published, no cooldown, no errors — likely dedup/SKIP or empty feed
    const unposted = dbOps.find((e) => e.data?.op === 'filterUnposted');
    if (unposted) {
      const left = unposted.data?.rowCount ?? 0;
      if (left === 0) return { icon: 'ℹ️', text: `нічого нового (всі кандидати вже опубліковані).` };
    }
    if (rss === 0 && events.length === 0) {
      return { icon: 'ℹ️', text: 'виконано, але лог порожній — можливо стратегія без публікації цього разу.' };
    }
    return { icon: 'ℹ️', text: `завершено без публікації (RSS items: ${rss}).` };
  }

  private escape(text: string): string {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').slice(0, 200);
  }

  /**
   * Resolve a post URL for the given channel key + message id.
   * Public `@username` channels → `https://t.me/<username>/<msgId>`.
   * Private channels (numeric `-100…` chatId) → `https://t.me/c/<id-without-100>/<msgId>`.
   * Falls back to the raw channel key if resolution fails.
   */
  private buildPostLink(channelKey: string | undefined, msgId: number | string): string {
    if (!channelKey) return '';
    let chatId: string;
    try {
      chatId = this.channelConfig.resolveChannel(channelKey).chatId;
    } catch {
      chatId = channelKey;
    }
    if (chatId.startsWith('@')) {
      return `https://t.me/${chatId.slice(1)}/${msgId}`;
    }
    const m = chatId.match(/^-100(\d+)$/);
    if (m) return `https://t.me/c/${m[1]}/${msgId}`;
    return `https://t.me/${chatId.replace(/^-/, '')}/${msgId}`;
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
