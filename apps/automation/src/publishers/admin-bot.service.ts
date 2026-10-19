import { Inject, Injectable, Logger, OnModuleInit, OnModuleDestroy, Optional } from '@nestjs/common';
import { emitChatMember } from './chat-member-bus';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import type { Pool } from 'pg';
import { LogAnalyzerAgent } from '../common/logging/log-analyzer.agent';
import { DB_POOL } from '../database/database.tokens';
import { ownerBotHandler, pollState } from './owner-bot-bus';

interface TgMessage {
  message_id: number;
  from?: { id: number; username?: string };
  chat:  { id: number; type: string };
  text?: string;
}

interface TgCallbackQuery {
  id: string;
  from: { id: number };
  chat_instance?: string;
  message?: TgMessage;
  data?: string;
}

interface TgUpdate {
  update_id:      number;
  message?:       TgMessage;
  callback_query?: TgCallbackQuery;
}

/** The app_settings row that keeps the getUpdates offset across restarts (spec 012 FR-001). */
export const OFFSET_KEY = 'owner_bot.offset';

/**
 * Spec 012 FR-001: a message or a button counts only in a private chat, from the owner (TELEGRAM_OWNER_ID) or an id
 * of TRACKING_ALLOWED_TG_USER_IDS.
 */
export function isOwnerUpdate(u: { fromId?: number | null; chatType?: string | null }, ownerId: string | null, allowed: string): boolean {
  if (u.chatType !== 'private' || u.fromId == null) return false;
  const id = String(u.fromId);
  if (ownerId && id === ownerId) return true;
  return allowed.split(',').map((x) => x.trim()).filter(Boolean).includes(id);
}

/**
 * Long-poll Telegram getUpdates on the same bot that publishes: the one consumer of this token.
 * Owner-only commands: /analyze, plus the owner bot's commands and buttons (spec 012), handed over through
 * owner-bot-bus. The legacy /run and /list (run a strategy binding by hand) were removed with the strategy runtime
 * (spec 023 phase B). The offset is stored in app_settings, so a restart neither replays nor drops updates.
 * Silently disabled if TELEGRAM_BOT_TOKEN / TELEGRAM_OWNER_ID are missing.
 */
@Injectable()
export class AdminBotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AdminBotService.name);
  private botToken: string | null = null;
  private ownerId:  string | null = null;
  private offset   = 0;
  private stopped  = false;

  constructor(
    private readonly config:           ConfigService,
    private readonly analyzer:         LogAnalyzerAgent,
    @Optional() @Inject(DB_POOL) private readonly pool?: Pool,
  ) {}

  onModuleInit() {
    this.botToken = this.config.get<string>('TELEGRAM_BOT_TOKEN') ?? null;
    this.ownerId  = this.config.get<string>('TELEGRAM_OWNER_ID')  ?? null;

    if (!this.botToken || !this.ownerId) {
      this.logger.warn('AdminBotService disabled: TELEGRAM_BOT_TOKEN / TELEGRAM_OWNER_ID missing');
      return;
    }
    this.logger.log('AdminBotService started');
    this.poll().catch((err) => this.logger.error(`poll loop crashed: ${err.message}`)).finally(() => { pollState.running = false; });
  }

  onModuleDestroy() { this.stopped = true; }

  private async loadOffset(): Promise<void> {
    if (!this.pool) return;
    try {
      const { rows } = await this.pool.query(`SELECT value FROM app_settings WHERE key = $1`, [OFFSET_KEY]);
      const n = Number(rows[0]?.value);
      if (Number.isSafeInteger(n) && n > 0) this.offset = n;
    } catch (err: any) {
      this.logger.warn(`offset not loaded: ${err.message}`);
    }
  }

  private async saveOffset(): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [OFFSET_KEY, String(this.offset)]);
    } catch (err: any) {
      this.logger.warn(`offset not saved: ${err.message}`);
    }
  }

  // ─── Polling ────────────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    await this.loadOffset();
    pollState.running = true;
    while (!this.stopped) {
      try {
        const res = await axios.get(
          `https://api.telegram.org/bot${this.botToken}/getUpdates`,
          {
            // chat_member: joins through tracked invite links (spec 022) — needs the bot to be a channel admin.
            params:  { offset: this.offset, timeout: 25, allowed_updates: JSON.stringify(['message', 'callback_query', 'chat_member']) },
            timeout: 30_000,
          },
        );
        const updates: TgUpdate[] = res.data?.result ?? [];
        pollState.lastPollAt = new Date();
        pollState.lastError = null;
        for (const u of updates) {
          this.offset = u.update_id + 1;
          pollState.lastUpdateAt = new Date();
          try {
            if (u.message)        await this.handleMessage(u.message);
            if (u.callback_query) await this.handleCallback(u.callback_query);
            if ((u as any).chat_member) await emitChatMember((u as any).chat_member);
          } catch (err: any) {
            this.logger.warn(`update handler failed: ${err.message}`);
          }
        }
        if (updates.length) await this.saveOffset();
      } catch (err: any) {
        pollState.lastError = String(err?.message ?? err).slice(0, 200);
        this.logger.debug(`getUpdates error: ${err.message}`);
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
  }

  private isOwner(u: { fromId?: number | null; chatType?: string | null }): boolean {
    return isOwnerUpdate(u, this.ownerId, this.config.get<string>('TRACKING_ALLOWED_TG_USER_IDS') ?? '');
  }

  // ─── Buttons ────────────────────────────────────────────────────────────────

  private async handleCallback(cb: TgCallbackQuery): Promise<void> {
    const h = ownerBotHandler();
    if (!cb.data?.startsWith('oc:') || !h) {
      // Old /run keyboards may still be clicked: answer so the button stops spinning.
      await this.answerCb(cb.id);
      return;
    }
    if (!this.isOwner({ fromId: cb.from?.id, chatType: cb.message?.chat.type ?? null })) {
      await this.answerCb(cb.id, 'Недоступно');
      return;
    }
    await h.callback({
      id: cb.id, fromId: cb.from.id, chatId: cb.message?.chat.id ?? null, chatType: cb.message?.chat.type ?? null,
      messageId: cb.message?.message_id ?? null, data: cb.data,
    });
  }

  // ─── Messages ───────────────────────────────────────────────────────────────

  private async handleMessage(msg: TgMessage): Promise<void> {
    if (!msg.text || !this.isOwner({ fromId: msg.from?.id, chatType: msg.chat.type })) return;

    const text = msg.text.trim();
    const [raw, ...args] = text.split(/\s+/);
    const cmd = raw.replace(/@\w+$/, '');

    switch (cmd) {
      case '/analyze': return this.cmdAnalyze(msg.chat.id, args);
      case '/run':
      case '/list':    return this.sendText(msg.chat.id, 'Стратегії видалено: контент пишуть агенти. Див. /app/agents.');
      case '/help':
      case '/start':   return this.cmdHelp(msg.chat.id);
    }
    const h = ownerBotHandler();
    if (h && cmd.startsWith('/')) await h.command({ chatId: msg.chat.id, chatType: msg.chat.type, fromId: msg.from!.id, text: [cmd, ...args].join(' ') });
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
    const owner = ownerBotHandler()?.help() ?? [];
    await this.sendText(
      chatId,
      'Команди:\n' +
      [...owner, '/analyze [hours=24] — AI-аналіз логів', '/help — ця довідка'].join('\n'),
    );
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
